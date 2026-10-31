import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PENDING_QUEUE_ORDER,
  pendingQueuedMessage,
  queuedMessageId,
  queueKeyFromEntryData,
} from "../src/shared/queue.js";

const queued = (id: string, key?: string) => ({
  id,
  text: `queued ${id}`,
  createdAt: "2026-10-30T03:00:00.000Z",
  ...(key === undefined ? {} : { key }),
});

test("a queued message renders as a pending user bubble with the placed entry's id", () => {
  const message = pendingQueuedMessage({ ...queued("7", "k-7"), attachments: ["abc.png"] });
  assert.equal(message.id, queuedMessageId(queued("7", "k-7")));
  assert.equal(message.id, "m-k-7");
  assert.equal(message.role, "user");
  assert.equal(message.pendingQueue, true);
  assert.equal(message.queueId, "7");
  assert.equal(message.order, PENDING_QUEUE_ORDER);
  assert.deepEqual(message.attachments, [{ id: "abc.png", mimeType: "image/*" }]);
});

test("older snapshots without a key still get a stable id", () => {
  const item = queued("9");
  assert.equal(queuedMessageId(item), "m-q-9");
  assert.equal(queueKeyFromEntryData({ key: "k-9" }), "k-9");
  assert.equal(queueKeyFromEntryData({}), undefined);
});
