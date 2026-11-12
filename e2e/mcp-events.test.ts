import assert from "node:assert/strict";
import { test } from "node:test";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";
import {
  mcpDeliveryTexts,
  mcpEventEnvelope,
  mcpRestoreDeliveryTexts,
} from "../src/server/chat-service.js";
import { DurableExtensionShim } from "../src/server/durable-extensions.js";
import { checkEventNotifications, eventRejection } from "../src/server/mcp-event-check.js";
import { type ExtensionNotice, McpEventFeed } from "../src/server/mcp-events.js";
import { MAX_PENDING_MCP_EVENTS } from "../src/server/mcp-outbox.js";
import { MCP_EVENTS_HEAD } from "../src/shared/notices.js";

const SUBSCRIPTION_META = "io.modelcontextprotocol/subscriptionId";

test("a spec-shaped event raises no rejection", () => {
  const params = {
    eventId: "hub:510",
    name: "hub",
    timestamp: "2026-10-30T12:00:00.000Z",
    data: { kind: "hub.job", id: "j" },
  };
  assert.equal(eventRejection(params, "hub"), null);
});

test("each reason pi-mcp-events drops an event for is named", () => {
  const good = { eventId: "1", name: "hub", timestamp: "t", data: null };
  assert.equal(eventRejection(good, undefined), "has no known subscription id");
  assert.equal(eventRejection({ ...good, eventId: 1 }, "hub"), "has a number eventId");
  assert.equal(eventRejection({ ...good, timestamp: 1 }, "hub"), "has a number timestamp");
  const { data: _data, ...noData } = good;
  assert.equal(eventRejection(noData, "hub"), "has no data");
  assert.equal(
    eventRejection({ ...good, name: "hub.job" }, "hub"),
    'is named "hub.job", not its stream "hub"',
  );
});

function fakeTransport() {
  const sent: JSONRPCMessage[] = [];
  const transport = {
    onmessage: undefined as Transport["onmessage"],
    async start() {},
    async close() {},
    async send(message: JSONRPCMessage) {
      sent.push(message);
    },
  };
  return { transport: transport as unknown as Transport, raw: transport, sent };
}

test("the event check logs each rejection once and passes every frame on unchanged", async () => {
  const { transport, raw, sent } = fakeTransport();
  const lines: string[] = [];
  const checked = checkEventNotifications(transport, "zeroshot", (line) => lines.push(line));
  const received: unknown[] = [];
  checked.onmessage = (message) => received.push(message);

  await checked.send({
    jsonrpc: "2.0",
    id: "sub-1",
    method: "events/stream",
    params: { name: "hub" },
  });
  assert.equal(sent.length, 1, "send still reaches the wrapped transport");

  const event = (eventId: string, name: string) => ({
    jsonrpc: "2.0" as const,
    method: "notifications/events/event",
    params: {
      _meta: { [SUBSCRIPTION_META]: "sub-1" },
      eventId,
      name,
      timestamp: "2026-10-30T12:00:00.000Z",
      data: { kind: "hub.job" },
    },
  });
  const frames = [event("hub:1", "hub.job"), event("hub:2", "hub.job"), event("hub:3", "hub")];
  for (const frame of frames) raw.onmessage?.(frame);
  raw.onmessage?.({ jsonrpc: "2.0", id: "sub-1", result: {} });
  raw.onmessage?.(event("hub:4", "hub"));

  assert.equal(received.length, 5);
  assert.deepEqual(received.slice(0, 3), frames, "frames are never rewritten");
  assert.deepEqual(lines, [
    '[mcp] zeroshot: events/event is named "hub.job", not its stream "hub"; pi-mcp-events drops it',
    "[mcp] zeroshot: events/event has no known subscription id; pi-mcp-events drops it",
  ]);
});

