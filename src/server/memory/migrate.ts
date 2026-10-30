import { readFile } from "node:fs/promises";
import { buildIndexMap, MAP_BEGIN, MAP_END } from "./index-map.js";
import { describeScope, scopeOf, slugify } from "./scopes.js";
import { isCli, MemoryStore, rootFromArgs, todayIso } from "./store.js";

export const MAX_TOPIC_CHARS = 8000;

export interface SourceSection {
  readonly title: string;
  readonly body: string;
}

export interface PlannedTopic {
  readonly scope: string;
  readonly file: string;
  readonly title: string;
  readonly body: string;
}

export interface MigrationPlan {
  readonly sourceChars: number;
  readonly preamble: string;
  readonly inline: readonly SourceSection[];
  readonly topics: readonly PlannedTopic[];
  readonly movedChars: number;
}

function parseSections(raw: string): { preamble: string; sections: SourceSection[] } {
  const marks: Array<{ title: string; start: number }> = [];
  const re = /^## (.+)$/gm;
  for (let match = re.exec(raw); match !== null; match = re.exec(raw)) {
    marks.push({ title: (match[1] ?? "").trim(), start: match.index });
  }
  const preamble = marks.length > 0 ? raw.slice(0, marks[0]?.start ?? 0) : raw;
  const sections = marks.map((mark, index) => {
    const end = index + 1 < marks.length ? (marks[index + 1]?.start ?? raw.length) : raw.length;
    const body = raw.slice(mark.start, end).replace(/\s+$/, "");
    return { title: mark.title, body: `${body}\n` };
  });
  return { preamble, sections };
}

function splitOnParagraphs(body: string): string[] {
  const paragraphs = body.split(/\n\s*\n/);
  const parts: string[] = [];
  let buffer = "";
  for (const paragraph of paragraphs) {
    if (buffer.length > 0 && buffer.length + paragraph.length + 2 > MAX_TOPIC_CHARS) {
      parts.push(buffer);
      buffer = "";
    }
    buffer += `${paragraph}\n\n`;
    // A single paragraph can itself exceed the cap; it stays whole rather than
    // losing a character to an arbitrary cut.
    if (buffer.length > MAX_TOPIC_CHARS) {
      parts.push(buffer);
      buffer = "";
    }
  }
  if (buffer.trim().length > 0) parts.push(buffer);
  return parts;
}

