import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ChatService,
  mcpDeliveryTexts,
  mcpEventEnvelope,
  mcpEventText,
} from "../src/server/chat-service.js";
import { DurableExtensionShim } from "../src/server/durable-extensions.js";
import { McpEventFeed } from "../src/server/mcp-events.js";
import { type McpDelivery, McpIntake, McpOutbox } from "../src/server/mcp-outbox.js";
import { MCP_EVENTS_HEAD, MCP_STATUS_HEAD } from "../src/shared/notices.js";

const event = (id: string) => ({
  server: "hub",
  subscription_id: "s1",
  event: {
    eventId: id,
    name: "hub",
    timestamp: "2020-01-01T00:00:00.000Z",
    data: { kind: "hub.job", status: "completed" },
  },
});

test("preboot unseen IDs are news; A then [A,B,B] selects exactly B without advancing during selection", () => {
  const feed = new McpEventFeed(undefined, { startedAt: Date.now() });
  const a = event("A");
  const b = event("B");
  assert.deepEqual(feed.novelEvents([a]), [a]);
  assert.deepEqual(feed.novelEvents([a]), [a]);
  feed.ingest({ customType: "mcp-events", details: { events: [a] } });
  // Ingest only observes; the chip commit is what removes an id from novelty.
  feed.markDelivered([a]);
  assert.deepEqual(feed.novelEvents([a, b, b]), [b]);
  const text = mcpEventText({ head: MCP_EVENTS_HEAD, items: [], dropped: 0 }, [b]);
  assert.deepEqual(mcpEventEnvelope(text)?.items, [b]);
});

test("failed delivery survives restart with the same id, and completed IDs survive registry lag", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "outbox.json");
  let attempted!: McpDelivery;
  const first = new McpOutbox(path, async (item) => {
    attempted = item;
    throw new Error("injected submission failure");
  });
  await first.load();
  await first.enqueue("news", ["stable/A"]);
  assert.equal(first.hasPending("stable/A"), true);
  first.start();
  // close waits for the in-flight attempt without discarding its durable record.
  await new Promise((resolve) => setTimeout(resolve, 25));
  await first.close();
  assert.equal(JSON.parse(await readFile(path, "utf8")).pending.length, 1);
  const delivered: McpDelivery[] = [];
  const second = new McpOutbox(path, async (item) => {
    delivered.push(item);
  });
  await second.load();
  assert.equal(second.has("stable/A"), true);
  second.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  await second.close();
  assert.equal(delivered[0]?.id, attempted.id);
  assert.equal(second.hasPending("stable/A"), false);
  assert.equal(JSON.parse(await readFile(path, "utf8")).pending.length, 0);
  const third = new McpOutbox(path, async () => {});
  await third.load();
  assert.equal(third.has("stable/A"), true);
  await third.close();
});

test("MCP retries use a stable durable request key and notice identity", async () => {
  const calls: unknown[] = [];
  const fake = {
    submit: async (...args: unknown[]) => {
      calls.push(args);
    },
  };
  const item = { id: "delivery-1", text: "news", at: "2026-01-01T00:00:00Z" };
  await ChatService.prototype.submitMcpDelivery.call(fake as unknown as ChatService, item);
  await ChatService.prototype.submitMcpDelivery.call(fake as unknown as ChatService, item);
  assert.deepEqual(calls[0], calls[1]);
  assert.equal(
    (calls[0] as unknown[])[2] && ((calls[0] as unknown[])[2] as { requestId: string }).requestId,
    "mcp-delivery:delivery-1",
  );
});

test("boot-time events and the provider's replay-truncation warning reach the sink", async () => {
  const shim = new DurableExtensionShim();
  const texts: string[] = [];
  shim.on("session_start", (_event, context) => {
    context.ui.notify("hub: replay is truncated for hub; some events are unavailable.", "warning");
  });
  shim.sendMessage({ customType: "mcp-events", content: "early event" });
  await shim.dispatch("session_start");
  shim.setMessageSink((text) => {
    texts.push(text);
  });
  assert.equal(texts[0], "early event");
  assert.equal(
    texts[1],
    `${MCP_STATUS_HEAD}\nhub: replay is truncated for hub; some events are unavailable.`,
  );
});

