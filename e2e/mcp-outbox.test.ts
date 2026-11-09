import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("a busy burst drains as one delivery, with nothing left novel", async (t) => {
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
  assert.equal(texts.length, items.length, "busy events still arrive as separate texts");
  await outbox.enqueueMany(
    texts,
    novel.map((item) => feed.eventKey(item)),
  );
  feed.ingest({ customType: "mcp-events", details: { events: items } });
  outbox.start();

  for (let attempt = 0; attempt < 100 && delivered.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await outbox.close();
  assert.equal(delivered.length, 1, "one drain pass submits the whole burst");
  assert.equal(mcpEventEnvelope(delivered[0]?.text ?? "")?.items.length, items.length);
  assert.deepEqual(feed.novelEvents(items), [], "every committed id leaves the novel set");

  feed.ingest({ customType: "mcp-events", details: { events: items } });
  assert.equal(delivered.length, 1, "duplicates add no chip");
});

test("ten events arriving during one delivery become one new batch", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-fold-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "outbox.json");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const delivered: McpDelivery[] = [];
  const outbox = new McpOutbox(path, async (item) => {
    delivered.push(item);
    if (delivered.length === 1) {
      started();
      await gate;
    }
  });
  await outbox.load();
  const first = event("first");
  await outbox.enqueue(
    mcpEventText({ head: MCP_EVENTS_HEAD, items: [first], dropped: 0 }, [first]),
  );
  outbox.start();
  await firstStarted;
  assert.equal(delivered.length, 1);

  const burst = Array.from({ length: 10 }, (_, index) => event(`fold-${index}`));
  await outbox.enqueueMany(
    burst.map((item) => mcpEventText({ head: MCP_EVENTS_HEAD, items: [item], dropped: 0 }, [item])),
    burst.map((item) => `fold-${item.event.eventId}`),
  );
  const during = JSON.parse(await readFile(path, "utf8")) as { pending: McpDelivery[] };
  assert.equal(during.pending.length, 2, "one in-flight item and one waiting item");
  assert.equal(mcpEventEnvelope(during.pending[1]?.text ?? "")?.items.length, 10);

  release();
  for (let attempt = 0; attempt < 100 && delivered.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await outbox.close();
  assert.equal(delivered.length, 2, "the burst is one delivery after the in-flight one");
  const envelope = mcpEventEnvelope(delivered[1]?.text ?? "");
  assert.deepEqual(
    envelope?.items.map((item) => (item as { event: { eventId: string } }).event.eventId),
    burst.map((item) => item.event.eventId),
  );
  assert.equal(JSON.parse(await readFile(path, "utf8")).pending.length, 0);
});

test("an enqueue racing the start of a restored delivery is not lost", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-race-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "outbox.json");
  const first = event("restored-a");
  const second = event("racing-b");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      pending: [
        {
          id: "delivery-a",
          text: mcpEventText({ head: MCP_EVENTS_HEAD, items: [first], dropped: 0 }, [first]),
          at: "2026-01-01T00:00:00.000Z",
        },
      ],
      seen: [],
    }),
  );
  const delivered: McpDelivery[] = [];
  const outbox = new McpOutbox(path, async (item) => {
    delivered.push(item);
  });
  await outbox.load();
  outbox.start();
  // The drain yields before it takes the restored item. This enqueue must not
  // be folded into the request id whose old text is already being delivered.
  await outbox.enqueue(
    mcpEventText({ head: MCP_EVENTS_HEAD, items: [second], dropped: 0 }, [second]),
    ["racing-b"],
  );
  for (let attempt = 0; attempt < 100 && delivered.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await outbox.close();
  assert.equal(delivered.length, 2);
  const ids = delivered.map(
    (item) =>
      (mcpEventEnvelope(item.text)?.items[0] as { event: { eventId: string } } | undefined)?.event
        .eventId,
  );
  assert.deepEqual(ids, ["restored-a", "racing-b"]);
  assert.equal(JSON.parse(await readFile(path, "utf8")).pending.length, 0);
});

test("restoring two pending items keeps a distinct request id for the tail", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-restore-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "outbox.json");
  const first = event("durable-a");
  const second = event("undelivered-b");
  await writeFile(
    path,
    JSON.stringify({
      version: 1,
      pending: [
        {
          id: "delivery-a",
          text: mcpEventText({ head: MCP_EVENTS_HEAD, items: [first], dropped: 0 }, [first]),
          at: "2026-01-01T00:00:00.000Z",
        },
        {
          id: "delivery-b",
          text: mcpEventText({ head: MCP_EVENTS_HEAD, items: [second], dropped: 0 }, [second]),
          at: "2026-01-01T00:00:01.000Z",
        },
      ],
      seen: [],
    }),
  );
  const delivered: McpDelivery[] = [];
  const outbox = new McpOutbox(path, async (item) => {
    delivered.push(item);
    // The first request may already be durable; replaying its id is a no-op.
    // The tail must still arrive under a fresh id rather than A's.
  });
  await outbox.load();
  outbox.start();
  for (let attempt = 0; attempt < 100 && delivered.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await outbox.close();
  assert.equal(delivered.length, 2);
  assert.equal(delivered[0]?.id, "delivery-a");
  assert.equal(delivered[1]?.id, "delivery-b");
  assert.equal(mcpEventEnvelope(delivered[0]?.text ?? "")?.items.length, 1);
  assert.deepEqual(
    (
      mcpEventEnvelope(delivered[1]?.text ?? "")?.items[0] as
        | { event: { eventId: string } }
        | undefined
    )?.event.eventId,
    "undelivered-b",
    "the tail carries only the event it restored",
  );
});

