import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { dreamMemory, summarizeDream } from "./dream.js";
import { findMemory } from "./find.js";
import { scopeOf, slugify } from "./scopes.js";
import type { SnapshotCache } from "./snapshot.js";
import { isMissing, type MemoryStore, type TopicRecord } from "./store.js";

function text(value: string, isError = false): ToolExecutionResult {
  return { output: [{ type: "text", text: value }], ...(isError ? { isError: true } : {}) };
}

function failure(error: unknown): ToolExecutionResult {
  return text(error instanceof Error ? error.message : String(error), true);
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
): ToolRegistration[] {
  return [
    defineTool({
      name: "memory_write",
      description:
        "Write durable memory. target=long_term writes one topic body (front matter is kept, updated is restamped, the scope INDEX is updated, and the injected snapshot is invalidated). target=daily appends one journalled block; target=scratchpad appends one open '- [ ]' item. Daily and scratchpad writes do not invalidate the snapshot.",
      parameters: Type.Object({
        target: Type.Union([
          Type.Literal("long_term"),
          Type.Literal("daily"),
          Type.Literal("scratchpad"),
        ]),
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
            return text(`Appended one daily block (${args.body.trim().length} chars).`);
          }
          if (args.target === "scratchpad") {
            await store.appendScratchpad(args.body);
            return text(`Appended one open scratchpad item.`);
          }
          if (args.body.trim().length === 0) return text("Refusing to write an empty topic.", true);
          let written: TopicRecord;
          if (args.topic !== undefined) {
            written = await store.writeTopic(
              topicPath(args.topic, args.scope, args.title),
              args.body,
              {
                ...(args.scope === undefined ? {} : { scope: args.scope }),
                ...(args.title === undefined ? {} : { title: args.title }),
                create: true,
              },
            );
          } else {
            const title = args.title ?? args.body.match(/^#{1,3} (.+)$/m)?.[1] ?? "Untitled";
            written = await store.createTopic({
              title,
              body: args.body,
              ...(args.scope === undefined ? {} : { scope: args.scope }),
            });
          }
          snapshot?.invalidate();
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
        "Read one memory file: a topic body (topics/<scope>/<slug>.md), MEMORY.md, SCRATCHPAD.md, or daily/YYYY-MM-DD.md.",
      parameters: Type.Object({
        path: Type.String({ description: "Memory-relative path." }),
      }),
      async execute(args) {
        try {
          const rel = args.path.trim().replace(/^\/+/, "");
          if (rel === "MEMORY.md") return text(await store.readMemory());
          if (rel === "SCRATCHPAD.md") return text((await store.readScratchpad()) || "(empty)");
          const daily = /^daily\/(\d{4}-\d{2}-\d{2})\.md$/.exec(rel);
          if (daily?.[1] !== undefined) return text((await store.readDaily(daily[1])) || "(empty)");
          const topic = await store.readTopic(rel);
          return text(
            `topics/${topic.rel} — ${topic.title}${topic.updated ? ` · ${topic.updated}` : ""}\n\n${topic.body.trim()}`,
          );
        } catch (error) {
          if (isMissing(error)) return text(`no such memory file: ${args.path}`, true);
          return failure(error);
        }
      },
    }),
    defineTool({
      name: "memory_find",
      description:
        "Search topic bodies with TF-IDF (exact terms, prefix matching, title/filename bonus, recency and recall). Returns ranked paths, titles, dates and a short snippet. INDEX.md files are never searched.",
      parameters: Type.Object({
        query: Type.String({ description: "What you half-remember; a few distinctive terms." }),
        limit: Type.Optional(Type.Number({ description: "Maximum results. Default 6." })),
      }),
      async execute(args) {
        try {
          const results = await findMemory(store, args.query, {
            ...(args.limit === undefined ? {} : { limit: args.limit }),
          });
          if (results.length === 0) return text(`no match for: ${args.query}`);
          return text(
            results
              .map(
                (result) =>
                  `${result.score.toFixed(1).padStart(6)}  topics/${result.rel}\n        ${result.title}${
                    result.updated ? ` · ${result.updated}` : ""
                  }\n    ${result.snippet}`,
              )
              .join("\n\n"),
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
