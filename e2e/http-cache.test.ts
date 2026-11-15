import assert from "node:assert/strict";
import { test } from "node:test";
import { AssistantEntry, type EntryRecord, ToolResultEntry } from "@earendil-works/pi-durable";
import { ChatService } from "../src/server/chat-service.js";
import { etagForBody, etagForJson, matchesEtag } from "../src/server/http-cache.js";
import { LoopLagMonitor } from "../src/server/loop-lag.js";
import { TaskActivityTracker } from "../src/server/task-activity.js";
import type { Task } from "../src/shared/types.js";

test("an ETag follows the bytes and If-None-Match accepts weak or listed values", () => {
  const first = etagForBody('{"a":1}');
  assert.equal(first, etagForBody('{"a":1}'));
  assert.notEqual(first, etagForBody('{"a":2}'));
  assert.equal(etagForJson({ a: 1 }), first);
  assert.equal(matchesEtag(first, first), true);
  assert.equal(matchesEtag(`W/${first}`, first), true);
  assert.equal(matchesEtag(`"other", ${first}`, first), true);
  assert.equal(matchesEtag("*", first), true);
  assert.equal(matchesEtag(undefined, first), false);
  assert.equal(matchesEtag('"other"', first), false);
});

test("loop lag reports the window percentiles and the last sample", () => {
  const monitor = new LoopLagMonitor(100, 60_000, () => 0);
  for (const lag of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) monitor.record(lag);
  const stats = monitor.stats();
  assert.equal(stats.p50, 5);
  assert.equal(stats.p95, 10);
  assert.equal(stats.max, 10);
  assert.equal(stats.lastBlockedMs, 10);
});

test("loop lag forgets samples older than the window", () => {
  let now = 0;
  const monitor = new LoopLagMonitor(100, 1_000, () => now);
  monitor.record(900, 0);
  now = 2_000;
  monitor.record(7);
  const stats = monitor.stats();
  assert.equal(stats.max, 7);
  assert.equal(stats.p50, 7);
});

test("activity keeps a render revision that only moves when its data changes", () => {
  const task = (patch: Partial<Task> = {}): Task => ({
    id: "a",
    title: "a",
    status: "working",
    parentId: null,
    blockedBy: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    completion: null,
    ...patch,
  });
  const tracker = new TaskActivityTracker(undefined, () => Date.parse("2026-01-01T00:01:00.000Z"));
  tracker.observeLedger([task()]);
  const before = tracker.viewRevision();
  tracker.view();
  tracker.view();
  assert.equal(tracker.viewRevision(), before, "reading a view is not a change");
  tracker.runStarted();
  assert.ok(tracker.viewRevision() > before);
});

test("two unchanged snapshots reuse the transcript and are byte-identical", async () => {
  const entries = [
    {
      id: 1,
      conversationId: 1,
      kind: "user",
      model: [
        {
          role: "user",
          content: [{ type: "text", text: "hello" }],
          timestamp: Date.parse("2026-01-01T00:00:00.000Z"),
        },
      ],
    },
  ] as never;
  const chat = new ChatService(
    { usage: async () => ({}) } as never,
    { id: 1, context: async () => ({ entries }) } as never,
    { broadcast() {} } as never,
    undefined,
    false,
    { clear: async () => undefined, write: async () => undefined } as never,
    undefined,
    { servers: [], unavailable: [] },
    {} as never,
    undefined,
    {} as never,
    {} as never,
    async () => undefined,
    () => undefined,
    () => [],
  );
  const first = await chat.getSnapshot();
  const second = await chat.getSnapshot();
  assert.equal(second.messages.at(0), first.messages.at(0), "the transcript build was reused");
  assert.deepEqual(second.context, first.context, "context usage was reused");
  assert.equal(JSON.stringify(second), JSON.stringify(first));
});

test("a changed diagram revision invalidates the cached transcript", async () => {
  let revision = 1;
  const id = "abcdefghij";
  const entries = [
    {
      id: 41,
      conversationId: 1,
      kind: AssistantEntry.kind,
      model: [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "draw_diagram", arguments: {} }],
          timestamp: 1_700_000_000_000,
        },
      ],
    },
    {
      id: 42,
      conversationId: 1,
      kind: ToolResultEntry.kind,
      model: [
        {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "draw_diagram",
          content: [{ type: "text", text: "saved" }],
          details: { diagram: { id, revision: 1 }, title: "Flow" },
          isError: false,
          timestamp: 1_700_000_000_000,
        },
      ],
    },
  ] as unknown as EntryRecord[];
  const chat = new ChatService(
    { usage: async () => ({}) } as never,
    { id: 1, context: async () => ({ entries }) } as never,
    { broadcast() {} } as never,
    undefined,
    false,
    { clear: async () => undefined, write: async () => undefined } as never,
    undefined,
    { servers: [], unavailable: [] },
    {} as never,
    undefined,
    {} as never,
    {} as never,
    async () => undefined,
    (candidate: string) => (candidate === id ? revision : undefined),
    () => [],
  );
  const partRevision = (snapshot: Awaited<ReturnType<typeof chat.getSnapshot>>) =>
    (snapshot.messages[0]?.parts?.[0] as { diagram?: { revision?: number } } | undefined)?.diagram
      ?.revision;
  const first = await chat.getSnapshot();
  assert.equal(partRevision(first), 1);
  revision = 2;
  assert.equal(partRevision(await chat.getSnapshot()), 1, "the old cache still has revision 1");
  chat.invalidateTranscriptCache();
  assert.equal(partRevision(await chat.getSnapshot()), 2);
});
