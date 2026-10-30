import { mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { buildIndexMap } from "./index-map.js";
import { isCli, MemoryStore, rootFromArgs, type TopicRecord, todayIso } from "./store.js";

export const ATTACH_THRESHOLD = 1.1;
export const DUPLICATE_THRESHOLD = 0.7;
export const OVERSIZED_CHARS = 6000;

const STOP_WORDS = new Set(
  "the a an and or of to in on for with that this it is are was were be been by as at from not no do does did but if then than so we you i my your our their its there these those".split(
    " ",
  ),
);

export function dreamTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[`*_#>[\](){}"'’]/g, " ")
    .split(/[^a-z0-9./:_-]+/)
    .map((word) => word.replace(/^[-./:]+|[-./:]+$/g, ""))
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

export interface JournalBlock {
  readonly file: string;
  readonly heading: string;
  readonly text: string;
  readonly lines: string[];
  readonly tokens: ReadonlyMap<string, number>;
}

export interface DuplicatePair {
  readonly rel: string;
  readonly score: number;
  readonly left: JournalBlock;
  readonly right: JournalBlock;
}

export interface Attachment {
  readonly topic: TopicRecord;
  readonly blocks: JournalBlock[];
}

export interface DreamReport {
  readonly today: string;
  readonly pendingFiles: string[];
  readonly blocks: JournalBlock[];
  readonly attached: Map<string, Attachment>;
  readonly unattached: JournalBlock[];
  readonly duplicates: DuplicatePair[];
  readonly oversized: TopicRecord[];
  readonly drift: TopicRecord[];
  readonly openItems: string[];
  readonly topics: TopicRecord[];
}

interface ScoredTopic {
  readonly topic: TopicRecord;
  readonly tokens: ReadonlyMap<string, number>;
}

function frequencies(text: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const word of dreamTokens(text)) map.set(word, (map.get(word) ?? 0) + 1);
  return map;
}

function parseBlocks(file: string, text: string): JournalBlock[] {
  const blocks: JournalBlock[] = [];
  for (const part of text.split(/^(?=<!-- )/m)) {
    const body = part.replace(/^<!--.*?-->\s*/, "").trim();
    if (body.length === 0) continue;
    const heading =
      (body.match(/^#{1,4} (.+)$/m) ?? [])[1] ?? body.split(/\r?\n/)[0]?.slice(0, 70) ?? file;
    // Keep every non-empty line. A short entry is still a whole block and must
    // reach classification and the emitted merge item, never be dropped.
    const lines = body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    blocks.push({
      file,
      heading,
      text: body,
      lines,
      tokens: frequencies(`${heading}\n${body}`),
    });
  }
  return blocks;
}

function jaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  let intersection = 0;
  for (const item of left) if (right.has(item)) intersection += 1;
  return intersection / (left.size + right.size - intersection || 1);
}

function shingles(block: JournalBlock): Set<string> {
  const words = dreamTokens(block.text);
  const set = new Set<string>();
  for (let index = 0; index + 4 <= words.length; index += 1) {
    set.add(words.slice(index, index + 4).join(" "));
  }
  if (set.size === 0) set.add(words.join(" ") || block.heading);
  return set;
}

export async function prepareDream(store: MemoryStore): Promise<DreamReport> {
  const today = todayIso();
  const state = await store.readDreamState();
  const consumed = new Set(state.consumed);
  const dates = await store.dailyDates();
  const pendingFiles = dates.map((date) => `${date}.md`).filter((file) => !consumed.has(file));
  const topics = await store.listTopics();
  const scored: ScoredTopic[] = topics.map((topic) => ({
    topic,
    tokens: frequencies(`${topic.title}\n${topic.body}`),
  }));
  const total = Math.max(1, scored.length);
  const documentFrequency = new Map<string, number>();
  for (const document of scored) {
    for (const word of document.tokens.keys()) {
      documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
    }
  }
  const idf = (word: string): number =>
    Math.log(1 + total / (1 + (documentFrequency.get(word) ?? 0)));
  const scoreTopic = (block: JournalBlock, topic: ScoredTopic): number => {
    const words = [...new Set(block.tokens.keys())];
    let score = 0;
    for (const word of words) {
      const count = topic.tokens.get(word) ?? 0;
      if (count > 0) score += (1 + Math.log(count)) * idf(word);
      else if (topic.topic.title.toLowerCase().includes(word)) score += 1.5 * idf(word);
    }
    return score / Math.sqrt(words.length || 1);
  };

  const blocks: JournalBlock[] = [];
  for (const file of pendingFiles) {
    blocks.push(...parseBlocks(file, await readFile(join(store.dailyDir, file), "utf8")));
  }

  const attached = new Map<string, Attachment>();
  const unattached: JournalBlock[] = [];
  for (const block of blocks) {
    let best: { topic: TopicRecord; score: number } | undefined;
    for (const topic of scored) {
      const score = scoreTopic(block, topic);
      if (best === undefined || score > best.score) best = { topic: topic.topic, score };
    }
    if (best !== undefined && best.score >= ATTACH_THRESHOLD) {
      const current = attached.get(best.topic.rel);
      if (current === undefined) {
        attached.set(best.topic.rel, { topic: best.topic, blocks: [block] });
      } else {
        current.blocks.push(block);
      }
    } else {
      unattached.push(block);
    }
  }

  const duplicates: DuplicatePair[] = [];
  for (const [rel, group] of attached) {
    const prints = group.blocks.map((block) => shingles(block));
    for (let left = 0; left < group.blocks.length; left += 1) {
      for (let right = left + 1; right < group.blocks.length; right += 1) {
        const score = jaccard(prints[left] as Set<string>, prints[right] as Set<string>);
        if (score >= DUPLICATE_THRESHOLD) {
          duplicates.push({
            rel,
            score,
            left: group.blocks[left] as JournalBlock,
            right: group.blocks[right] as JournalBlock,
          });
        }
      }
    }
  }
  duplicates.sort((left, right) => right.score - left.score);

  const drift: TopicRecord[] = [];
  for (const topic of topics) {
    const index = await store.scopeIndex(topic.scope);
    if (!index.some((line) => line.includes(`](${topic.file})`))) drift.push(topic);
  }

  return {
    today,
    pendingFiles,
    blocks,
    attached,
    unattached,
    duplicates,
    oversized: topics.filter((topic) => topic.body.length > OVERSIZED_CHARS),
    drift,
    openItems: await store.openScratchpadItems(),
    topics,
  };
}

const MERGE_RULES = [
  "Rewrite the body so it states the current truth once; delete what it already says.",
  "Keep decisions, their rationale, file paths, and exact values (versions, ids, thresholds).",
  "Drop greetings, tool noise, message counts, next-steps, and session metadata.",
  "Absolute dates only. Resolve contradictions — the newer statement wins, note the date.",
  "Preserve architecture, preferences, and problem → solution pairs.",
  "Do not grow past ~6000 chars: split on headings into a new topic + INDEX line instead.",
  "Output `##` sections. Write back through the one topic write path (memory_write).",
];