function carve(section: SourceSection): Array<{ title: string; body: string }> {
  if (section.body.length <= MAX_TOPIC_CHARS) return [section];
  let parts = section.body.split(/^(?=#{1,3} )/m).filter((part) => part.trim().length > 0);
  if (parts.length <= 1) parts = splitOnParagraphs(section.body);
  const carved: Array<{ title: string; body: string }> = [];
  for (const part of parts) {
    const heading = (part.match(/^#{1,3} (.+)$/m) ?? [])[1]?.trim();
    const title =
      heading !== undefined && heading.length > 0 && heading !== section.title
        ? `${section.title} — ${heading}`
        : section.title;
    if (part.length > MAX_TOPIC_CHARS) {
      for (const paragraph of splitOnParagraphs(part)) {
        carved.push({ title, body: paragraph });
      }
    } else {
      carved.push({ title, body: part });
    }
  }
  return carved;
}

export function planMigration(raw: string): MigrationPlan {
  const { preamble, sections } = parseSections(raw);
  const inline = sections.filter((section) => /^Standing rules\b/i.test(section.title));
  const buckets = new Map<string, Array<{ title: string; body: string }>>();
  for (const section of sections) {
    if (inline.includes(section)) continue;
    const scope = scopeOf(section.title);
    const list = buckets.get(scope) ?? [];
    list.push(...carve(section));
    buckets.set(scope, list);
  }

  const topics: PlannedTopic[] = [];
  const used = new Set<string>();
  for (const [scope, list] of [...buckets].sort(([a], [b]) => a.localeCompare(b))) {
    for (const item of list) {
      const base = slugify(item.title) || "topic";
      let file = `${base}.md`;
      let counter = 2;
      while (used.has(`${scope}/${file}`)) {
        file = `${base}-${counter}.md`;
        counter += 1;
      }
      used.add(`${scope}/${file}`);
      topics.push({ scope, file, title: item.title, body: item.body });
    }
  }
  return {
    sourceChars: raw.length,
    preamble,
    inline,
    topics,
    movedChars: topics.reduce((sum, topic) => sum + topic.body.length, 0),
  };
}

function indexOnlyMemory(plan: MigrationPlan): string {
  const preamble = plan.preamble.trimEnd();
  const head =
    preamble.length > 0
      ? preamble
      : "# MEMORY\n\nThis file is an index, not a store. Topic bodies live under `topics/`.";
  const note =
    "How this file works: the standing rules and the generated map below are injected each turn. Topic bodies live in `topics/<scope>/<slug>.md`; search them with memory_find and read one with memory_read. Never paste a body into this file.";
  const rules =
    plan.inline.length > 0
      ? plan.inline.map((section) => section.body.trimEnd()).join("\n\n")
      : "## Standing rules\n\n(none yet)";
  return `${head}\n\n${note}\n\n${rules}\n\n${MAP_BEGIN}\n## Memory map\n\n(no topics yet)\n${MAP_END}\n`;
}

export interface MigrationResult {
  readonly applied: boolean;
  readonly plan: MigrationPlan;
  readonly scopes: ReadonlyArray<{ scope: string; count: number }>;
}

export async function migrateMemory(
  store: MemoryStore,
  options: { apply?: boolean } = {},
): Promise<MigrationResult> {
  const raw = await readFile(store.memoryFile, "utf8");
  const plan = planMigration(raw);
  if (options.apply !== true) {
    const counts = new Map<string, number>();
    for (const topic of plan.topics) {
      counts.set(topic.scope, (counts.get(topic.scope) ?? 0) + 1);
    }
    return {
      applied: false,
      plan,
      scopes: [...counts].map(([scope, count]) => ({ scope, count })),
    };
  }

  await store.ensure();
  for (const topic of plan.topics) {
    await store.writeTopic(`topics/${topic.scope}/${topic.file}`, topic.body, {
      scope: topic.scope,
      title: topic.title,
      create: true,
    });
  }
  await store.atomicWrite(store.memoryFile, indexOnlyMemory(plan));
  await buildIndexMap(store);
  const counts = new Map<string, number>();
  for (const topic of plan.topics) {
    counts.set(topic.scope, (counts.get(topic.scope) ?? 0) + 1);
  }
  return {
    applied: true,
    plan,
    scopes: [...counts].map(([scope, count]) => ({ scope, count })),
  };
}

export function describeMigration(plan: MigrationPlan): string {
  const lines = [
    `source ${plan.sourceChars} chars, ${plan.topics.length} topic file(s)`,
    `inline: ${plan.inline.length} section(s), ${plan.inline.reduce(
      (sum, section) => sum + section.body.length,
      0,
    )} chars`,
  ];
  const byScope = new Map<string, PlannedTopic[]>();
  for (const topic of plan.topics) {
    const list = byScope.get(topic.scope) ?? [];
    list.push(topic);
    byScope.set(topic.scope, list);
  }
  for (const [scope, topics] of [...byScope].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(
      `${scope.padEnd(9)} ${String(topics.length).padStart(2)} topics ${String(
        topics.reduce((sum, topic) => sum + topic.body.length, 0),
      ).padStart(7)} chars (${describeScope(scope)})`,
    );
    for (const topic of topics) {
      lines.push(
        `  ${String(topic.body.length).padStart(7)}  ${topic.file.padEnd(44)} ${topic.title}`,
      );
    }
  }
  return lines.join("\n");
}

if (isCli(import.meta.url)) {
  const apply = process.argv.includes("--apply");
  const store = new MemoryStore(rootFromArgs(process.argv));
  const result = await migrateMemory(store, { apply });
  console.log(describeMigration(result.plan));
  if (!apply) {
    console.log("\n(dry run — pass --apply)");
  } else {
    console.log(
      `\nwrote ${result.plan.topics.length} topic files under ${store.topicsDir} (${todayIso()})`,
    );
  }
}
