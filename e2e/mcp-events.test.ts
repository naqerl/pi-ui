import assert from "node:assert/strict";
import { test } from "node:test";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/client";
import { DurableExtensionShim } from "../src/server/durable-extensions.js";
import { checkEventNotifications, eventRejection } from "../src/server/mcp-event-check.js";
import { type ExtensionNotice, McpEventFeed } from "../src/server/mcp-events.js";

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
