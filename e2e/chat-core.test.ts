import assert from "node:assert/strict";
import { test } from "node:test";
import { buildChatTimeline } from "../src/client/chat-timeline.js";
import { PENDING_QUEUE_ORDER } from "../src/shared/queue.js";
import type { ChatMessage, QueuedMessage } from "../src/shared/types.js";

const entries: ChatMessage[] = [
  { id: "m-1", role: "user", text: "Plan the change", timestamp: "", order: 1 },
  { id: "m-2", role: "assistant", text: "Here is the plan", timestamp: "", order: 2 },
];

const queued: QueuedMessage = {
  id: "q-1",
  key: "queue-key",
  text: "Follow up on the plan",
  createdAt: "",
};

function transcript(kind: "main" | "plan") {
  return buildChatTimeline({
    // The same conversation entries reach both cores; `kind` only names which one is built.
    messages: kind === "main" ? entries : entries.map((message) => ({ ...message })),
    activity: [],
    liveTools: [],
    draftText: kind === "main" ? "Streaming reply" : "Streaming reply",
    draftThinking: "",
    draftThinkingAt: null,
    steers: kind === "main" ? [] : [],
    queue: [queued],
    optimistic: [],
  });
}

test("the plan chat and the main chat build the same row kinds from the same entries", () => {
  // Why: both conversations render one core. A row kind that appears in the main chat must
  // appear in the plan chat for the same entry, or they have forked again.
  const main = transcript("main");
  const plan = transcript("plan");
  assert.deepEqual(
    plan.map((item) => item.kind),
    main.map((item) => item.kind),
  );
  assert.deepEqual(
    plan.map((item) => (item.kind === "message" ? item.message.id : item.activity.id)),
    main.map((item) => (item.kind === "message" ? item.message.id : item.activity.id)),
  );
  const first = plan.at(0);
  assert.equal(first?.kind, "message");
  assert.equal(first?.kind === "message" ? first.message.id : null, "m-1");
  const pending = plan.find(
    (item) => item.kind === "message" && item.message.order === PENDING_QUEUE_ORDER,
  );
  assert.ok(pending);
});