test("a payload cursor pins reconnects and a rejected event never becomes one", async () => {
  const { transport, raw } = fakeTransport();
  const checked = checkEventNotifications(transport, "zeroshot", () => {});
  const received: Array<Record<string, unknown>> = [];
  checked.onmessage = (message) => received.push(message as Record<string, unknown>);
  const meta = (id: string) => ({ _meta: { [SUBSCRIPTION_META]: id } });
  const stream = (id: string) => ({
    jsonrpc: "2.0" as const,
    id,
    method: "events/stream",
    params: { name: "hub" },
  });

  await checked.send(stream("sub-1"));
  const event = {
    jsonrpc: "2.0" as const,
    method: "notifications/events/event",
    params: {
      ...meta("sub-1"),
      eventId: "hub:2",
      name: "hub",
      timestamp: "2026-11-12T10:00:00.000Z",
      // The production hub leaves the envelope null and carries the position
      // in the payload. pi-mcp-events only reads the envelope, so this check
      // propagates the payload position onto the frame.
      cursor: null,
      data: { kind: "hub.job", cursor: "hub:2" },
    },
  };
  const heartbeat = {
    jsonrpc: "2.0" as const,
    method: "notifications/events/heartbeat",
    params: { ...meta("sub-1"), cursor: "hub:9" },
  };
  raw.onmessage?.(event);
  raw.onmessage?.(heartbeat);

  const eventParams = received[0]?.params as { cursor?: string | null } | undefined;
  assert.equal(eventParams?.cursor, "hub:2", "the payload cursor reaches the adapter");
  const heartbeatParams = received[1]?.params as { cursor?: string } | undefined;
  assert.equal(heartbeatParams?.cursor, "hub:2", "a heartbeat cannot skip past that event");

  // Before its first event a brand-new stream keeps the announced position.
  raw.onmessage?.({
    jsonrpc: "2.0",
    method: "notifications/events/heartbeat",
    params: { ...meta("sub-2"), cursor: "hub:99" },
  });
  const freshParams = received[2]?.params as { cursor?: string } | undefined;
  assert.equal(freshParams?.cursor, "hub:99");

  // A frame pi-mcp-events rejects must not move the reconnect position.
  await checked.send(stream("sub-3"));
  raw.onmessage?.({
    jsonrpc: "2.0",
    method: "notifications/events/event",
    params: {
      ...meta("sub-3"),
      eventId: "hub:5",
      name: "not-hub",
      timestamp: "2026-11-12T10:00:00.000Z",
      cursor: null,
      data: { kind: "hub.job", cursor: "hub:5" },
    },
  });
  raw.onmessage?.({
    jsonrpc: "2.0",
    method: "notifications/events/heartbeat",
    params: { ...meta("sub-3"), cursor: "hub:9" },
  });
  const afterRejected = received[4]?.params as { cursor?: string } | undefined;
  assert.equal(afterRejected?.cursor, "hub:9", "a rejected event is not a delivered position");

  // A re-activation cannot jump ahead of the event either.
  raw.onmessage?.({
    jsonrpc: "2.0",
    method: "notifications/events/active",
    params: { ...meta("sub-1"), cursor: "hub:12" },
  });
  const activeParams = received[5]?.params as { cursor?: string } | undefined;
  assert.equal(activeParams?.cursor, "hub:2", "an active ack keeps the last delivered event");
});

test("the shim's sendMessage is bound and survives a throwing observer", () => {
  const shim = new DurableExtensionShim();
  const seen: ExtensionNotice[] = [];
  const submitted: string[] = [];
  shim.setObserver((notice) => {
    seen.push(notice);
    throw new Error("observer broke");
  });
  shim.setMessageSink((text) => submitted.push(text));
  const { sendMessage } = shim;
  const view = Object.create(shim) as DurableExtensionShim;
  const details = { events: [{ subscription_id: "s", server: "hub", event: { eventId: "1" } }] };
  const error = console.error;
  const log = console.log;
  console.error = () => {};
  console.log = () => {};
  try {
    sendMessage({ customType: "mcp-events", content: "event", details });
    view.sendMessage({ customType: "mcp-events", content: "event", details });
  } finally {
    console.error = error;
    console.log = log;
  }
  assert.equal(seen.length, 2);
  assert.deepEqual(submitted, ["event", "event"]);
});

