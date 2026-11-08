import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChatService, mcpEventEnvelope, mcpEventText } from "../src/server/chat-service.js";
import { DurableExtensionShim } from "../src/server/durable-extensions.js";
import { McpEventFeed } from "../src/server/mcp-events.js";
import { type McpDelivery, McpOutbox } from "../src/server/mcp-outbox.js";
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
