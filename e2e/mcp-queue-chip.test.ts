import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageBubble } from "../src/client/ChatView.js";
import { ChatService } from "../src/server/chat-service.js";
import {
  appendMcpNotice,
  buildTranscript,
  JOB_NOTICE_ENTRY_KIND,
  MCP_NOTICE_ENTRY_KIND,
} from "../src/server/session.js";
import { MCP_EVENTS_HEAD } from "../src/shared/notices.js";
import { pendingQueuedMessage } from "../src/shared/queue.js";
import type { ChatMessage, QueuedMessage } from "../src/shared/types.js";

const AT = "2026-10-30T12:00:00.000Z";

function mcpText(eventId = "evt-42"): string {
  return `${MCP_EVENTS_HEAD}\n${JSON.stringify({
    events: [
      {
        subscription_id: "sub-1",
        server: "github",
        event: {
          eventId,
          name: "pull_request",
          timestamp: AT,
          data: { kind: "github.pull_request", jobId: "pr-42", action: "opened" },
        },
      },
    ],
    dropped_events: 0,
  })}`;
}

const JOB_TEXT = [
  "[background job j12 finished] j12 exited 0 after 12s: build",
  "Command: npm run build",
  "Last output:",
  "```",
  "built in 3.21s",
  "```",
  "Read more with job_output id=j12.",
].join("\n");

/** A chat service held in a running turn, so every submitted item stays queued. */
function queuedChat(): {
  chat: ChatService;
  submissions: unknown[];
  conversation: { entries: EntryRecord[] };
} {
  const submissions: unknown[] = [];
  const conversation = {
    id: 1,
    entries: [] as EntryRecord[],
    submit: async (submission: unknown) => {
      submissions.push(submission);
      const id = submissions.length;
      return {
        id,
        status: async () => ({ id, type: "input", status: "queued" }),
        wait: () => new Promise(() => undefined),
      };
    },
    context: async () => ({ entries: conversation.entries }),
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
    { images: async () => [], refFor: () => undefined } as never,
    async () => undefined,
    () => undefined,
    () => [],
  );
  (chat as unknown as { runState: string }).runState = "running";
  return { chat, submissions, conversation };
}

function render(message: ChatMessage, onCancelQueued?: (id: string) => void): string {
  return renderToStaticMarkup(
    createElement(MessageBubble, {
      message,
      ...(onCancelQueued === undefined ? {} : { onCancelQueued }),
    }),
  );
}

function chipClass(markup: string): string {
  return /data-testid="queued-notice-chip"[\s\S]*?<div class="([^"]*)"/.exec(markup)?.[1] ?? "";
}

function firstQueued(chat: ChatService): QueuedMessage {
  const item = chat.getRunStatus().queue?.[0];
  assert.ok(item !== undefined);
  return item;
}

test("a queued MCP notice renders as a transparent chip", async () => {
  const { chat } = queuedChat();
  await chat.submitMcpEventNotice(mcpText());
  const item = firstQueued(chat);
  assert.deepEqual(item.notice, { kind: MCP_NOTICE_ENTRY_KIND, label: "MCP events" });

  const markup = render(pendingQueuedMessage(item), () => undefined);
  assert.match(markup, /data-pending-queue="true"/);
  assert.match(markup, /MCP events · queued/);
  assert.doesNotMatch(markup, /MCP event data follows/);
  assert.doesNotMatch(markup, /\bbg-surface\b/);
  assert.match(markup, /class="[^"]*\bopacity-60\b/);
  assert.match(markup, /aria-label="cancel"/);
  assert.match(markup, />×</);
});