test("the feed shows data.kind as the event name and keeps each subscription's cursor", () => {
  const feed = new McpEventFeed();
  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe" },
      result: {
        subscription: {
          id: "s1",
          server: "zeroshot",
          name: "hub",
          status: "active",
          cursor: "hub:509",
        },
      },
    },
  });
  assert.equal(feed.state.subscriptions[0]?.cursor, "hub:509");
  const changed = feed.ingest({
    customType: "mcp-events",
    details: {
      events: [
        {
          subscription_id: "s1",
          server: "zeroshot",
          event: {
            eventId: "510",
            name: "hub",
            timestamp: "2026-10-30T12:00:00.000Z",
            cursor: "hub:510",
            data: { kind: "hub.job", id: "job-1" },
          },
        },
        {
          subscription_id: "s2",
          server: "other",
          event: {
            eventId: "x",
            name: "ticks",
            timestamp: "2026-10-30T12:00:01.000Z",
            cursor: "t:1",
            data: 1,
          },
        },
      ],
    },
  });
  assert.equal(changed, true);
  assert.equal(feed.state.events[0]?.name, "hub.job");
  assert.equal(feed.state.notice, "new event from other");
  assert.deepEqual(
    feed.state.subscriptions.map((item) => [item.id, item.status, item.cursor]),
    [
      ["s1", "active", "hub:510"],
      ["s2", "active", "t:1"],
    ],
  );
});

test("an event produced before this process started but inside the grace is news", () => {
  const feed = new McpEventFeed(undefined, { startedAt: "2026-11-07T12:00:00.000Z" });
  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe" },
      result: { subscription: { id: "s1", server: "zeroshot", name: "hub", status: "active" } },
    },
  });
  const changed = feed.ingest({
    customType: "mcp-events",
    details: {
      events: [
        {
          subscription_id: "s1",
          server: "zeroshot",
          event: {
            eventId: "hub:900",
            name: "hub",
            timestamp: "2026-11-07T11:50:34.640Z",
            cursor: "hub:900",
            data: { kind: "hub.run", labels: { task: "abc1" } },
          },
        },
      ],
    },
  });
  assert.equal(changed, true);
  assert.equal(feed.state.notice, "new event from zeroshot");
  assert.equal(feed.state.events.at(-1)?.replayed, undefined, "not marked as a replay");
});

test("the stream age gate drops old siblings but keeps fresh and unjudgeable events", () => {
  const feed = new McpEventFeed(undefined, { startedAt: "2026-11-07T12:00:00.000Z" });
  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe" },
      result: { subscription: { id: "s1", server: "zeroshot", name: "hub", status: "active" } },
    },
  });
  const event = (id: string, timestamp?: string) => ({
    subscription_id: "s1",
    server: "zeroshot",
    event: {
      eventId: id,
      name: "hub",
      ...(timestamp === undefined ? {} : { timestamp }),
      cursor: `hub:${id.slice(4)}`,
      data: { kind: "hub.job", id },
    },
  });
  const changed = feed.ingest({
    customType: "mcp-events",
    details: {
      events: [
        event("hub:901", "2026-11-07T11:30:00.000Z"),
        event("hub:902", "2026-11-07T11:50:00.000Z"),
        event("hub:903"),
      ],
    },
  });
  assert.equal(changed, true);
  assert.deepEqual(
    feed.state.events.map((item) => item.id),
    ["hub:902", "hub:903"],
    "one old sibling neither poisons the fresh one nor takes the untimestamped one with it",
  );
  assert.equal(feed.state.gap?.dropped, 1);
});

