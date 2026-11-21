import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { ChatService } from "../src/server/chat-service.js";
import { McpEventFeed } from "../src/server/mcp-events.js";
import { OutageQuiet, type StatusView } from "../src/server/mcp-outage-quiet.js";
import { deriveStableId } from "../src/server/mcp-subscriptions.js";
import { buildTranscript } from "../src/server/session.js";
import { MCP_STATUS_HEAD } from "../src/shared/notices.js";

function status(subs: Array<{ id: string; status: string }>): string {
  return `${MCP_STATUS_HEAD}\n${JSON.stringify({ subscriptions: subs })}`;
}

function trackedFeed(windowMs: number): {
  feed: McpEventFeed;
  now: () => number;
  advance: (ms: number) => void;
} {
  let clock = 1_000;
  const now = () => clock;
  const feed = new McpEventFeed(undefined, {
    now,
    outageQuiet: new OutageQuiet(now, windowMs),
  });
  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe" },
      result: { subscription: { id: "s1", server: "hub", name: "hub", status: "active" } },
    },
  });
  return { feed, now, advance: (ms) => (clock += ms) };
}

test("a blip inside the window is one chip in and one chip out", () => {
  const { feed, advance } = trackedFeed(60_000);
  const down = status([{ id: "s1", status: "reconnecting" }]);
  const up = status([{ id: "s1", status: "active" }]);

  feed.ingest({
    customType: "mcp-events-status",
    details: JSON.parse(down.slice(MCP_STATUS_HEAD.length + 1)),
  });
  assert.equal(feed.filterStatusNotice(down).mode, "chip");
  advance(20_000);
  feed.ingest({
    customType: "mcp-events-status",
    details: JSON.parse(up.slice(MCP_STATUS_HEAD.length + 1)),
  });
  assert.equal(feed.filterStatusNotice(up).mode, "chip");
  assert.equal(feed.isOutageEscalated(deriveStableId("hub", "hub", {})), false);
  assert.equal(feed.filterStatusNotice(up).mode, "drop", "the recovery chip is not repeated");
});

test("an outage that outlives the window speaks once and leaves a recovery", () => {
  const { feed, advance } = trackedFeed(60_000);
  const down = status([{ id: "s1", status: "reconnecting" }]);
  const up = status([{ id: "s1", status: "active" }]);
  const downDetails = JSON.parse(down.slice(MCP_STATUS_HEAD.length + 1));
  const upDetails = JSON.parse(up.slice(MCP_STATUS_HEAD.length + 1));

  feed.ingest({ customType: "mcp-events-status", details: downDetails });
  assert.equal(feed.filterStatusNotice(down).mode, "chip");
  advance(60_000);
  assert.equal(feed.filterStatusNotice(down).mode, "deliver", "the window is the only threshold");
  assert.equal(feed.filterStatusNotice(down).mode, "chip", "a retry never speaks twice");

  feed.ingest({ customType: "mcp-events-status", details: upDetails });
  assert.equal(
    feed.filterStatusNotice(up).mode,
    "deliver",
    "the recovery after escalation speaks once",
  );
  assert.equal(feed.filterStatusNotice(up).mode, "drop");
});

test("the timer re-reads the row and never escalates a live, fresh stream", () => {
  const { feed, now } = trackedFeed(60_000);
  const down = status([{ id: "s1", status: "reconnecting" }]);
  const downDetails = JSON.parse(down.slice(MCP_STATUS_HEAD.length + 1));
  feed.ingest({ customType: "mcp-events-status", details: downDetails });
  assert.equal(feed.filterStatusNotice(down).mode, "chip");
  const stableId = feed.state.subscriptions[0]?.stableId ?? "";
  assert.equal(feed.takeOutageEscalation(stableId, now() + 59_999), null);

  feed.ingest({
    customType: "mcp-events-status",
    details: { subscriptions: [{ id: "s1", server: "hub", name: "hub", status: "active" }] },
  });
  feed.ingest({
    customType: "mcp-events-traffic",
    details: {
      subscription_id: "s1",
      server: "hub",
      cursor: "hub:1",
      timestamp: new Date(now()).toISOString(),
    },
  });
  assert.equal(feed.takeOutageEscalation(stableId, now() + 60_000), null, "a live row recovered");
  assert.equal(feed.isOutageEscalated(stableId), false);
});

