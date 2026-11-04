import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import type { MemoryToolDetails } from "../../shared/memory.js";
import { dreamMemory, summarizeDream } from "./dream.js";
import { findMemory } from "./find.js";
import { scopeOf, slugify } from "./scopes.js";
import type { SnapshotCache } from "./snapshot.js";
import {
  isMissing,
  type MemoryStore,
  type TopicRecord,
  todayIso,
  topicAppendBlock,
} from "./store.js";

const GREP_DEFAULT_LIMIT = 40;
const GREP_MAX_LIMIT = 200;
const GREP_MAX_LINE_CHARS = 240;
const GREP_MAX_FILE_BYTES = 512 * 1024;
const READ_MAX_LIMIT = 400;

/** One matching line from memory_grep. */
export interface MemoryGrepHit {
  readonly path: string;
  readonly line: number;
  readonly text: string;
}

/** The structured result memory_grep reports alongside its text summary. */
export interface MemoryGrepDetails {
  readonly hits: MemoryGrepHit[];
  readonly topics: number;
  readonly paths: string[];
  readonly chars: number;
}

function text(
  value: string,
  isError = false,
  details?: MemoryToolDetails | MemoryGrepDetails,
): ToolExecutionResult {
  return {
    output: [{ type: "text", text: value }],
    ...(isError ? { isError: true } : {}),
    ...(details === undefined
      ? {}
      : { details: details as unknown as ToolExecutionResult["details"] }),
  };
}

function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  while (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

function lineCount(content: string): number {
  return splitLines(content).length;
}

function readDetails(
  path: string,
  content: string,
  range?: { readonly from: number; readonly to: number },
): MemoryToolDetails {
  return {
    kind: "memory",
    operation: "read",
    hits: 0,
    topics: 0,
    paths: [],
    chars: content.length,
    reads: [{ path, from: range?.from ?? 1, to: range?.to ?? Math.max(1, lineCount(content)) }],
  };
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(value)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Every .md file under topics/, recursively, including INDEX.md. */
async function listTopicFiles(store: MemoryStore): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const rel = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(directory, entry.name), rel);
      else if (entry.isFile() && entry.name.endsWith(".md")) files.push(`topics/${rel}`);
    }
  };
  await walk(store.topicsDir, "");
  return files;
}

