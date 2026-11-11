import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatService } from "../src/server/chat-service.js";
import { TASK_DECISION_ENTRY_KIND } from "../src/server/session.js";
import type { DurableRunFacts } from "../src/shared/run-health.js";
import type { StreamMessageDone } from "../src/shared/types.js";

type InternalChat = {
  runState: string;
  queued: Map<string, unknown>;
  durableRunFacts(): Promise<DurableRunFacts>;
  handleEvent(event: { type: "run_end" }): Promise<void>;
  drainQueuedInputs(facts?: DurableRunFacts): Promise<void>;
};

function makeChat(facts: DurableRunFacts) {
  const submitted: unknown[] = [];
  const frames: { event: string; data: unknown }[] = [];
  const conversation = {
    id: 1,
    submit: async (submission: unknown) => {
      submitted.push(submission);
      return { id: submitted.length };
    },
  };
  const chat = new ChatService(
    {} as never,
    conversation as never,
    {
      broadcast: (frame: { event: string; data: unknown } | { event: string; data: unknown }[]) =>
        frames.push(...(Array.isArray(frame) ? frame : [frame])),
    } as never,
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
  const internal = chat as unknown as InternalChat;
  internal.durableRunFacts = async () => facts;
  return { chat, internal, submitted, frames };
}

test("a finished run starts the inputs it left queued instead of waiting for a nudge", async () => {
  const { chat, internal, submitted } = makeChat({ run: false, inbox: 1, submitting: 0 });
  try {
    internal.runState = "running";
    internal.queued.set("7", {});
    await internal.handleEvent({ type: "run_end" });
    assert.deepEqual(submitted, [{ type: "continue" }]);
  } finally {
    await chat.close();
  }
});

test("a live run or an empty inbox never asks for a continue", async () => {
  for (const facts of [
    { run: true, inbox: 2, submitting: 0 },
    { run: false, inbox: 0, submitting: 0 },
  ] satisfies DurableRunFacts[]) {
    const { chat, internal, submitted } = makeChat(facts);
    try {
      internal.runState = "idle";
      internal.queued.set("7", {});
      await internal.drainQueuedInputs();
      assert.deepEqual(submitted, []);
    } finally {
      await chat.close();
    }
  }
});

test("an approval chip is pushed when its entry is placed, before the run ends", async () => {
  const { chat, internal, frames } = makeChat({ run: true, inbox: 0, submitting: 0 });
  try {
    const entry = {
      id: 42,
      conversationId: 1,
      kind: TASK_DECISION_ENTRY_KIND,
      data: {
        proposalId: "p1",
        taskId: "p1",
        taskTitle: "Ship the drain",
        decision: "approved",
        text: "Task proposal p1 was approved and is now task p1: Ship the drain.",
        createdAt: "2026-11-11T00:00:00.000Z",
      },
      model: [
        {
          role: "user",
          content: "Task proposal p1 was approved and is now task p1: Ship the drain.",
          timestamp: "2026-11-11T00:00:00.000Z",
        },
      ],
    };
    await (internal as unknown as { handleEvent(event: unknown): Promise<void> }).handleEvent({
      type: "message_end",
      entry,
    });
    const pushed = frames.find(
      (frame) =>
        frame.event === "message.done" && (frame.data as StreamMessageDone).message !== null,
    );
    assert.ok(pushed);
    const message = (pushed.data as StreamMessageDone).message;
    assert.equal(message?.notice?.kind, "decision");
    const notice = message?.notice as { proposalId?: string } | undefined;
    assert.equal(notice?.proposalId, "p1");
  } finally {
    await chat.close();
  }
});

test("an early-returning drain does not poison the next wake", async () => {
  const { chat, internal, submitted } = makeChat({ run: false, inbox: 0, submitting: 0 });
  try {
    internal.runState = "idle";
    internal.queued.set("7", {});
    // This known-facts pass returns immediately: a live guard must not outlive it.
    await internal.drainQueuedInputs({ run: false, inbox: 0, submitting: 0 });
    assert.deepEqual(submitted, []);
    internal.durableRunFacts = async () => ({ run: false, inbox: 1, submitting: 0 });
    await internal.drainQueuedInputs();
    assert.deepEqual(submitted, [{ type: "continue" }]);
  } finally {
    await chat.close();
  }
});

test("a drain already in flight is shared instead of submitting twice", async () => {
  let release: (() => void) | undefined;
  const { chat, internal, submitted } = makeChat({ run: false, inbox: 1, submitting: 0 });
  const conversation = (
    chat as unknown as { conversation: { submit(submission: unknown): Promise<unknown> } }
  ).conversation;
  conversation.submit = async (submission: unknown) => {
    submitted.push(submission);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { id: submitted.length };
  };
  try {
    internal.runState = "idle";
    internal.queued.set("7", {});
    const first = internal.drainQueuedInputs();
    const second = internal.drainQueuedInputs();
    await new Promise((resolve) => setImmediate(resolve));
    release?.();
    await Promise.all([first, second]);
    assert.deepEqual(submitted, [{ type: "continue" }]);
  } finally {
    await chat.close();
  }
});