test("the quiet clock is per stable id, so a new adapter id does not restart it", () => {
  const quiet = new OutageQuiet(() => 0, 60_000);
  const stableId = deriveStableId("hub", "hub", {});
  const first: StatusView[] = [{ stableId, status: "reconnecting", text: "down" }];
  assert.deepEqual(quiet.observe(first, 0).chips, ["down"]);
  const replacement: StatusView[] = [{ stableId, status: "reconnecting", text: "down" }];
  assert.deepEqual(quiet.observe(replacement, 60_000).escalations, ["down"]);
  assert.equal(quiet.escalated(stableId), true);
});

function statusChat(feed: McpEventFeed): { chat: ChatService; entries: EntryRecord[] } {
  const entries: EntryRecord[] = [];
  let nextId = 1;
  const append = (kind: string, data: unknown) => {
    const entry = { id: nextId++, conversationId: 1, kind, data };
    entries.push(entry as unknown as EntryRecord);
    return entry;
  };
  const conversation = {
    id: 1,
    entries,
    commit: async (write: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        appendEntry: async (
          definition: { kind: string },
          _conversationId: number,
          payload: { data: unknown },
        ) => append(definition.kind, payload.data),
      };
      return write(tx);
    },
    context: async () => ({ entries }),
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
  chat.setEventFeed(feed);
  (
    chat as unknown as {
      submit: (
        text: string,
        mode: string,
        options?: { entry?: { kind: string; data: unknown } },
      ) => Promise<unknown>;
    }
  ).submit = async (_text, _mode, options) => {
    if (options?.entry !== undefined) append(options.entry.kind, options.entry.data);
    return {};
  };
  return { chat, entries };
}

test("an escalated outage and its recovery keep the one durable chip", async () => {
  const { feed, advance } = trackedFeed(150);
  const down = status([{ id: "s1", status: "reconnecting" }]);
  const up = status([{ id: "s1", status: "active" }]);
  const stableId = deriveStableId("hub", "hub", {});
  feed.ingest({
    customType: "mcp-events-status",
    details: JSON.parse(down.slice(MCP_STATUS_HEAD.length + 1)),
  });
  assert.equal(feed.filterStatusNotice(down).mode, "chip");
  advance(150);
  const escalated = feed.takeOutageEscalation(stableId);
  assert.equal(escalated, down);

  const { chat, entries } = statusChat(feed);
  await chat.recordMcpStatusChip(down);
  await chat.submitMcpEventNotice(escalated ?? "", undefined, { bypassGate: true });

  feed.ingest({
    customType: "mcp-events-status",
    details: JSON.parse(up.slice(MCP_STATUS_HEAD.length + 1)),
  });
  assert.equal(feed.filterStatusNotice(up).mode, "deliver");
  await chat.submitMcpDelivery({
    id: "recovery-1",
    text: up,
    at: new Date(Date.now() + 1_000).toISOString(),
  });

  const expectedId = `mcp/status#${stableId}`;
  assert.deepEqual(
    entries.map((entry) => (entry.data as { noticeId?: string }).noticeId),
    [expectedId, expectedId, expectedId],
    "the chip, escalation and recovery all name the same notice row",
  );
  const transcript = buildTranscript(entries);
  assert.equal(transcript.messages.length, 1, "the full cycle leaves one chip");
  assert.equal(transcript.messages[0]?.text, up, "the one chip ends on active");
  assert.equal(transcript.messages[0]?.notice?.kind, "mcp");
  await chat.close();
});
