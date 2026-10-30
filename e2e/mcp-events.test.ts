import assert from "node:assert/strict";
import { test } from "node:test";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";
import { DurableExtensionShim } from "../src/server/durable-extensions.js";
import { guardEventNotifications, repairEventParams } from "../src/server/mcp-event-guard.js";
import { type ExtensionNotice, McpEventFeed } from "../src/server/mcp-events.js";

const SUBSCRIPTION_META = "io.modelcontextprotocol/subscriptionId";

test("a spec-shaped event passes the guard untouched", () => {
  const params = {
    eventId: "e-1",
    name: "ticks",
    timestamp: "2026-10-30T12:00:00.000Z",
    cursor: "c-1",
    data: { n: 1 },
  };
  const repaired = repairEventParams(params, "ticks");
  assert.deepEqual(repaired, { kind: "kept", params, repairs: [] });
});

test("a hub-shaped event is repaired into one pi-mcp-events accepts", () => {
  const repaired = repairEventParams(
    {
      eventId: 512,
      name: "hub.job",
      timestamp: 1_793_620_800_000,
      cursor: "hub:512",
      data: { id: "j" },
    },
    "hub",
  );
  assert.equal(repaired.kind, "kept");
  if (repaired.kind !== "kept") return;
  assert.equal(repaired.params.eventId, "512");
  assert.equal(repaired.params.name, "hub");
  assert.equal(repaired.params.timestamp, new Date(1_793_620_800_000).toISOString());
  assert.deepEqual(repaired.params.data, { id: "j", eventName: "hub.job" });
  assert.equal(repaired.repairs.length, 3);
});

test("epoch seconds, a missing id with a cursor and missing data are repaired", () => {
  const repaired = repairEventParams(
    { name: "hub", timestamp: 1_793_620_800, cursor: "hub:7" },
    "hub",
  );
  assert.equal(repaired.kind, "kept");
  if (repaired.kind !== "kept") return;
  assert.equal(repaired.params.eventId, "hub:7");
  assert.equal(repaired.params.timestamp, new Date(1_793_620_800_000).toISOString());
  assert.equal(repaired.params.data, null);
});

test("an event with neither id nor cursor is dropped with a reason", () => {
  assert.deepEqual(repairEventParams({ name: "hub", timestamp: "t", data: 1 }, "hub"), {
    kind: "dropped",
    reason: "no eventId",
  });
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

test("the transport guard repairs events for the stream they belong to and logs once", async () => {
  const { transport, raw, sent } = fakeTransport();
  const lines: string[] = [];
  const guarded = guardEventNotifications(transport, "zeroshot", (line) => lines.push(line));
  const received: unknown[] = [];
  guarded.onmessage = (message) => received.push(message);

  await guarded.send({
    jsonrpc: "2.0",
    id: "sub-1",
    method: "events/stream",
    params: { name: "hub" },
  });
  assert.equal(sent.length, 1, "send still reaches the wrapped transport");

  const event = (eventId: number) => ({
    jsonrpc: "2.0" as const,
    method: "notifications/events/event",
    params: {
      _meta: { [SUBSCRIPTION_META]: "sub-1" },
      eventId,
      name: "hub.job",
      timestamp: "2026-10-30T12:00:00.000Z",
      data: { id: eventId },
    },
  });
  raw.onmessage?.(event(1));
  raw.onmessage?.(event(2));
  raw.onmessage?.({ jsonrpc: "2.0", id: 9, result: {} });

  assert.equal(received.length, 3);
  const first = received[0] as { params: Record<string, unknown> };
  assert.equal(first.params.eventId, "1");
  assert.equal(first.params.name, "hub");
  assert.deepEqual(first.params._meta, { [SUBSCRIPTION_META]: "sub-1" });
  assert.deepEqual(received[2], { jsonrpc: "2.0", id: 9, result: {} });
  assert.deepEqual(lines, [
    "[mcp] zeroshot: events/event numeric eventId; repaired",
    '[mcp] zeroshot: events/event event name "hub.job" is not the stream name "hub"; repaired',
  ]);
});

test("a frame without a subscription id goes to the only open stream", async () => {
  const { transport, raw } = fakeTransport();
  const lines: string[] = [];
  const guarded = guardEventNotifications(transport, "zeroshot", (line) => lines.push(line));
  const received: Array<{ params: Record<string, unknown> }> = [];
  guarded.onmessage = (message) => received.push(message as never);
  await guarded.send({
    jsonrpc: "2.0",
    id: "sub-1",
    method: "events/stream",
    params: { name: "hub" },
  });
  raw.onmessage?.({
    jsonrpc: "2.0",
    method: "notifications/events/heartbeat",
    params: { cursor: "hub:3" },
  });
  assert.deepEqual(received[0]?.params._meta, { [SUBSCRIPTION_META]: "sub-1" });
  assert.equal(lines.length, 1);
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

test("the feed keeps the server's event kind and each subscription's cursor", () => {
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
            data: { id: "job-1", eventName: "hub.job" },
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
