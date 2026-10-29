import assert from "node:assert/strict";
import { test } from "node:test";
import { windowRequestFromQuery, windowTranscript } from "../src/server/transcript-window.js";
import type { ChatMessage } from "../src/shared/types.js";

function transcript(turns: number) {
  const messages: ChatMessage[] = [];
  for (let turn = 1; turn <= turns; turn++) {
    messages.push({
      id: `u${turn}`,
      role: "user",
      text: `q${turn}`,
      order: turn * 10000,
    } as ChatMessage);
    messages.push({
      id: `a${turn}`,
      role: "assistant",
      text: `a${turn}`,
      order: turn * 10000 + 5000,
    } as ChatMessage);
  }
  return { messages, activity: [] };
}

test("a short transcript comes back whole", () => {
  const window = windowTranscript(transcript(5));
  assert.equal(window.messages.length, 10);
  assert.equal(window.hasEarlier, false);
  assert.equal(window.from, 0);
});

test("the first page holds the latest messages and starts at a user message", () => {
  const window = windowTranscript(transcript(40), { limit: 5 });
  assert.equal(window.messages[0]?.role, "user");
  assert.equal(window.messages.length, 6);
  assert.equal(window.messages.at(-1)?.id, "a40");
  assert.equal(window.hasEarlier, true);
});

test("history pages walk back without overlap", () => {
  const all = transcript(10);
  const first = windowTranscript(all, { limit: 6 });
  const older = windowTranscript(all, { before: first.from, limit: 6 });
  assert.ok(older.messages.every((message) => message.order < first.from));
  assert.equal(older.messages.at(-1)?.order, first.from - 5000);
  const rest = windowTranscript(all, { before: older.from, limit: 100 });
  assert.equal(rest.hasEarlier, false);
  assert.equal(rest.messages.length + older.messages.length + first.messages.length, 20);
});

test("a reader that holds older messages gets everything from its window start", () => {
  const window = windowTranscript(transcript(40), { from: 30000 });
  assert.equal(window.messages[0]?.id, "u3");
  assert.equal(window.messages.length, 76);
});

test("query values are parsed and capped", () => {
  assert.deepEqual(windowRequestFromQuery({ before: "120000", limit: "9000" }), {
    before: 120000,
    limit: 500,
  });
  assert.deepEqual(windowRequestFromQuery({ from: "x", limit: "-1" }), {});
});
