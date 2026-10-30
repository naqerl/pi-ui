import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { describeScope, scopeOf, slugify } from "./scopes.js";

export interface FrontMatter {
  readonly data: Map<string, string>;
  readonly body: string;
}

export interface TopicRecord {
  readonly scope: string;
  readonly file: string;
  readonly rel: string;
  readonly title: string;
  readonly updated: string;
  readonly body: string;
}

export interface DreamState {
  version: number;
  lastRunAt: string | null;
  lastRunDate: string | null;
  consumed: string[];
  lastBlocks: number;
}

export interface UsageEntry {
  count: number;
  lastAt: string;
  lastQuery: string;
}

export interface UsageState {
  version: number;
  updatedAt?: string;
  hits: Record<string, UsageEntry>;
}

/** One writer at a time: read-modify-write of a topic or the index cannot interleave. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

let tempCounter = 0;

export function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function parseFrontMatter(raw: string): FrontMatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (match === null) return { data: new Map(), body: raw };
  const data = new Map<string, string>();
  for (const line of (match[1] ?? "").split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    data.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  return { data, body: raw.slice(match[0].length) };
}

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      // keep the raw value; an old file may not have valid JSON quoting
    }
  }
  return value;
}

export function frontMatterValue(data: Map<string, string>, key: string): string | undefined {
  const value = data.get(key);
  return value === undefined ? undefined : unquote(value);
}

export function serializeFrontMatter(data: Map<string, string>, body: string): string {
  const lines = [...data].map(([key, value]) => `${key}: ${value}`);
  return `---\n${lines.join("\n")}\n---\n\n${body.replace(/^\s*\n/, "").trimEnd()}\n`;
}

export function firstHeading(body: string): string | undefined {
  const heading = body
    .split(/\r?\n/)
    .find((line) => /^#{1,3} /.test(line))
    ?.replace(/^#{1,3} /, "")
    .trim();
  return heading !== undefined && heading.length > 0 ? heading : undefined;
}

function descriptionOf(body: string): string {
  const line =
    body
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => item.length > 0 && !item.startsWith("#") && !item.startsWith("<!--")) ?? "";
  return line
    .replace(/^[-*]\s*/, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 90);
}

function jsonString(value: string): string {
  return JSON.stringify(value);
}

/** A memory tree rooted at `<cwd>/data/memory/`. All writes go through one serial queue. */
export class MemoryStore {
  readonly root: string;
  readonly memoryFile: string;
  readonly scratchpadFile: string;
  readonly topicsDir: string;
  readonly dailyDir: string;
  readonly archiveDir: string;
  readonly usageFile: string;
  readonly stateFile: string;
  private readonly queue = new SerialQueue();
  private longTermRevision = 0;

  constructor(root: string) {
    this.root = resolve(root);
    this.memoryFile = join(this.root, "MEMORY.md");
    this.scratchpadFile = join(this.root, "SCRATCHPAD.md");
    this.topicsDir = join(this.root, "topics");
    this.dailyDir = join(this.root, "daily");
    this.archiveDir = join(this.root, "archive");
    this.usageFile = join(this.root, ".usage.json");
    this.stateFile = join(this.root, ".dream-state.json");
  }

  /** Run one read-modify-write against the tree without interleaving another writer. */
  exclusive<T>(task: () => Promise<T>): Promise<T> {
    return this.queue.run(task);
  }

  /** Monotonic counter bumped only by a long-term topic write. */
  get checkpoint(): number {
    return this.longTermRevision;
  }

  async ensure(): Promise<void> {
    await Promise.all([
      mkdir(this.root, { recursive: true }),
      mkdir(this.topicsDir, { recursive: true }),
      mkdir(this.dailyDir, { recursive: true }),
    ]);
  }

  resolvePath(rel: string): string {
    const path = isAbsolute(rel) ? resolve(rel) : resolve(this.root, rel);
    const within = relative(this.root, path);
    if (within.startsWith("..") || (isAbsolute(within) && !path.startsWith(this.root))) {
      throw new Error(`path escapes the memory directory: ${rel}`);
    }
    return path;
  }

