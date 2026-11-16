import assert from "node:assert/strict";
import { test } from "node:test";
import { ChatService } from "../src/server/chat-service.js";
import type { QueuedMessage } from "../src/shared/types.js";

type InternalChat = {
  runState: string;
  queueRevision: number;
  queued: Map<string, unknown>;
  steers: Map<string, QueuedMessage>;
  held: Map<string, QueuedMessage>;
  holdPendingInputs(): void;
  flushHeldInputs(): Promise<void>;
};

interface FakeConversation {
  id: number;
  aborts: number;
  submitted: { type: string; content?: unknown }[];
  submit(submission: { type: string; content?: unknown }): Promise<unknown>;
  abort(): Promise<void>;
}

function makeChat(options: { failSubmit?: boolean; blockFirstSubmit?: boolean } = {}) {
  const submitted: { type: string; content?: unknown }[] = [];
  let release: (() => void) | undefined;
  const conversation: FakeConversation = {
    id: 1,
    aborts: 0,
    submitted,
    async submit(submission) {
      submitted.push(submission);
      if (options.failSubmit === true) throw new Error("provider refused the message");
      if (options.blockFirstSubmit === true && submitted.length === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return {
        id: submitted.length,
        status: async () => ({ type: "input", status: "placed" }),
        wait: async () => new Promise(() => undefined),
      };
    },
    async abort() {
      conversation.aborts += 1;
    },
  };
  const frames: { event: string; data: unknown }[] = [];
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
  return {
    chat,
    internal: chat as unknown as InternalChat,
    conversation,
    frames,
    release: () => release?.(),
  };
}

const steer = (id: string, text: string, createdAt: string): QueuedMessage => ({
  id,
  text,
  createdAt,
});

const contents = (conversation: FakeConversation): unknown[] =>
  conversation.submitted.map((submission) => submission.content);

test("Stop re-sends queued follow-ups and folds pending steers into one message", async () => {
  const { chat, internal, conversation, frames } = makeChat();
  try {
    internal.runState = "running";
    internal.queued.set("8", {
      item: steer("8", "follow up", "2026-01-01T00:00:01.000Z"),
      submission: { id: 8 },
    });
    internal.steers.set("1", steer("1", "steer one", "2026-01-01T00:00:02.000Z"));
    internal.steers.set("2", steer("2", "steer two", "2026-01-01T00:00:03.000Z"));
    const revision = internal.queueRevision;

    await chat.stop();

    assert.equal(conversation.aborts, 1);
    assert.deepEqual(contents(conversation), ["follow up", "steer one\n\nsteer two"]);
    assert.equal(
      frames.some((frame) => frame.event === "steer.dropped"),
      false,
    );
    assert.ok(internal.queueRevision > revision);
    assert.equal(internal.held.size, 0);
  } finally {
    await chat.close();
  }
});

test("a held input arriving during a flush is drained instead of left behind", async () => {
  const { chat, internal, conversation, release } = makeChat({ blockFirstSubmit: true });
  try {
    internal.runState = "idle";
    internal.steers.set("1", steer("1", "steer one", "2026-01-01T00:00:01.000Z"));
    internal.holdPendingInputs();
    const first = internal.flushHeldInputs();

    for (let attempt = 0; attempt < 100 && conversation.submitted.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.equal(conversation.submitted.length, 1);

    internal.steers.set("2", steer("2", "steer two", "2026-01-01T00:00:02.000Z"));
    internal.holdPendingInputs();
    const second = internal.flushHeldInputs();
    assert.equal(second, first);
    release();
    await first;

    assert.deepEqual(contents(conversation), ["steer one", "steer two"]);
    assert.equal(internal.held.size, 0);
  } finally {
    await chat.close();
  }
});

test("a failing held resubmission leaves a dropped steer rather than losing its text", async () => {
  const { chat, internal, conversation, frames } = makeChat({ failSubmit: true });
  try {
    internal.runState = "running";
    internal.steers.set("1", steer("1", "do not lose me", "2026-01-01T00:00:01.000Z"));

    await chat.stop();

    const dropped = frames.find((frame) => frame.event === "steer.dropped");
    assert.ok(dropped);
    assert.equal((dropped.data as { id: string }).id, "1");
    assert.match((dropped.data as { reason: string }).reason, /provider refused/);
    assert.deepEqual(contents(conversation), ["do not lose me"]);
    assert.equal(internal.held.size, 0);
  } finally {
    await chat.close();
  }
});