test("heartbeat, status and list metadata cannot skip past accepted push events", () => {
  const feed = new McpEventFeed();
  const subscription = { id: "s1", server: "hub", name: "hub", status: "active", cursor: "start" };
  feed.ingest({
    customType: "mcp-events-tool",
    details: { args: { action: "subscribe" }, result: { subscription } },
  });
  const a = event("A");
  feed.ingest({
    customType: "mcp-events",
    details: { events: [{ ...a, event: { ...a.event, cursor: "accepted-A" } }] },
  });
  feed.ingest({
    customType: "mcp-events-traffic",
    details: { subscription_id: "s1", cursor: "unseen-tail" },
  });
  feed.ingest({
    customType: "mcp-events-status",
    details: { subscriptions: [{ ...subscription, cursor: "unseen-tail" }] },
  });
  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "list" },
      result: { subscriptions: [{ ...subscription, cursor: "unseen-tail" }] },
    },
  });
  assert.equal(feed.state.subscriptions[0]?.cursor, "accepted-A");
});

test("idle replay bursts form one bounded delivery; busy bursts preserve per-event queue IDs", () => {
  const envelope = {
    head: MCP_EVENTS_HEAD,
    items: Array.from({ length: 22 }, (_, i) => event(String(i))),
    dropped: 0,
  };
  assert.equal(mcpDeliveryTexts(envelope, false).length, 1);
  assert.equal(mcpDeliveryTexts(envelope, true).length, 22);
  assert.equal(mcpEventEnvelope(mcpDeliveryTexts(envelope, false)[0] ?? "")?.items.length, 22);
});

test("a persistence failure blocks later cursor acknowledgments until retry succeeds", async () => {
  const intake = new McpIntake(1);
  const acknowledged: string[] = [];
  let attempts = 0;
  intake.enqueue(async () => {
    if (++attempts === 1) throw new Error("injected disk failure");
    acknowledged.push("A");
  });
  intake.enqueue(async () => {
    acknowledged.push("B");
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await intake.close();
  assert.deepEqual(acknowledged, ["A", "B"]);
  assert.equal(attempts, 2);
});

test("a busy burst drains to exactly one chip per event id, with nothing left novel", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-busy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const feed = new McpEventFeed();
  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe" },
      result: { subscription: { id: "s1", server: "hub", name: "hub", status: "active" } },
    },
  });
  const items = Array.from({ length: 5 }, (_, index) => event(`busy-${index}`));
  const delivered: McpDelivery[] = [];
  const outbox = new McpOutbox(join(dir, "outbox.json"), async (item) => {
    delivered.push(item);
    const envelope = mcpEventEnvelope(item.text);
    if (envelope !== null) feed.markDelivered(envelope.items);
  });
  await outbox.load();

  const novel = feed.novelEvents(items);
  assert.equal(novel.length, items.length);
  const texts = mcpDeliveryTexts({ head: MCP_EVENTS_HEAD, items: novel, dropped: 0 }, true);
  assert.equal(texts.length, items.length, "busy events keep per-event chip identity");
  await outbox.enqueueMany(
    texts,
    novel.map((item) => feed.eventKey(item)),
  );
  feed.ingest({ customType: "mcp-events", details: { events: items } });
  outbox.start();

  for (let attempt = 0; attempt < 100 && delivered.length < items.length; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await outbox.close();
  assert.equal(delivered.length, items.length);
  assert.equal(new Set(delivered.map((item) => item.id)).size, items.length);
  assert.deepEqual(feed.novelEvents(items), [], "every committed id leaves the novel set");

  feed.ingest({ customType: "mcp-events", details: { events: items } });
  assert.equal(delivered.length, items.length, "duplicates add no chip");
});

test("a failed notice submission leaves ids novel, and the retry commits the chip", async () => {
  const item = event("retry-1");
  const text = mcpEventText({ head: MCP_EVENTS_HEAD, items: [item], dropped: 0 }, [item]);
  const marked: unknown[] = [];
  let attempts = 0;
  const fake = {
    eventFeed: { markDelivered: (items: readonly unknown[]) => marked.push(...items) },
    submit: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("injected submission failure");
    },
  };
  const delivery = { id: "delivery-retry", text, at: "2026-01-01T00:00:00Z" };
  await assert.rejects(
    ChatService.prototype.submitMcpDelivery.call(fake as unknown as ChatService, delivery),
  );
  assert.equal(marked.length, 0, "a failed submission cannot remove an id from novelty");
  await ChatService.prototype.submitMcpDelivery.call(fake as unknown as ChatService, delivery);
  assert.deepEqual(marked, [item], "the successful retry commits the chip");
});
