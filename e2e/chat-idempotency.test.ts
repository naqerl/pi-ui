import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { ChatService } from "../src/server/chat-service.js";
import type { RunMarker } from "../src/server/run-marker.js";
import { JOB_NOTICE_ENTRY_KIND } from "../src/server/session.js";
import { pendingQueuedMessage, queuedMessageId } from "../src/shared/queue.js";
import type { QueuedMessage } from "../src/shared/types.js";

interface Draft {
  content: unknown;
  entry?: { kind?: string; data?: Record<string, unknown> };
}

/**
 * A minimal durable conversation: a placed submission appends the entry a real
 * boundary would append, while a queued one stays in the inbox.
 */
function fakeChat(options: { running: boolean; entries?: EntryRecord[] }) {
  const entries = options.entries ?? [];
  const submissions: Draft[] = [];
  let nextSubmission = 1;
  let nextEntry = entries.reduce((max, entry) => Math.max(max, entry.id), 0) + 1;
  const conversation = {
    id: 1,
    entries,
    submit: async (draft: Draft) => {
      submissions.push(draft);
      const id = nextSubmission++;
      if (options.running) {
        return {
          id,
          status: async () => ({ id, type: "input", status: "queued" }),
          wait: () => new Promise(() => undefined),
        };
      }
      const entry = {
        id: nextEntry++,
        conversationId: 1,
        kind: draft.entry?.kind ?? "pi.user",
        ...(draft.entry?.data === undefined ? {} : { data: draft.entry.data }),
        model: [{ role: "user", content: draft.content, timestamp: new Date().toISOString() }],
      } as unknown as EntryRecord;
      entries.push(entry);
      return {
        id,
        status: async () => ({ id, type: "input", status: "placed", entry: entry.id }),
        wait: () => new Promise(() => undefined),
      };
    },
    context: async () => ({ entries }),
  };
  const chat = new ChatService(
    { abortSubmission: async () => "aborted" } as never,
    conversation as never,
    { broadcast() {} } as never,
    undefined,
    false,
    { clear: async () => undefined, write: async () => undefined } as never,
    undefined,
    { servers: [], unavailable: [] },
    {} as never,
    undefined,
    {} as never,
    { images: async () => [], refFor: () => undefined } as never,
    async () => undefined,
    () => undefined,
    () => [],
  );
  (chat as unknown as { runState: string }).runState = options.running ? "running" : "idle";
  return { chat, entries, submissions };
}

function setMarker(chat: ChatService, marker: RunMarker | undefined): void {
  (chat as unknown as { marker: RunMarker | undefined }).marker = marker;
}

function queueItem(id: string, text: string, key: string): QueuedMessage {
  return { id, text, createdAt: "2026-10-30T12:00:00.000Z", key };
}

test("the same client message id places one entry and starts one turn", async () => {
  const { chat, entries, submissions } = fakeChat({ running: false });
  const first = await chat.submit("only once", "queue", { queueKey: "client-1" });
  assert.equal(first.duplicate, undefined);
  assert.equal(first.placed, true);
  assert.equal(first.message.id, "m-client-1");

  const second = await chat.submit("only once", "queue", { queueKey: "client-1" });
  assert.equal(second.duplicate, true);
  assert.equal(second.message.id, first.message.id);
  assert.equal(submissions.length, 1, "the retry never reaches durable");
  assert.equal(entries.filter((entry) => entry.model !== undefined).length, 1);
});

test("a cancel and a retry with the same client id is admitted again", async () => {
  const { chat, submissions } = fakeChat({ running: true });
  const first = await chat.submit("cancel then retry", "queue", { queueKey: "cancel-1" });
  const item = first.queue[0] as QueuedMessage;
  assert.equal(await chat.cancelQueued(item.id), true);
  assert.equal(chat.getRunStatus().queue?.length ?? 0, 0);

  const retry = await chat.submit("cancel then retry", "queue", { queueKey: "cancel-1" });
  assert.equal(retry.duplicate, undefined);
  assert.equal(retry.queued, true);
  assert.equal(submissions.length, 2, "the retry is admitted instead of silently dropped");
  assert.equal(
    (submissions[1] as { requestId?: string }).requestId,
    undefined,
    "the client key is not aliased to durable's settled-request identity",
  );
});