test("a failed removal write never folds a new event into the delivered id", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-removal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "outbox.json");
  const temp = `${path}.tmp`;
  const first = event("delivered-a");
  const second = event("after-removal-b");
  const delivered: McpDelivery[] = [];
  const outbox = new McpOutbox(path, async (item) => {
    delivered.push(item);
    if (delivered.length === 1) {
      // The submission succeeds; the following removal write fails because
      // the temp path is now a directory.
      await mkdir(temp);
    }
  });
  await outbox.load();
  await outbox.enqueue(
    mcpEventText({ head: MCP_EVENTS_HEAD, items: [first], dropped: 0 }, [first]),
    ["delivered-a"],
  );
  outbox.start();
  for (let attempt = 0; attempt < 100 && delivered.length < 1; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  // Let the successful delivery reach its failed removal write.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const failed = JSON.parse(await readFile(path, "utf8")) as { pending: McpDelivery[] };
  assert.equal(failed.pending.length, 1, "the delivered item remains for its removal retry");
  assert.equal(failed.pending[0]?.id, delivered[0]?.id);
  assert.equal(
    mcpEventEnvelope(failed.pending[0]?.text ?? "")?.items.length,
    1,
    "the first item was not merged before the new event arrived",
  );

  await rm(temp, { recursive: true, force: true });
  await outbox.enqueue(
    mcpEventText({ head: MCP_EVENTS_HEAD, items: [second], dropped: 0 }, [second]),
    ["after-removal-b"],
  );
  outbox.start();
  for (let attempt = 0; attempt < 100 && delivered.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await outbox.close();
  assert.equal(delivered.length, 2, "the retry removes the old item, then delivers the new one");
  assert.notEqual(delivered[1]?.id, delivered[0]?.id);
  assert.deepEqual(
    delivered.map(
      (item) =>
        (mcpEventEnvelope(item.text)?.items[0] as { event: { eventId: string } } | undefined)?.event
          .eventId,
    ),
    ["delivered-a", "after-removal-b"],
  );
  assert.equal(JSON.parse(await readFile(path, "utf8")).pending.length, 0);
});

test("a status notice waits beside an event batch without corrupting it", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-status-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const status = `${MCP_STATUS_HEAD}\n${JSON.stringify({
    subscriptions: [{ id: "s1", server: "hub", name: "hub", status: "reconnecting" }],
    dropped_statuses: 0,
  })}`;
  const delivered: McpDelivery[] = [];
  const outbox = new McpOutbox(join(dir, "outbox.json"), async (item) => {
    delivered.push(item);
  });
  await outbox.load();
  const item = event("status-mix");
  await outbox.enqueue(mcpEventText({ head: MCP_EVENTS_HEAD, items: [item], dropped: 0 }, [item]), [
    JSON.stringify(["hub/hub", "status-mix"]),
  ]);
  await outbox.enqueue(status);
  outbox.start();
  for (let attempt = 0; attempt < 100 && delivered.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await outbox.close();
  assert.equal(delivered.length, 2);
  const eventDelivery = delivered.find((entry) => mcpEventEnvelope(entry.text) !== null);
  assert.ok(eventDelivery !== undefined, "the event text still parses as an envelope");
  assert.equal(mcpEventEnvelope(eventDelivery.text)?.items.length, 1);
  assert.ok(delivered.some((entry) => entry.text.startsWith(MCP_STATUS_HEAD)));
});

test("a duplicate event id in one waiting batch appears once", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-dedupe-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const delivered: McpDelivery[] = [];
  const outbox = new McpOutbox(join(dir, "outbox.json"), async (item) => {
    delivered.push(item);
  });
  await outbox.load();
  const twice = event("same");
  const text = mcpEventText({ head: MCP_EVENTS_HEAD, items: [twice], dropped: 0 }, [twice]);
  await outbox.enqueueMany([text, text], ["same"]);
  outbox.start();
  for (let attempt = 0; attempt < 100 && delivered.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await outbox.close();
  assert.equal(delivered.length, 1);
  assert.equal(mcpEventEnvelope(delivered[0]?.text ?? "")?.items.length, 1);
});

test("a burst above the bound keeps the newest events and reports the drop", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-outbox-bound-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "outbox.json");
  const delivered: McpDelivery[] = [];
  const outbox = new McpOutbox(path, async (item) => {
    delivered.push(item);
  });
  await outbox.load();
  const burst = Array.from({ length: 60 }, (_, index) => event(`bound-${index}`));
  await outbox.enqueueMany(
    burst.map((item) => mcpEventText({ head: MCP_EVENTS_HEAD, items: [item], dropped: 0 }, [item])),
  );
  outbox.start();
  for (let attempt = 0; attempt < 100 && delivered.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await outbox.close();
  assert.equal(delivered.length, 1);
  const envelope = mcpEventEnvelope(delivered[0]?.text ?? "");
  assert.equal(envelope?.items.length, 50);
  assert.equal(envelope?.dropped, 10);
  assert.match(delivered[0]?.text ?? "", /10 older events dropped from this batch\./);
  assert.deepEqual(
    envelope?.items.map((item) => (item as { event: { eventId: string } }).event.eventId),
    burst.slice(10).map((item) => item.event.eventId),
  );
  assert.equal(JSON.parse(await readFile(path, "utf8")).pending.length, 0);
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