  topicRel(rel: string): string {
    const trimmed = rel.replace(/^\/+/, "");
    if (trimmed.startsWith("topics/")) return trimmed;
    if (trimmed.split(sep).length === 2 && trimmed.endsWith(".md")) return `topics/${trimmed}`;
    return trimmed;
  }

  async readMemory(): Promise<string> {
    return readFile(this.memoryFile, "utf8");
  }

  async readScratchpad(): Promise<string> {
    try {
      return await readFile(this.scratchpadFile, "utf8");
    } catch (error) {
      if (isMissing(error)) return "";
      throw error;
    }
  }

  async readDaily(date = todayIso()): Promise<string> {
    try {
      return await readFile(join(this.dailyDir, `${date}.md`), "utf8");
    } catch (error) {
      if (isMissing(error)) return "";
      throw error;
    }
  }

  async dailyDates(): Promise<string[]> {
    try {
      const names = await readdir(this.dailyDir);
      return names
        .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
        .map((name) => name.slice(0, -3))
        .sort();
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  async openScratchpadItems(): Promise<string[]> {
    const raw = await this.readScratchpad();
    return raw
      .split(/\r?\n/)
      .filter((line) => /^\s*-\s*\[ \]/.test(line))
      .map((line) => line.replace(/^\s*-\s*\[ \]\s*/, "").trim())
      .filter((line) => line.length > 0);
  }

  async atomicWrite(file: string, contents: string): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${tempCounter++}`;
    try {
      await writeFile(tmp, contents);
      await rename(tmp, file);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async readTopic(rel: string): Promise<TopicRecord> {
    const normalized = this.topicRel(rel);
    const file = this.resolvePath(normalized);
    const raw = await readFile(file, "utf8");
    const parsed = parseFrontMatter(raw);
    const relativePath = normalized.replace(/^topics\//, "");
    const scope = relativePath.split("/")[0] ?? frontMatterValue(parsed.data, "scope") ?? "misc";
    return {
      scope,
      file: basename(file),
      rel: relativePath,
      title:
        frontMatterValue(parsed.data, "topic") ??
        firstHeading(parsed.body) ??
        basename(file, ".md"),
      updated: frontMatterValue(parsed.data, "updated") ?? "",
      body: parsed.body,
    };
  }

  async listTopics(): Promise<TopicRecord[]> {
    const topics: TopicRecord[] = [];
    let scopes: string[];
    try {
      scopes = await readdir(this.topicsDir);
    } catch (error) {
      if (isMissing(error)) return topics;
      throw error;
    }
    for (const scope of scopes.sort()) {
      const dir = join(this.topicsDir, scope);
      let names: string[];
      try {
        if (!(await stat(dir)).isDirectory()) continue;
        names = await readdir(dir);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      for (const name of names.sort()) {
        if (!name.endsWith(".md") || name === "INDEX.md") continue;
        topics.push(await this.readTopic(`${scope}/${name}`));
      }
    }
    return topics;
  }

  /**
   * The only topic write path: keep front matter, restamp `updated`, take the
   * title from the body's first heading, sync the scope index, then temp+rename.
   */
  async writeTopic(
    rel: string,
    body: string,
    options: { scope?: string; title?: string; create?: boolean } = {},
  ): Promise<TopicRecord> {
    return this.queue.run(() => this.writeTopicUnlocked(rel, body, options));
  }

  private async writeTopicUnlocked(
    rel: string,
    body: string,
    options: { scope?: string; title?: string; create?: boolean },
  ): Promise<TopicRecord> {
    const normalized = this.topicRel(rel);
    const parts = normalized.split("/");
    if (!normalized.startsWith("topics/") || parts.length !== 3 || !normalized.endsWith(".md")) {
      throw new Error(`topic path must be topics/<scope>/<slug>.md: ${rel}`);
    }
    const pathScope = parts[1] as string;
    if (options.scope !== undefined && options.scope !== pathScope) {
      throw new Error(
        `scope ${options.scope} does not match the topic path scope ${pathScope}: ${rel}`,
      );
    }
    const file = this.resolvePath(normalized);
    const exists = await fileExists(file);
    if (!exists && options.create === false) {
      throw new Error(`unknown topic: ${normalized}`);
    }
    let data = new Map<string, string>();
    let previousTitle: string | undefined;
    if (exists) {
      const parsed = parseFrontMatter(await readFile(file, "utf8"));
      data = parsed.data;
      previousTitle = frontMatterValue(parsed.data, "topic");
    }
    const cleanBody = body.trim();
    if (cleanBody.length === 0) throw new Error("refusing to write an empty topic");
    const heading = firstHeading(cleanBody);
    const title = options.title ?? heading ?? previousTitle ?? basename(file, ".md");
    data.set("topic", jsonString(title));
    data.set("scope", pathScope);
    data.set("updated", todayIso());
    await this.atomicWrite(file, serializeFrontMatter(data, cleanBody));
    await this.syncScopeIndex(pathScope, basename(file), title, cleanBody);
    this.longTermRevision += 1;
    return {
      scope: pathScope,
      file: basename(file),
      rel: normalized.replace(/^topics\//, ""),
      title,
      updated: todayIso(),
      body: cleanBody,
    };
  }

  async createTopic(input: {
    title: string;
    body: string;
    scope?: string;
    slug?: string;
  }): Promise<TopicRecord> {
    return this.queue.run(async () => {
      const scope = input.scope ?? scopeOf(input.title);
      const stem = slugify(input.slug ?? input.title) || "topic";
      let file = `${stem}.md`;
      let counter = 2;
      while (await fileExists(join(this.topicsDir, scope, file))) {
        file = `${stem}-${counter}.md`;
        counter += 1;
      }
      return this.writeTopicUnlocked(`topics/${scope}/${file}`, input.body, {
        scope,
        title: input.title,
        create: true,
      });
    });
  }

  async appendDaily(text: string, sessionId = "manual", at = new Date()): Promise<void> {
    await this.queue.run(async () => {
      await mkdir(this.dailyDir, { recursive: true });
      const file = join(this.dailyDir, `${todayIso(at)}.md`);
      const current = (await fileExists(file)) ? await readFile(file, "utf8") : "";
      const stamp = `<!-- ${at.toISOString()} [${sessionId}] -->`;
      const block = `${stamp}\n${text.trim()}\n`;
      const next = `${current}${current.length > 0 && !current.endsWith("\n") ? "\n" : ""}${
        current.length > 0 ? "\n" : ""
      }${block}`;
      await this.atomicWrite(file, next);
      // A daily write is deliberately not a snapshot checkpoint.
    });
  }

  async appendScratchpad(item: string): Promise<void> {
    await this.queue.run(async () => {
      const current = await this.readScratchpad();
      const line = `- [ ] ${item.trim()}\n`;
      const next = `${current}${current.length > 0 && !current.endsWith("\n") ? "\n" : ""}${line}`;
      await this.atomicWrite(this.scratchpadFile, next);
    });
  }

  async readUsage(): Promise<UsageState> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.usageFile, "utf8"));
      if (isRecord(parsed) && isRecord(parsed.hits)) {
        return {
          version: typeof parsed.version === "number" ? parsed.version : 1,
          ...(typeof parsed.updatedAt === "string" ? { updatedAt: parsed.updatedAt } : {}),
          hits: parsed.hits as Record<string, UsageEntry>,
        };
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return { version: 1, hits: {} };
  }

  async recordUsage(hits: readonly { rel: string; query: string }[]): Promise<void> {
    if (hits.length === 0) return;
    await this.queue.run(async () => {
      const usage = await this.readUsage();
      const at = new Date().toISOString();
      usage.version = 1;
      usage.updatedAt = at;
      for (const hit of hits.slice(0, 3)) {
        const current = usage.hits[hit.rel];
        usage.hits[hit.rel] = {
          count: (current?.count ?? 0) + 1,
          lastAt: at,
          lastQuery: hit.query.slice(0, 120),
        };
      }
      await this.atomicWrite(this.usageFile, `${JSON.stringify(usage, null, 2)}\n`);
    });
  }

  async readDreamState(): Promise<DreamState> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.stateFile, "utf8"));
      if (isRecord(parsed)) {
        return {
          version: typeof parsed.version === "number" ? parsed.version : 1,
          lastRunAt: typeof parsed.lastRunAt === "string" ? parsed.lastRunAt : null,
          lastRunDate: typeof parsed.lastRunDate === "string" ? parsed.lastRunDate : null,
          consumed: Array.isArray(parsed.consumed)
            ? parsed.consumed.filter((item): item is string => typeof item === "string")
            : [],
          lastBlocks: typeof parsed.lastBlocks === "number" ? parsed.lastBlocks : 0,
        };
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return {
      version: 1,
      lastRunAt: null,
      lastRunDate: null,
      consumed: [],
      lastBlocks: 0,
    };
  }

  async writeDreamState(state: DreamState): Promise<void> {
    await this.queue.run(async () => {
      await this.atomicWrite(this.stateFile, `${JSON.stringify(state, null, 2)}\n`);
    });
  }

  async scopeIndex(scope: string): Promise<string[]> {
    try {
      return (await readFile(join(this.topicsDir, scope, "INDEX.md"), "utf8")).split(/\r?\n/);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  async syncScopeIndex(scope: string, file: string, title: string, body: string): Promise<void> {
    const directory = join(this.topicsDir, scope);
    const indexPath = join(directory, "INDEX.md");
    const lines = (await fileExists(indexPath))
      ? (await readFile(indexPath, "utf8")).split(/\r?\n/)
      : [`# ${scope} — ${describeScope(scope)}`, ""];
    const line = `- [${title}](${file}) — ${descriptionOf(body)}`;
    const at = lines.findIndex((item) => item.includes(`](${file})`));
    if (at >= 0) lines[at] = line;
    else {
      while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
      lines.push(line, "");
    }
    await this.atomicWrite(indexPath, `${lines.join("\n").replace(/\n+$/, "")}\n`);
    await this.syncTopicsIndex();
  }

  async syncTopicsIndex(): Promise<void> {
    const scopes: Array<{ scope: string; count: number }> = [];
    let names: string[] = [];
    try {
      names = await readdir(this.topicsDir);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const name of names.sort()) {
      const directory = join(this.topicsDir, name);
      let isDirectory = false;
      try {
        isDirectory = (await stat(directory)).isDirectory();
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      if (!isDirectory) continue;
      const lines = await this.scopeIndex(name);
      if (lines.length === 0) continue;
      scopes.push({
        scope: name,
        count: lines.filter((line) => line.startsWith("- [")).length,
      });
    }
    const contents = [
      "# topics",
      "",
      ...scopes.map(
        ({ scope, count }) =>
          `- [${scope}](${scope}/INDEX.md) — ${describeScope(scope)}, ${count} topics`,
      ),
      "",
    ].join("\n");
    await this.atomicWrite(join(this.topicsDir, "INDEX.md"), contents);
  }

  async status(): Promise<{
    topics: number;
    scopes: number;
    dailyLogs: number;
    memoryChars: number;
    scratchpadItems: number;
    lastDream: DreamState;
  }> {
    const topics = await this.listTopics();
    const scopes = new Set(topics.map((topic) => topic.scope));
    let memoryChars = 0;
    try {
      memoryChars = (await this.readMemory()).length;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return {
      topics: topics.length,
      scopes: scopes.size,
      dailyLogs: (await this.dailyDates()).length,
      memoryChars,
      scratchpadItems: (await this.openScratchpadItems()).length,
      lastDream: await this.readDreamState(),
    };
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isMissing(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

/** CLI helper: `--memory=<dir>` wins over PI_MEMORY_DIR, then `<cwd>/data/memory`. */
export function rootFromArgs(argv: readonly string[]): string {
  const flag = argv.find((arg) => arg.startsWith("--memory="));
  if (flag !== undefined) return resolve(flag.slice("--memory=".length));
  const env = process.env.PI_MEMORY_DIR?.trim();
  if (env !== undefined && env.length > 0) return resolve(env);
  return resolve(process.cwd(), "data/memory");
}

export function isCli(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return resolve(entry) === resolve(new URL(metaUrl).pathname);
}