test("a queued client id stays one pending bubble and one submission", async () => {
  const { chat, submissions } = fakeChat({ running: true });
  const first = await chat.submit("queued once", "queue", { queueKey: "client-2" });
  assert.equal(first.queued, true);
  assert.equal(first.placed, false);
  assert.equal(first.queue.length, 1);

  const second = await chat.submit("queued once", "queue", { queueKey: "client-2" });
  assert.equal(second.duplicate, true);
  assert.equal(second.queued, true);
  assert.equal(second.queue.length, 1);
  assert.equal(submissions.length, 1);
  assert.equal(second.message.id, pendingQueuedMessage(first.queue[0] as QueuedMessage).id);
});

test("a delivered queued item leaves the queue and keeps the pending bubble id", async () => {
  const { chat } = fakeChat({ running: true });
  const first = await chat.submit("handoff", "queue", { queueKey: "client-3" });
  const item = first.queue[0] as QueuedMessage;
  const pendingId = pendingQueuedMessage(item).id;
  assert.equal(pendingId, queuedMessageId(item));

  const entry = {
    id: 9,
    conversationId: 1,
    kind: "ui.queue",
    data: { key: "client-3" },
    model: [{ role: "user", content: "handoff", timestamp: "2026-10-30T12:00:00.000Z" }],
  } as unknown as EntryRecord;
  await (
    chat as unknown as { releasePlacedQueueEntry(entry: EntryRecord): Promise<void> }
  ).releasePlacedQueueEntry(entry);
  assert.equal(chat.getRunStatus().queue?.length ?? 0, 0);
});

test("a restart does not re-deliver an item already in the transcript", async () => {
  const placed = {
    id: 4,
    conversationId: 1,
    kind: "ui.queue",
    data: { key: "restored-1" },
    model: [{ role: "user", content: "already placed", timestamp: "2026-10-30T12:00:00Z" }],
  } as unknown as EntryRecord;
  const { chat, submissions } = fakeChat({ running: false, entries: [placed] });
  setMarker(chat, {
    version: 1,
    userMessage: "already placed",
    startedAt: "2026-10-30T12:00:00Z",
    mode: "queue",
    stopRequested: false,
    idempotencyKey: "marker-1",
    queue: [queueItem("11", "already placed", "restored-1")],
    partialEntryId: null,
    updatedAt: "2026-10-30T12:00:00Z",
  });

  await (chat as unknown as { restorePersistedQueue(): Promise<void> }).restorePersistedQueue();
  assert.equal(submissions.length, 0, "the placed item is not submitted again");
  assert.equal(chat.getRunStatus().queue?.length ?? 0, 0);
});

test("a re-delivered job notice yields one chip", async () => {
  const { chat, submissions } = fakeChat({ running: true });
  const text = "[background job j12 finished] j12 exited 0 after 3s: build";
  await chat.submitJobNotice(text, "j12");
  await chat.submitJobNotice(text, "j12");
  assert.equal(submissions.length, 1);
  const queue = chat.getRunStatus().queue ?? [];
  assert.equal(queue.length, 1);
  assert.equal(queue[0]?.notice?.kind, JOB_NOTICE_ENTRY_KIND);
});

test("a re-delivered job notice already in the transcript stays one entry", async () => {
  const { chat, entries, submissions } = fakeChat({ running: false });
  const text = "[background job j77 finished] j77 exited 0 after 2s: build";
  await chat.submitJobNotice(text, "j77");
  const duplicate = await chat.submitJobNotice(text, "j77");
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.placed, true);
  assert.equal(duplicate.message.notice?.kind, "job");
  assert.equal(submissions.length, 1);
  assert.equal(entries.length, 1);
  assert.equal(chat.getRunStatus().queue?.length ?? 0, 0);
});

test("a job notice placed by an older build is still recognised", async () => {
  const text = "[background job j78 finished] j78 exited 0 after 2s: test";
  const placed = {
    id: 5,
    conversationId: 1,
    kind: JOB_NOTICE_ENTRY_KIND,
    data: { text, createdAt: "2026-10-30T12:00:00.000Z" },
  } as unknown as EntryRecord;
  const { chat, entries, submissions } = fakeChat({ running: false, entries: [placed] });
  const duplicate = await chat.submitJobNotice(text, "j78");
  assert.equal(duplicate.duplicate, true);
  assert.equal(submissions.length, 0);
  assert.equal(entries.length, 1);
});

test("a re-delivered notice with no source id is still one chip", async () => {
  const { chat, submissions } = fakeChat({ running: true });
  const text = "[background job j13 finished] j13 exited 0 after 4s: test";
  await chat.submitJobNotice(text);
  await chat.submitJobNotice(text);
  assert.equal(submissions.length, 1);
  assert.equal(chat.getRunStatus().queue?.length, 1);
});