test("the same event id twice is one entry and one notice", () => {
  const feed = new McpEventFeed(undefined, { startedAt: "2026-11-07T12:00:00.000Z" });
  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe" },
      result: { subscription: { id: "s1", server: "zeroshot", name: "hub", status: "active" } },
    },
  });
  const frame = (id: string) => ({
    customType: "mcp-events",
    details: {
      events: [
        {
          subscription_id: "s1",
          server: "zeroshot",
          event: {
            eventId: id,
            name: "hub",
            timestamp: "2026-11-07T11:50:00.000Z",
            cursor: "hub:901",
            data: { kind: "hub.job", labels: { task: "abc1" } },
          },
        },
      ],
    },
  });
  feed.ingest(frame("hub:901"));
  const notices = feed.state.events.filter((item) => item.id === "hub:901");
  feed.ingest(frame("hub:901"));
  assert.equal(feed.state.events.filter((item) => item.id === "hub:901").length, notices.length);
  assert.equal(feed.state.events.at(-1)?.replayed, undefined);
});

test("a skipped window is recorded as a gap instead of silence", () => {
  const feed = new McpEventFeed(undefined, { startedAt: "2026-11-07T12:00:00.000Z" });
  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe" },
      result: { subscription: { id: "s1", server: "zeroshot", name: "hub", status: "active" } },
    },
  });
  feed.ingest({
    customType: "mcp-events",
    details: { events: [], dropped_events: 92 },
  });
  assert.equal(feed.state.gap?.dropped, 92);
  assert.equal(feed.state.notice, "92 events dropped while reconnecting");
});

test("status metadata is seen, not delivered, and an unchipped replay is retried", () => {
  const feed = new McpEventFeed();
  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe" },
      result: { subscription: { id: "s1", server: "zeroshot", name: "hub", status: "active" } },
    },
  });
  const item = {
    subscription_id: "s1",
    server: "zeroshot",
    event: {
      eventId: "hub:2",
      name: "hub",
      timestamp: "2026-11-07T11:50:00.000Z",
      cursor: "hub:2",
      data: { kind: "hub.job", id: "job-2" },
    },
  };
  // The adapter says it pushed this id; that alone may not suppress a chip.
  feed.ingest({
    customType: "mcp-events-status",
    details: {
      subscriptions: [
        {
          id: "s1",
          server: "zeroshot",
          name: "hub",
          status: "active",
          deliveredEventIds: ["hub:2"],
        },
      ],
    },
  });
  assert.deepEqual(feed.novelEvents([item]), [item], "status ids are still novel until chipped");

  assert.equal(
    feed.ingest({ customType: "mcp-events", details: { events: [item] } }),
    false,
    "the duplicate delivery itself is dropped",
  );
  assert.equal(feed.state.events.at(-1)?.replayed, true);
  assert.equal(feed.state.subscriptions[0]?.cursor, "hub:2");

  // A later duplicate with a different cursor must not replace the original
  // timestamp/cursor that the eventual chip carries.
  const duplicate = {
    ...item,
    event: { ...item.event, timestamp: "2026-11-07T11:45:00.000Z", cursor: "hub:3" },
  };
  assert.equal(feed.ingest({ customType: "mcp-events", details: { events: [duplicate] } }), false);
  assert.deepEqual(feed.novelEvents([]), [item], "the next drain still offers the original item");

  feed.markDelivered([item]);
  assert.deepEqual(feed.novelEvents([item]), []);
  assert.equal(feed.state.events.at(-1)?.replayed, undefined);
});