/** Reads one grep candidate, skipping anything too large or unreadable. */
async function readGrepFile(store: MemoryStore, path: string): Promise<string | undefined> {
  try {
    const file = store.resolvePath(path);
    const info = await stat(file);
    if (!info.isFile() || info.size > GREP_MAX_FILE_BYTES) return undefined;
    return await readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

function failure(error: unknown): ToolExecutionResult {
  return text(error instanceof Error ? error.message : String(error), true);
}

export interface MemoryWriteRecord {
  /** Memory-relative path, such as topics/projects/widget.md. */
  readonly path: string;
  /** The text just written, without front matter. */
  readonly text: string;
}

export interface MemoryToolHooks {
  /** Persist a chip for a successful write. A failure here never fails the write. */
  readonly onWrite?: (record: MemoryWriteRecord) => void | Promise<void>;
}

function topicPath(topic: string, scope: string | undefined, title: string | undefined): string {
  const trimmed = topic.trim().replace(/^\/+/, "");
  if (trimmed.startsWith("topics/") && trimmed.endsWith(".md")) return trimmed;
  if (trimmed.includes("/") && trimmed.endsWith(".md")) return `topics/${trimmed}`;
  const chosenScope = scope ?? scopeOf(title ?? trimmed);
  const stem = slugify(trimmed.replace(/\.md$/, "")) || slugify(title ?? "") || "topic";
  return `topics/${chosenScope}/${stem}.md`;
}

/** Tools for the layered memory tree. Not deferred, so every turn offers them. */
export function createMemoryTools(
  store: MemoryStore,
  snapshot?: SnapshotCache,
  hooks: MemoryToolHooks = {},
): ToolRegistration[] {
  const recordWrite = async (record: MemoryWriteRecord): Promise<void> => {
    if (hooks.onWrite === undefined) return;
    try {
      await hooks.onWrite(record);
    } catch (error) {
      console.error("[pi] could not record the memory write notice", error);
    }
  };
  return [
    defineTool({
      name: "memory_write",
      description:
        "Write durable memory. target=long_term writes one topic body (front matter is kept, updated is restamped, the scope INDEX is updated, and the injected snapshot is invalidated); mode=append adds a dated block while mode=overwrite replaces the body. target=daily appends one journalled block; target=scratchpad appends one open '- [ ]' item. Daily and scratchpad writes do not invalidate the snapshot.",
      parameters: Type.Object({
        target: Type.Union([
          Type.Literal("long_term"),
          Type.Literal("daily"),
          Type.Literal("scratchpad"),
        ]),
        mode: Type.Optional(
          Type.Union([Type.Literal("append"), Type.Literal("overwrite")], {
            description:
              "For long_term, append adds a dated block to the existing topic body (creating the topic if missing) and overwrite replaces it; default overwrite (today's behaviour). daily and scratchpad always append.",
          }),
        ),
        body: Type.String({ description: "Markdown content to write." }),
        topic: Type.Optional(
          Type.String({
            description:
              "For long_term: topics/<scope>/<slug>.md, <scope>/<slug>.md, or a slug. A new slug is created in its scope.",
          }),
        ),
        scope: Type.Optional(
          Type.String({
            description:
              "For a new long_term topic: core, projects, machines, forge, harness, prefs or misc.",
          }),
        ),
        title: Type.Optional(
          Type.String({ description: "For a new topic: title, if the body has no first heading." }),
        ),
      }),
      async execute(args) {
        try {
          if (args.target === "daily") {
            await store.appendDaily(args.body);
            await recordWrite({ path: `daily/${todayIso()}.md`, text: args.body.trim() });
            return text(`Appended one daily block (${args.body.trim().length} chars).`);
          }
          if (args.target === "scratchpad") {
            await store.appendScratchpad(args.body);
            await recordWrite({ path: "SCRATCHPAD.md", text: args.body.trim() });
            return text(`Appended one open scratchpad item.`);
          }
          if (args.body.trim().length === 0) return text("Refusing to write an empty topic.", true);
          let written: TopicRecord;
          let appended: string | undefined;
          if (args.topic !== undefined) {
            const rel = topicPath(args.topic, args.scope, args.title);
            const options = {
              ...(args.scope === undefined ? {} : { scope: args.scope }),
              ...(args.title === undefined ? {} : { title: args.title }),
              create: true,
            } as const;
            if (args.mode === "append") {
              appended = topicAppendBlock(args.body);
              written = await store.appendTopic(rel, args.body, options);
            } else {
              written = await store.writeTopic(rel, args.body, options);
            }
          } else {
            const title = args.title ?? args.body.match(/^#{1,3} (.+)$/m)?.[1] ?? "Untitled";
            written = await store.createTopic({
              title,
              body: args.body,
              ...(args.scope === undefined ? {} : { scope: args.scope }),
            });
          }
          snapshot?.invalidate();
          await recordWrite({ path: `topics/${written.rel}`, text: appended ?? written.body });
          if (appended !== undefined) {
            return text(
              `appended ${appended.length} chars to ${written.rel} (now ${written.body.length} chars, updated ${written.updated})`,
            );
          }
          return text(
            `wrote ${written.rel} (${written.body.length} chars, updated ${written.updated})`,
          );
        } catch (error) {
          return failure(error);
        }
      },
    }),
    defineTool({
      name: "memory_read",
      description:
        "Read one memory file (a topic body, MEMORY.md, SCRATCHPAD.md, or daily/YYYY-MM-DD.md), optionally only a line window with offset and limit.",
      parameters: Type.Object({
        path: Type.String({ description: "Memory-relative path." }),
        offset: Type.Optional(
          Type.Number({ description: "1-based first line for a window. Default 1." }),
        ),
        limit: Type.Optional(
          Type.Number({
            description: "Number of lines in a window, 1..400. Default the whole file.",
          }),
        ),
      }),
      async execute(args) {
        try {
          const requested = args.path.trim().replace(/^\/+/, "");
          let path = requested;
          let content: string;
          if (requested === "MEMORY.md") {
            content = await store.readMemory();
          } else if (requested === "SCRATCHPAD.md") {
            content = (await store.readScratchpad()) || "(empty)";
          } else {
            const daily = /^daily\/(\d{4}-\d{2}-\d{2})\.md$/.exec(requested);
            if (daily?.[1] !== undefined) {
              content = (await store.readDaily(daily[1])) || "(empty)";
            } else {
              const topic = await store.readTopic(requested);
              path = `topics/${topic.rel}`;
              content = `${path} — ${topic.title}${topic.updated ? ` · ${topic.updated}` : ""}\n\n${topic.body.trim()}`;
            }
          }
          const wantsWindow = args.offset !== undefined || args.limit !== undefined;
          if (!wantsWindow) return text(content, false, readDetails(path, content));

          const lines = splitLines(content);
          const total = lines.length;
          const offset = args.offset;
          const from =
            offset === undefined || !Number.isFinite(offset) ? 1 : Math.max(1, Math.trunc(offset));
          const count =
            args.limit === undefined ? total : clampLimit(args.limit, total, READ_MAX_LIMIT);
          const to = from > total ? from + count - 1 : Math.min(from + count - 1, total);
          const selected = from > total ? [] : lines.slice(from - 1, from - 1 + count);
          const parts = [`${path} — lines ${from}–${to} of ${total}`];
          if (selected.length > 0) parts.push(selected.join("\n"));
          if (to < total) {
            parts.push(`${total - to} more lines (call memory_read with offset=${to + 1})`);
          }
          const window = parts.join("\n\n");
          return text(window, false, readDetails(path, window, { from, to }));
        } catch (error) {
          if (isMissing(error)) return text(`no such memory file: ${args.path}`, true);
          return failure(error);
        }
      },
    }),
    defineTool({
      name: "memory_grep",
      description:
        "Search the memory tree case-insensitively for a literal string or JavaScript regular expression, returning each file, 1-based line and matching text.",
      parameters: Type.Object({
        pattern: Type.String({ description: "Literal string or JavaScript regular expression." }),
        fixed: Type.Optional(
          Type.Boolean({ description: "Treat pattern as literal text. Default false (regex)." }),
        ),
        limit: Type.Optional(Type.Number({ description: "Maximum hits, 1..200. Default 40." })),
      }),
      async execute(args) {
        const limit = clampLimit(args.limit, GREP_DEFAULT_LIMIT, GREP_MAX_LIMIT);
        let expression: RegExp;
        try {
          expression = new RegExp(
            args.fixed === true ? escapeRegExp(args.pattern) : args.pattern,
            "i",
          );
        } catch (error) {
          return text(
            `invalid regular expression: ${args.pattern} (${
              error instanceof Error ? error.message : String(error)
            })`,
            true,
          );
        }

        const paths: string[] = [];
        const hits: MemoryGrepHit[] = [];
        const files = [
          ...(await listTopicFiles(store)),
          "MEMORY.md",
          "SCRATCHPAD.md",
          ...(await store.dailyDates()).slice(-7).map((date) => `daily/${date}.md`),
        ];
        for (const path of files) {
          if (hits.length >= limit) break;
          const file = await readGrepFile(store, path);
          if (file === undefined) continue;
          let recorded = false;
          const lines = file.split(/\r?\n/);
          for (let index = 0; index < lines.length && hits.length < limit; index += 1) {
            const line = lines[index] ?? "";
            if (!expression.test(line)) continue;
            if (!recorded) {
              paths.push(path);
              recorded = true;
            }
            hits.push({
              path,
              line: index + 1,
              text: line.trim().slice(0, GREP_MAX_LINE_CHARS),
            });
          }
        }

        const details: MemoryGrepDetails = {
          hits,
          topics: paths.length,
          paths,
          chars: hits.reduce((total, hit) => total + hit.text.length, 0),
        };
        if (hits.length === 0) return text(`no matches for ${args.pattern}`, false, details);
        const summary = hits.map((hit) => `${hit.path}:${hit.line} — ${hit.text}`).join("\n");
        return text(`${summary}\n\n${hits.length} hits in ${paths.length} files`, false, details);
      },
    }),
    defineTool({
      name: "memory_find",
      description:
        "Search topic bodies with TF-IDF (exact terms, prefix matching, title/filename bonus, recency and recall) and return ranked paths, titles, dates and a short snippet, never INDEX.md; use memory_grep for literal or regex text search.",
      parameters: Type.Object({
        query: Type.String({ description: "What you half-remember; a few distinctive terms." }),
        limit: Type.Optional(Type.Number({ description: "Maximum results. Default 6." })),
      }),
      async execute(args) {
        try {
          const results = await findMemory(store, args.query, {
            ...(args.limit === undefined ? {} : { limit: args.limit }),
          });
          const details: MemoryToolDetails = {
            kind: "memory",
            operation: "find",
            hits: results.reduce((total, result) => total + result.hits, 0),
            topics: results.length,
            paths: results.map((result) => ({
              path: `topics/${result.rel}`,
              line: result.line,
            })),
            chars: results.reduce((total, result) => total + result.snippet.length, 0),
            reads: [],
          };
          if (results.length === 0) {
            return text(`no match for: ${args.query}`, false, details);
          }
          return text(
            results
              .map(
                (result) =>
                  `${result.score.toFixed(1).padStart(6)}  topics/${result.rel}\n        ${result.title}${
                    result.updated ? ` · ${result.updated}` : ""
                  }\n    ${result.snippet}`,
              )
              .join("\n\n"),
            false,
            details,
          );
        } catch (error) {
          return failure(error);
        }
      },
    }),
    defineTool({
      name: "memory_dream",
      description:
        "Run the consolidation pass over the journal. Reports attached blocks, new-topic candidates, near-duplicates, oversized topics, index drift and open scratchpad items. emitDir writes one merge work item per target; commit archives every daily log except today's, records consumed, and rebuilds the map.",
      parameters: Type.Object({
        emitDir: Type.Optional(
          Type.String({ description: "Directory for one work item per target." }),
        ),
        commit: Type.Optional(
          Type.Boolean({ description: "Archive consumed daily logs and rebuild." }),
        ),
      }),
      async execute(args) {
        try {
          const outcome = await dreamMemory(store, {
            ...(args.emitDir === undefined ? {} : { emitDir: args.emitDir }),
            ...(args.commit === undefined ? {} : { commit: args.commit }),
          });
          const lines = [summarizeDream(outcome.report)];
          if (outcome.emitted.length > 0) {
            lines.push("", `${outcome.emitted.length} work item(s) written:`);
            for (const file of outcome.emitted) lines.push(`  ${file}`);
          }
          if (outcome.archived.length > 0) {
            lines.push("", `archived: ${outcome.archived.join(", ")}`);
          }
          return text(lines.join("\n"));
        } catch (error) {
          return failure(error);
        }
      },
    }),
    defineTool({
      name: "memory_status",
      description:
        "Show the memory tree's size and shape: topics, scopes, daily logs, MEMORY.md chars, open scratchpad items, and the last consolidation run.",
      parameters: Type.Object({}),
      async execute() {
        try {
          const status = await store.status();
          return text(
            [
              `topics: ${status.topics} across ${status.scopes} scope(s)`,
              `MEMORY.md: ${status.memoryChars} chars (index only)`,
              `daily logs: ${status.dailyLogs}`,
              `open scratchpad items: ${status.scratchpadItems}`,
              `last dream: ${status.lastDream.lastRunAt ?? "never"}${
                status.lastDream.lastRunDate ? ` (${status.lastDream.lastRunDate})` : ""
              }`,
              `consumed daily logs: ${status.lastDream.consumed.length}`,
              `snapshot: ${snapshot?.built === true ? "built" : "not built yet"}`,
            ].join("\n"),
          );
        } catch (error) {
          return failure(error);
        }
      },
    }),
  ];
}