export interface DreamOptions {
  readonly emitDir?: string;
  readonly commit?: boolean;
}

export interface DreamOutcome {
  readonly report: DreamReport;
  readonly emitted: string[];
  readonly archived: string[];
  readonly stateFile: string;
}

export async function dreamMemory(
  store: MemoryStore,
  options: DreamOptions = {},
): Promise<DreamOutcome> {
  const report = await prepareDream(store);
  const emitted: string[] = [];
  if (options.emitDir !== undefined) {
    await mkdir(options.emitDir, { recursive: true });
    for (const [rel, group] of report.attached) {
      const body = group.topic.body.trim();
      const item = [
        `# Merge into topics/${rel}`,
        "",
        `Current body: ${body.length} chars. Blocks to fold: ${group.blocks.length}.`,
        "",
        "## Rules",
        "",
        ...MERGE_RULES.map((rule, index) => `${index + 1}. ${rule}`),
        "",
        "## Current body",
        "",
        body,
        "",
        `## Blocks to fold (${group.blocks.length})`,
        "",
      ];
      for (const block of group.blocks) {
        // Emit the full block text (heading and body). Sampled lines would lose
        // short lines and make the merge item incomplete.
        item.push(`<!-- from ${block.file} -->`, block.text, "");
      }
      const file = join(options.emitDir, `${rel.replace(/\//g, "--")}`);
      await store.atomicWrite(file, `${item.join("\n")}\n`);
      emitted.push(file);
    }
  }

  const archived: string[] = [];
  if (options.commit === true) {
    const month = report.today.slice(0, 7);
    const archiveDir = join(store.archiveDir, month);
    await mkdir(archiveDir, { recursive: true });
    const todayFile = `${report.today}.md`;
    for (const file of report.pendingFiles) {
      if (file === todayFile) continue;
      await rename(join(store.dailyDir, file), join(archiveDir, file));
      archived.push(file);
    }
    const previous = await store.readDreamState();
    const consumed = [...new Set([...previous.consumed, ...archived])].sort();
    await store.writeDreamState({
      version: 1,
      lastRunAt: new Date().toISOString(),
      lastRunDate: report.today,
      consumed,
      lastBlocks: report.blocks.length,
    });
    await buildIndexMap(store);
  }

  return { report, emitted, archived, stateFile: store.stateFile };
}