test("a duplicate delivery never marks an unchipped id as delivered", () => {
  const feed = new McpEventFeed();
  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe" },
      result: { subscription: { id: "s1", server: "hub", name: "hub", status: "active" } },
    },
  });
  const item = {
    subscription_id: "s1",
    server: "hub",
    event: {
      eventId: "hub:7",
      name: "hub",
      timestamp: "2026-11-07T11:50:00.000Z",
      cursor: "hub:7",
      data: { kind: "hub.job", id: "job-7" },
    },
  };
  assert.equal(feed.ingest({ customType: "mcp-events", details: { events: [item] } }), true);
  assert.equal(feed.ingest({ customType: "mcp-events", details: { events: [item] } }), false);
  assert.deepEqual(feed.novelEvents([item]), [item], "no chip means still novel");
  assert.equal(feed.state.subscriptions[0]?.cursor, "hub:7");
  assert.equal(feed.state.events.filter((entry) => entry.id === "hub:7").length, 1);

  feed.markDelivered([item]);
  assert.deepEqual(feed.novelEvents([item]), [], "the committed chip removes the id");
  assert.equal(feed.ingest({ customType: "mcp-events", details: { events: [item] } }), false);
});

test("a zero event cursor never replaces the last real position", () => {
  const feed = new McpEventFeed();
  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe" },
      result: {
        subscription: { id: "s1", server: "hub", name: "hub", status: "active", cursor: "hub:867" },
      },
    },
  });

  const deliver = (eventId: string, cursor: string) =>
    feed.ingest({
      customType: "mcp-events",
      details: {
        events: [
          {
            subscription_id: "s1",
            server: "hub",
            event: {
              eventId,
              name: "hub",
              timestamp: new Date().toISOString(),
              cursor,
              data: { kind: "hub.job", id: eventId },
            },
          },
        ],
      },
    });

  assert.equal(deliver("hub:868", "hub:868"), true);
  assert.equal(feed.state.subscriptions[0]?.cursor, "hub:868");
  deliver("hub:869", "hub:0");
  assert.equal(feed.state.subscriptions[0]?.cursor, "hub:868", "zero is not a position");
});

test("a subscribe keeps the cursor the server answered with, not the one sent", () => {
  const feed = new McpEventFeed();
  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe", server: "hub", name: "hub", cursor: "hub:0" },
      result: {
        subscription: {
          id: "s1",
          server: "hub",
          name: "hub",
          status: "active",
          cursor: "hub:361",
        },
      },
    },
  });
  assert.equal(feed.state.subscriptions[0]?.cursor, "hub:361");

  // The same rule repairs a record restored from a zero cursor: the restore
  // result is the server's answer, so the stored position self-corrects.
  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe", server: "hub", name: "hub", cursor: null, restored: true },
      result: {
        subscription: {
          id: "s2",
          server: "hub",
          name: "hub",
          status: "active",
          cursor: "hub:400",
        },
      },
    },
  });
  assert.equal(feed.state.subscriptions[0]?.cursor, "hub:400", "the restored record adopts it");
  assert.equal(feed.state.subscriptions.length, 1);
});

test("a fresh subscribe never reports a zero cursor back to the caller", () => {
  const feed = new McpEventFeed();
  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe", server: "hub", name: "hub", cursor: "hub:0" },
      result: {
        subscription: {
          id: "s1",
          server: "hub",
          name: "hub",
          status: "active",
          cursor: "hub:0",
        },
      },
    },
  });
  assert.equal(feed.state.subscriptions[0]?.cursor, null, "zero is not a position");

  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe", server: "hub", name: "hub" },
      result: { subscription: { id: "s2", server: "hub", name: "hub", status: "active" } },
    },
  });
  assert.equal(feed.state.subscriptions[0]?.cursor, null, "a fresh stream has no cursor yet");
});

