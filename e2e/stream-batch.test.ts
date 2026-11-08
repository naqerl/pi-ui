import assert from "node:assert/strict";
import { test } from "node:test";
import { frameBatch, reduceDraft, refreshBatch } from "../src/client/stream-batch.js";
import { ChatService } from "../src/server/chat-service.js";
import type { StreamTextDelta } from "../src/shared/types.js";

test("a burst paints once in order; snapshots/completion cancel pending paints", () => {
  const scheduled = new Map<number, () => void>();
  let id = 0;
  let paints = 0;
  let draft = "";
  const batch = frameBatch<StreamTextDelta>(
    (items) => {
      paints++;
      draft = reduceDraft(draft, items);
    },
    (run) => {
      scheduled.set(++id, run);
      return id;
    },
    (key) => scheduled.delete(key),
  );
  batch.push({ text: "a" });
  batch.push({ text: "b" });
  batch.push({ text: "", full: "corrected" });
  batch.push({ text: "!" });
  assert.equal(scheduled.size, 1);
  scheduled.get(id)?.();
  assert.equal(draft, "corrected!");
  assert.equal(paints, 1);
  batch.push({ text: " stale" });
  batch.clear();
  assert.equal(scheduled.size, 0);
  assert.equal(draft, "corrected!");
  batch.push({ text: " new" });
  batch.flush();
  assert.equal(draft, "corrected! new");
  assert.equal(paints, 2);
});

test("refresh bursts share a read, with one trailing read for events during the request", async () => {
  let reads = 0;
  let release!: () => void;
  const queue = refreshBatch(async () => {
    reads++;
    if (reads === 1)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
  }, 1);
  const a = queue.request();
  const b = queue.request();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(reads, 1);
  const c = queue.request();
  const d = queue.request();
  release();
  await Promise.all([a, b, c, d]);
  assert.equal(reads, 2);
  queue.close();
  queue.open();
  await queue.request();
  assert.equal(reads, 3);
  queue.close();
});

test("stream replacements send the prefix once, while reconnect uses authoritative draft sync", () => {
  const frames: Array<{ event: string; data: unknown }> = [];
  const fake = {
    currentText: "a".repeat(10_000),
    currentThinking: "thinking",
    bumpDraft: () => 5,
    hub: { broadcast: (frame: { event: string; data: unknown }) => frames.push(frame) },
  };
  // Exercise the actual server publisher without constructing a provider/session.
  const publisher = ChatService.prototype as unknown as { broadcastText(this: unknown): void };
  publisher.broadcastText.call(fake);
  assert.deepEqual(frames[0]?.data, { text: "", full: fake.currentText, revision: 5 });
  assert.equal(reduceDraft("old", [frames[0]?.data as StreamTextDelta]), fake.currentText);
});