export function summarizeDream(report: DreamReport): string {
  const attachedBlocks = [...report.attached.values()].reduce(
    (sum, group) => sum + group.blocks.length,
    0,
  );
  const lines = [
    `daily logs pending: ${report.pendingFiles.length}`,
    `journalled blocks: ${report.blocks.length}`,
    `attached: ${attachedBlocks} across ${report.attached.size} target(s)`,
    `new-topic candidates: ${report.unattached.length}`,
    `near-duplicates: ${report.duplicates.length}`,
    `oversized topics (>${OVERSIZED_CHARS}): ${report.oversized.length}`,
    `index drift: ${report.drift.length}`,
    `open scratchpad items: ${report.openItems.length}`,
  ];
  if (report.attached.size > 0) {
    lines.push("", "targets:");
    for (const [rel, group] of [...report.attached].sort(
      (left, right) => right[1].blocks.length - left[1].blocks.length,
    )) {
      lines.push(`  topics/${rel} — ${group.blocks.length} block(s)`);
    }
  }
  if (report.duplicates.length > 0) {
    lines.push("", "near-duplicates:");
    for (const duplicate of report.duplicates.slice(0, 10)) {
      lines.push(
        `  ${duplicate.score.toFixed(2)} topics/${duplicate.rel}: "${duplicate.left.heading.slice(
          0,
          70,
        )}" ↔ "${duplicate.right.heading.slice(0, 70)}"`,
      );
    }
  }
  if (report.unattached.length > 0) {
    lines.push("", "new-topic candidates:");
    for (const block of report.unattached.slice(0, 25)) {
      lines.push(`  - ${block.heading.slice(0, 100)} (${block.file})`);
    }
  }
  return lines.join("\n");
}

if (isCli(import.meta.url)) {
  const args = process.argv.slice(2);
  const emitIndex = args.indexOf("--emit");
  const emitDir = emitIndex >= 0 ? args[emitIndex + 1] : undefined;
  const store = new MemoryStore(rootFromArgs(args));
  const outcome = await dreamMemory(store, {
    ...(emitDir === undefined ? {} : { emitDir }),
    commit: args.includes("--commit"),
  });
  console.log(summarizeDream(outcome.report));
  if (emitDir !== undefined) {
    console.log(`\n${outcome.emitted.length} work item(s) → ${emitDir}`);
  }
  if (outcome.archived.length > 0) {
    console.log(
      `\narchived ${outcome.archived.length} daily log(s): ${outcome.archived.join(", ")}`,
    );
  }
  if (args.includes("--commit")) console.log(`state written to ${outcome.stateFile}`);
}