test("the chip turns solid when the notice is placed", async () => {
  const { chat } = queuedChat();
  await chat.submitMcpEventNotice(mcpText());
  const queued = firstQueued(chat);
  const pendingMessage = pendingQueuedMessage(queued);
  const pending = render(pendingMessage);

  const entry = {
    id: 7,
    conversationId: 1,
    kind: MCP_NOTICE_ENTRY_KIND,
    data: {
      noticeId: "github/pull_request/pr-42",
      key: "github/pull_request/pr-42",
      text: mcpText(),
      at: AT,
      createdAt: AT,
      ...(queued.key === undefined ? {} : { queueKey: queued.key }),
    },
  } as unknown as EntryRecord;
  const placed = buildTranscript([entry]).messages[0];
  assert.ok(placed !== undefined);
  const markup = render(placed);

  assert.match(pending, /data-pending-queue="true"/);
  assert.equal(placed.id, pendingMessage.id, "the placed notice keeps the pending chip's id");
  assert.doesNotMatch(markup, /data-pending-queue/);
  assert.doesNotMatch(markup, /· queued/);
  assert.match(markup, /data-notice-kind="mcp"/);
  assert.match(markup, /MCP github: github\.pull_request event/);
  assert.match(markup, /class="[^"]*\bbg-surface\/90\b/);
});

test("an MCP update after a queued first notice stays visible", async () => {
  const entries: EntryRecord[] = [
    {
      id: 1,
      conversationId: 1,
      kind: MCP_NOTICE_ENTRY_KIND,
      data: {
        noticeId: "github/pull_request/pr-42",
        key: "github/pull_request/pr-42",
        text: mcpText(),
        at: AT,
        createdAt: AT,
        queueKey: "queued-notice-key",
      },
    } as unknown as EntryRecord,
  ];
  let nextId = 2;
  const conversation = {
    id: 1,
    commit: async (write: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        appendEntry: async (
          definition: { kind: string },
          _conversationId: number,
          payload: { data: unknown },
        ) => {
          const entry = {
            id: nextId++,
            conversationId: 1,
            kind: definition.kind,
            ...payload,
          };
          entries.push(entry as unknown as EntryRecord);
          return entry;
        },
      };
      return write(tx);
    },
    context: async () => ({ entries }),
  };

  const updated = mcpText("evt-43");
  const message = await appendMcpNotice(conversation as never, {
    noticeId: "github/pull_request/pr-42",
    key: "github/pull_request/pr-42",
    text: updated,
    at: "2026-10-30T12:01:00.000Z",
  });

  assert.ok(message !== undefined, "the update is visible without a reload");
  assert.equal(message.id, "m-queued-notice-key");
  assert.equal(message.text, updated);
  assert.equal(message.notice?.kind, "mcp");
});

test("a human queued message keeps its bubble and cancel button", async () => {
  const { chat } = queuedChat();
  const result = await chat.submit("typed while the run is busy", "queue");
  const item = result.queue[0];
  assert.ok(item !== undefined);
  assert.equal(item.notice, undefined);

  const markup = render(pendingQueuedMessage(item), () => undefined);
  assert.match(markup, /data-pending-queue="true"/);
  assert.match(markup, /typed while the run is busy/);
  assert.match(markup, /class="[^"]*\bbg-surface\b/);
  assert.match(markup, /class="[^"]*\bborder-dashed\b/);
  assert.match(markup, />queued</);
  assert.match(markup, />cancel</);
  assert.doesNotMatch(markup, /data-testid="queued-notice-chip"/);
  assert.doesNotMatch(markup, /\bopacity-60\b/);
});

test("a background-job notice uses the same chip", async () => {
  const { chat } = queuedChat();
  await chat.submitJobNotice(JOB_TEXT);
  const item = firstQueued(chat);
  assert.deepEqual(item.notice, { kind: JOB_NOTICE_ENTRY_KIND, label: "Background job" });

  const job = render(pendingQueuedMessage(item), () => undefined);
  assert.match(job, /Background job · queued/);
  assert.doesNotMatch(job, /\[background job j12 finished\]/);
  assert.match(job, /data-pending-queue="true"/);
  assert.match(job, /aria-label="cancel"/);

  const mcp = (() => {
    const other = queuedChat();
    return other.chat
      .submitMcpEventNotice(mcpText())
      .then(() => render(pendingQueuedMessage(firstQueued(other.chat))));
  })();
  assert.equal(chipClass(job), chipClass(await mcp));
  assert.match(job, /data-pending-queue="true"[^>]*\bopacity-60\b/);
  assert.doesNotMatch(chipClass(job), /\bbg-surface\b/);
});
