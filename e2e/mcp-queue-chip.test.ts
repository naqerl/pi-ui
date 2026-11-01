import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { createElement, type ReactElement } from "react";
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
import type { QueuedMessageGroup } from "../src/shared/queue.js";
import {
  groupQueuedMessages,
  pendingQueuedMessage,
  queuedMessageIds,
  queuedNoticeGlyph,
} from "../src/shared/queue.js";
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

/** A terminal event the policy delivers immediately instead of coalescing. */
function immediateText(runId = "r"): string {
  return `${MCP_EVENTS_HEAD}\n${JSON.stringify({
    events: [{ kind: "hub.run", runId, terminal: true }],
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

function notice(id: string, kind: string, label: string): QueuedMessage {
  return {
    id,
    text: "the full notice text the agent reads",
    createdAt: AT,
    notice: { kind, label, glyph: queuedNoticeGlyph(kind) },
  };
}

function human(id: string): QueuedMessage {
  return { id, text: `human ${id}`, createdAt: AT };
}

function groupedMessage(groups: QueuedMessageGroup[], index: number): ChatMessage {
  const group = groups[index];
  assert.ok(group !== undefined);
  return pendingQueuedMessage(group.item, group);
}

function findButton(element: ReactElement): ReactElement<{ onClick?: () => unknown }> | null {
  if (element.type === "button") return element as ReactElement<{ onClick?: () => unknown }>;
  const children = (element.props as { children?: unknown }).children;
  for (const child of Array.isArray(children) ? children : [children]) {
    if (typeof child !== "object" || child === null || !("type" in child)) continue;
    const found = findButton(child as ReactElement);
    if (found !== null) return found;
  }
  return null;
}

test("a queued MCP notice renders as a blurred chip", async () => {
  const { chat } = queuedChat();
  await chat.submitMcpEventNotice(mcpText());
  const item = firstQueued(chat);
  assert.deepEqual(item.notice, {
    kind: MCP_NOTICE_ENTRY_KIND,
    label: "MCP events",
    glyph: "↯",
  });

  const markup = render(pendingQueuedMessage(item), () => undefined);
  assert.match(markup, /data-pending-queue="true"/);
  assert.match(markup, /↯/);
  assert.match(markup, /MCP events/);
  assert.match(markup, /1 queued/);
  assert.doesNotMatch(markup, /MCP event data follows/);
  assert.doesNotMatch(markup, /· queued/);
  assert.match(markup, /\bbackdrop-blur-md\b/);
  assert.match(markup, /\bbg-background\/40\b/);
  assert.match(markup, /\btext-foreground\/80\b/);
  assert.doesNotMatch(markup, /\bbg-transparent\b/);
  assert.doesNotMatch(markup, /\bbg-surface\b/);
  assert.doesNotMatch(markup, /\bopacity-60\b/);
  assert.match(markup, /aria-label="cancel"/);
  assert.match(markup, />×</);
});

test("an immediate MCP event queues as a chip while the agent reads the envelope", async () => {
  const { chat, submissions } = queuedChat();
  const text = immediateText("r");
  await chat.submitMcpEventNotice(text);
  const item = firstQueued(chat);
  assert.deepEqual(item.notice, {
    kind: MCP_NOTICE_ENTRY_KIND,
    label: "MCP events",
    glyph: "↯",
  });

  const markup = render(pendingQueuedMessage(item), () => undefined);
  assert.match(markup, /data-testid="queued-notice-chip"/);
  assert.match(markup, /MCP events/);
  assert.match(markup, /1 queued/);
  assert.doesNotMatch(markup, /MCP event data follows/);
  assert.doesNotMatch(markup, /hub\.run/);

  const submission = submissions[0] as {
    content: string;
    entry?: { kind?: string; data?: { noticeId?: string; text?: string } };
  };
  assert.equal(submission.content, text, "the agent still receives the whole envelope");
  assert.equal(submission.entry?.kind, MCP_NOTICE_ENTRY_KIND);
  assert.equal(submission.entry?.data?.text, text);
  assert.ok((submission.entry?.data?.noticeId ?? "").length > 0);
});

test("each immediate MCP event is a new notice, not an update", async () => {
  const { chat, submissions } = queuedChat();
  await chat.submitMcpEventNotice(immediateText("r1"));
  await chat.submitMcpEventNotice(immediateText("r2"));
  const noticeIds = submissions.map(
    (submission) =>
      (submission as { entry?: { data?: { noticeId?: string } } }).entry?.data?.noticeId ?? "",
  );
  assert.equal(noticeIds.length, 2);
  assert.ok(noticeIds[0] !== undefined && noticeIds[0].length > 0);
  assert.ok(noticeIds[1] !== undefined && noticeIds[1].length > 0);
  assert.notEqual(noticeIds[0], noticeIds[1]);
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

test("a burst of one notice kind is one chip that cancels every id", async () => {
  const items = [
    notice("1", MCP_NOTICE_ENTRY_KIND, "MCP events"),
    notice("2", MCP_NOTICE_ENTRY_KIND, "MCP events"),
    notice("3", MCP_NOTICE_ENTRY_KIND, "MCP events"),
  ];
  const groups = groupQueuedMessages(items);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.count, 3);
  assert.deepEqual(groups[0]?.ids, ["1", "2", "3"]);

  const message = groupedMessage(groups, 0);
  assert.equal(message.queueCount, 3);
  assert.deepEqual(message.queueIds, ["1", "2", "3"]);
  assert.deepEqual(queuedMessageIds(message), ["1", "2", "3"]);

  const markup = render(message, () => undefined);
  assert.equal((markup.match(/data-testid="queued-notice-chip"/g) ?? []).length, 1);
  assert.match(markup, /↯/);
  assert.match(markup, /MCP events/);
  assert.match(markup, /3 queued/);
  assert.match(markup, /aria-label="cancel"/);

  const cancelled: string[] = [];
  const chip = MessageBubble({
    message,
    onCancelQueued: (id) => {
      cancelled.push(id);
    },
  });
  const rendered = (chip.type as (props: typeof chip.props) => ReactElement)(chip.props);
  const button = findButton(rendered);
  assert.ok(button !== null);
  await button.props.onClick?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(cancelled, ["1", "2", "3"], "the × removes the whole group");
});

test("a human queued message breaks a notice run without moving", () => {
  const items = [
    notice("notice-1", MCP_NOTICE_ENTRY_KIND, "MCP events"),
    human("human-1"),
    notice("notice-2", MCP_NOTICE_ENTRY_KIND, "MCP events"),
  ];
  const groups = groupQueuedMessages(items);
  assert.equal(groups.length, 3);
  assert.deepEqual(
    groups.map((group) => group.item.id),
    ["notice-1", "human-1", "notice-2"],
  );
  assert.deepEqual(
    groups.map((group) => group.count),
    [1, 1, 1],
  );
  assert.equal(groups[1]?.item.notice, undefined);

  const messages = groups.map((_group, index) => groupedMessage(groups, index));
  assert.match(render(messages[1] as ChatMessage), /human human-1/);
  assert.doesNotMatch(render(messages[1] as ChatMessage), /data-testid="queued-notice-chip"/);
  assert.match(render(messages[0] as ChatMessage), /1 queued/);
  assert.match(render(messages[2] as ChatMessage), /1 queued/);
});

test("two notice kinds stay separate chips", () => {
  const items = [
    notice("mcp-1", MCP_NOTICE_ENTRY_KIND, "MCP events"),
    notice("job-1", JOB_NOTICE_ENTRY_KIND, "Background job"),
  ];
  const groups = groupQueuedMessages(items);
  assert.equal(groups.length, 2);
  assert.deepEqual(
    groups.map((group) => group.item.id),
    ["mcp-1", "job-1"],
  );

  const mcp = render(groupedMessage(groups, 0));
  const job = render(groupedMessage(groups, 1));
  assert.match(mcp, /↯/);
  assert.doesNotMatch(mcp, /⚙/);
  assert.match(job, /⚙/);
  assert.match(job, /Background job/);
  assert.doesNotMatch(job, /MCP events/);
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
  assert.deepEqual(item.notice, {
    kind: JOB_NOTICE_ENTRY_KIND,
    label: "Background job",
    glyph: "⚙",
  });

  const job = render(pendingQueuedMessage(item), () => undefined);
  assert.match(job, /⚙/);
  assert.match(job, /Background job/);
  assert.match(job, /1 queued/);
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
  assert.doesNotMatch(chipClass(job), /\bbg-surface\b/);
  assert.match(chipClass(job), /\bbackdrop-blur-md\b/);
  assert.match(chipClass(job), /\bbg-background\/40\b/);
  assert.match(chipClass(job), /\btext-foreground\/80\b/);
  assert.doesNotMatch(chipClass(job), /\bbg-transparent\b/);
  assert.doesNotMatch(job, /\bopacity-60\b/);
});
