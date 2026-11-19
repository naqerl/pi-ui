import assert from "node:assert/strict";
import { test } from "node:test";
import { type EntryRecord, UserEntry } from "@earendil-works/pi-durable";
import { ChatService } from "../src/server/chat-service.js";

function placedChat() {
  const entries = [
    {
      id: 7,
      conversationId: 1,
      kind: UserEntry.kind,
      model: [{ role: "user", content: "hello" }],
    } as unknown as EntryRecord,
  ];
  const reads = { context: 0, entries: [] as unknown[] };
  const conversation = {
    id: 1,
    submit: async () => ({
      id: 1,
      status: async () => ({ id: 1, type: "input", status: "placed", entry: 7 }),
      wait: () => new Promise(() => undefined),
    }),
    context: async () => {
      reads.context += 1;
      return { entries };
    },
    entries: async (query: unknown) => {
      reads.entries.push(query);
      return { items: entries };
    },
  };
  const chat = new ChatService(
    {} as never,
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
    {} as never,
    async () => undefined,
    () => undefined,
    () => [],
  );
  return { chat, reads };
}

test("a send reads the entry it placed instead of the whole conversation", async () => {
  const { chat, reads } = placedChat();
  try {
    const result = await chat.submit("hello", "queue");
    assert.equal(result.placed, true);
    assert.equal(result.message.text, "hello");
    assert.equal(reads.context, 0, "no full conversation read on the send path");
    assert.deepEqual(reads.entries, [{ minEntryId: 7, maxEntryId: 7, order: "ascending" }]);
  } finally {
    await chat.close();
  }
});