test("a re-subscribe without a cursor keeps the tracked position, not zero", () => {
  const feed = new McpEventFeed();
  const subscribe = (id: string, cursor: string | null, args: Record<string, unknown> = {}) =>
    feed.ingest({
      customType: "mcp-events-tool",
      details: {
        args: { action: "subscribe", server: "hub", name: "hub", ...args },
        result: {
          subscription: { id, server: "hub", name: "hub", status: "active", cursor },
        },
      },
    });

  subscribe("s1", "hub:867");
  assert.equal(feed.state.subscriptions[0]?.cursor, "hub:867");

  // A reconnect may omit the cursor and the server may answer with zero.
  subscribe("s2", "hub:0");
  assert.equal(feed.state.subscriptions[0]?.cursor, "hub:867", "zero is not a resume point");

  subscribe("s3", null);
  assert.equal(feed.state.subscriptions[0]?.cursor, "hub:867", "an omitted answer keeps the row");

  // An explicit zero is a start-now request, not a missing cursor.
  subscribe("s4", "hub:0", { cursor: "hub:0" });
  assert.equal(feed.state.subscriptions[0]?.cursor, null);
});

test("a subscribe burst above the cap keeps the newest ids and records one gap", () => {
  const feed = new McpEventFeed();
  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe" },
      result: { subscription: { id: "s1", server: "hub", name: "hub", status: "active" } },
    },
  });
  const burst = Array.from({ length: 60 }, (_, index) => ({
    subscription_id: "s1",
    server: "hub",
    event: {
      eventId: `hub:${index + 1}`,
      name: "hub",
      timestamp: "2026-11-07T11:50:00.000Z",
      cursor: `hub:${index + 1}`,
      data: { kind: "hub.job", id: `job-${index + 1}` },
    },
  }));

  const texts = mcpDeliveryTexts({ head: MCP_EVENTS_HEAD, items: burst, dropped: 0 }, true);
  assert.equal(texts.length, MAX_PENDING_MCP_EVENTS, "nothing enqueues one delivery per event");
  const last = mcpEventEnvelope(texts.at(-1) ?? "");
  assert.equal(last?.items.length, 1);
  assert.equal(
    (last?.items[0] as { event: { eventId: string } } | undefined)?.event.eventId,
    "hub:60",
    "the newest event survives",
  );

  feed.ingest({ customType: "mcp-events", details: { events: burst } });
  assert.equal(feed.state.gap?.dropped, 10);
  assert.equal(feed.state.events.length, MAX_PENDING_MCP_EVENTS);
  assert.equal(feed.state.events[0]?.id, "hub:11", "the oldest ids are the ones dropped");
  assert.equal(feed.state.events.at(-1)?.id, "hub:60");
});

test("a restore burst above the merge cap is one chip plus a gap, never N chips", () => {
  const feed = new McpEventFeed();
  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe", restored: true },
      result: { subscription: { id: "s1", server: "hub", name: "hub", status: "active" } },
    },
  });
  const burst = Array.from({ length: 60 }, (_, index) => ({
    subscription_id: "s1",
    server: "hub",
    event: {
      eventId: `hub:${index + 1}`,
      name: "hub",
      timestamp: "2026-11-07T11:50:00.000Z",
      cursor: `hub:${index + 1}`,
      data: { kind: "hub.job", id: `job-${index + 1}` },
    },
  }));
  assert.equal(feed.isRestoreBatch(burst), true, "the restored stream owns this replay");

  const texts = mcpRestoreDeliveryTexts({ head: MCP_EVENTS_HEAD, items: burst, dropped: 0 });
  assert.equal(texts.length, 2, "one event chip and one gap chip, not one per event");
  const events = mcpEventEnvelope(texts[0] ?? "");
  const gap = mcpEventEnvelope(texts[1] ?? "");
  assert.equal(events?.items.length, MAX_PENDING_MCP_EVENTS);
  assert.equal(
    (events?.items[0] as { event: { eventId: string } } | undefined)?.event.eventId,
    "hub:11",
    "the oldest ids are the ones dropped",
  );
  assert.equal(
    (events?.items.at(-1) as { event: { eventId: string } } | undefined)?.event.eventId,
    "hub:60",
  );
  assert.equal(gap?.items.length, 0);
  assert.equal(gap?.dropped, 10);
});
