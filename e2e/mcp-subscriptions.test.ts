import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DurableExtensionShim } from "../src/server/durable-extensions.js";
import { McpEventFeed } from "../src/server/mcp-events.js";
import { startMcpRuntime } from "../src/server/mcp-runtime.js";
import {
  deriveStableId,
  type McpSubscriptionRecord,
  McpSubscriptionRegistry,
} from "../src/server/mcp-subscriptions.js";
import { McpSubscriptionWatchdog } from "../src/server/mcp-subscriptions-watchdog.js";

async function tempDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-mcp-subs-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function subscription(overrides: Partial<McpSubscriptionRecord> = {}): McpSubscriptionRecord {
  return {
    server: "hub",
    name: "hub",
    arguments: {},
    cursor: null,
    status: "active",
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function eventItem(
  cursor: string | null,
  payloadCursor?: string | null,
  eventId = cursor ?? "e",
  subscriptionId = "s1",
) {
  return {
    subscription_id: subscriptionId,
    server: "hub",
    event: {
      eventId,
      name: "hub",
      timestamp: "2026-10-30T12:00:00.000Z",
      cursor,
      data: {
        ...(payloadCursor === undefined ? {} : { cursor: payloadCursor }),
        kind: "hub.job",
        id: "job-1",
      },
    },
  };
}

test("advances the cursor from the payload when the envelope cursor is null", () => {
  const feed = new McpEventFeed();
  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe" },
      result: { subscription: { id: "s1", server: "hub", name: "hub", status: "active" } },
    },
  });
  assert.equal(
    feed.ingest({ customType: "mcp-events", details: { events: [eventItem(null, "hub:837")] } }),
    true,
  );
  assert.equal(feed.state.subscriptions[0]?.cursor, "hub:837");
  assert.equal(feed.state.events.length, 1);
});

test("persists the advanced cursor and restores the subscription with it", async (t) => {
  const dir = await tempDir(t);
  const registry = new McpSubscriptionRegistry(dir);
  const feed = new McpEventFeed(registry);
  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe" },
      result: { subscription: { id: "s1", server: "hub", name: "hub", status: "active" } },
    },
  });
  feed.ingest({
    customType: "mcp-events",
    details: { events: [eventItem(null, "hub:837", "event-837")] },
  });
  await registry.close();

  const restarted = new McpSubscriptionRegistry(dir);
  const [saved] = await restarted.read();
  assert.equal(saved?.cursor, "hub:837");

  // What the boot restore sends back: a new id, the same stored cursor.
  const restoredFeed = new McpEventFeed(restarted);
  restoredFeed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe", server: "hub", name: "hub", cursor: saved?.cursor },
      result: {
        subscription: {
          id: "s2",
          server: "hub",
          name: "hub",
          status: "active",
          cursor: saved?.cursor,
        },
      },
    },
  });
  assert.equal(restoredFeed.state.subscriptions[0]?.cursor, "hub:837");
  await restarted.close();
});

test("accepts the server cursor even when it moves backwards and deduplicates by event id", () => {
  const feed = new McpEventFeed();
  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe" },
      result: {
        subscription: { id: "s1", server: "hub", name: "hub", status: "active", cursor: "hub:837" },
      },
    },
  });

  // Cursors are opaque. A fresh event with a lower-looking cursor is still a
  // new delivery, and the server's cursor becomes the stored one.
  assert.equal(
    feed.ingest({
      customType: "mcp-events",
      details: { events: [eventItem("hub:10", null, "event-10")] },
    }),
    true,
  );
  assert.equal(feed.state.subscriptions[0]?.cursor, "hub:10");
  assert.equal(feed.state.events.length, 1);

  // The same event id is the replay signal, even with an even lower cursor.
  assert.equal(
    feed.ingest({
      customType: "mcp-events",
      details: { events: [eventItem("hub:1", null, "event-10")] },
    }),
    false,
  );
  assert.equal(feed.state.subscriptions[0]?.cursor, "hub:1");
  assert.equal(feed.state.events.length, 1);

  assert.equal(
    feed.ingest({
      customType: "mcp-events",
      details: { events: [eventItem("hub:11", null, "event-11")] },
    }),
    true,
  );
  assert.equal(feed.state.subscriptions[0]?.cursor, "hub:11");
  assert.equal(feed.state.events.length, 2);
});

test("a repeated event-id burst is dropped and a mixed flush is delivered once", () => {
  const feed = new McpEventFeed();
  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe" },
      result: {
        subscription: { id: "s1", server: "hub", name: "hub", status: "active", cursor: "hub:58" },
      },
    },
  });
  const burst = Array.from({ length: 16 }, (_, index) =>
    eventItem(`hub:${index + 2}`, null, `${index + 2}`),
  );

  // First delivery is live and stores all ids.
  assert.equal(feed.ingest({ customType: "mcp-events", details: { events: burst } }), true);
  const before = feed.state;

  // Replaying those ids does not add events or a notice, even when a busy
  // hub returns different cursors. The stored cursor still follows the server.
  assert.equal(feed.ingest({ customType: "mcp-events", details: { events: burst } }), false);
  assert.equal(feed.state.notice, before.notice);
  assert.equal(feed.state.events.length, before.events.length);
  assert.equal(feed.state.subscriptions[0]?.cursor, "hub:17");

  // The same decision gates pi-mcp-events' follow-up message, so a pure
  // replay cannot start a turn.
  const shim = new DurableExtensionShim();
  const submitted: string[] = [];
  shim.setObserver(() => false);
  shim.setMessageSink((text) => submitted.push(text));
  shim.sendMessage({ customType: "mcp-events", content: "replay", details: { events: burst } });
  assert.deepEqual(submitted, []);

  // A flush that also has a new id is delivered once.
  assert.equal(
    feed.ingest({
      customType: "mcp-events",
      details: { events: [...burst, eventItem("hub:60", null, "60")] },
    }),
    true,
  );
  assert.equal(feed.state.notice, "new event from hub");
  assert.equal(feed.state.events.length, before.events.length + 1);
});

test("keeps one entry per server, name and arguments", async (t) => {
  const dir = await tempDir(t);
  const registry = new McpSubscriptionRegistry(dir);
  await registry.record(subscription({ cursor: "hub:1", arguments: { channel: "jobs" } }));
  await registry.record(subscription({ cursor: "hub:2", arguments: { channel: "jobs" } }));
  await registry.record(subscription({ cursor: "hub:3", arguments: { channel: "alerts" } }));
  await registry.record(subscription({ server: "other", cursor: "hub:4" }));
  await registry.close();

  const document = JSON.parse(await readFile(join(dir, "mcp-subscriptions.json"), "utf8")) as {
    version: number;
    subscriptions: McpSubscriptionRecord[];
  };
  assert.equal(document.version, 1);
  assert.equal(document.subscriptions.length, 3);
  const jobs = document.subscriptions.find(
    (entry) => entry.server === "hub" && JSON.stringify(entry.arguments) === '{"channel":"jobs"}',
  );
  assert.equal(jobs?.cursor, "hub:2");
});

test("starts empty when the registry file is corrupt", async (t) => {
  const dir = await tempDir(t);
  await writeFile(join(dir, "mcp-subscriptions.json"), "{not json");
  const registry = new McpSubscriptionRegistry(dir, { log: () => {} });
  assert.deepEqual(await registry.read(), []);
  await registry.close();

  await writeFile(
    join(dir, "mcp-subscriptions.json"),
    JSON.stringify({ version: 99, subscriptions: [subscription()] }),
  );
  const unknown = new McpSubscriptionRegistry(dir, { log: () => {} });
  assert.deepEqual(await unknown.read(), []);
  await unknown.close();
});

test("derives a stable id from server, name and sorted arguments", () => {
  assert.equal(deriveStableId("zeroshot", "hub", {}), "zeroshot/hub");
  const first = deriveStableId("hub", "jobs", {
    channel: "jobs",
    filter: { state: "open", owner: "pi" },
  });
  const reordered = deriveStableId("hub", "jobs", {
    filter: { owner: "pi", state: "open" },
    channel: "jobs",
  });
  assert.equal(first, reordered);
  assert.match(first, /^hub\/jobs#[A-Za-z0-9_-]+$/);
  assert.notEqual(
    first,
    deriveStableId("hub", "jobs", { channel: "alerts", filter: { owner: "pi", state: "open" } }),
  );
});

test("upgrades a 1.6.7 registry file once and keeps the derived identity", async (t) => {
  const dir = await tempDir(t);
  const oldRecord = {
    server: "zeroshot",
    name: "hub",
    arguments: { z: 1, a: { y: 2, x: 3 } },
    cursor: "hub:42",
    status: "active",
    updatedAt: "2026-10-30T12:00:00.000Z",
  };
  await writeFile(
    join(dir, "mcp-subscriptions.json"),
    JSON.stringify({ version: 1, subscriptions: [oldRecord] }),
  );

  const registry = new McpSubscriptionRegistry(dir);
  const [record] = await registry.read();
  const stableId = deriveStableId("zeroshot", "hub", { a: { x: 3, y: 2 }, z: 1 });
  assert.equal(record?.stableId, stableId);
  assert.equal(record?.id, null);
  assert.equal(record?.enabled, true);
  assert.deepEqual(record?.deliveredEventIds, []);
  await registry.close();

  const document = JSON.parse(await readFile(join(dir, "mcp-subscriptions.json"), "utf8")) as {
    version: number;
    subscriptions: McpSubscriptionRecord[];
  };
  assert.equal(document.version, 1);
  assert.equal(document.subscriptions[0]?.stableId, stableId);
  assert.equal(document.subscriptions[0]?.id, null);
  assert.equal(document.subscriptions[0]?.enabled, true);
  assert.deepEqual(document.subscriptions[0]?.deliveredEventIds, []);
});

test("delivers the first live duplicate once and drops only the repeat", () => {
  const feed = new McpEventFeed();
  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe" },
      result: {
        subscription: {
          id: "s1",
          server: "hub",
          name: "hub",
          status: "active",
          cursor: null,
        },
      },
    },
  });
  const event = eventItem(null, null, "live-1");
  assert.equal(feed.ingest({ customType: "mcp-events", details: { events: [event] } }), true);
  assert.equal(feed.state.events.length, 1);
  assert.equal(feed.state.events[0]?.replayed, undefined);
  assert.equal(feed.ingest({ customType: "mcp-events", details: { events: [event] } }), false);
  assert.equal(feed.state.events.length, 1);
});

test("marks an id delivered before a restart as replayed and still notifies a new event", async (t) => {
  const dir = await tempDir(t);
  const stableId = deriveStableId("hub", "hub", {});
  const registry = new McpSubscriptionRegistry(dir);
  await registry.record(
    subscription({
      stableId,
      id: "old-adapter-id",
      cursor: "hub:2",
      status: "active",
      deliveredEventIds: ["event-1"],
    }),
  );
  const feed = new McpEventFeed(registry);
  await feed.hydrate();
  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe", server: "hub", name: "hub", cursor: "hub:2" },
      result: {
        subscription: {
          id: "s2",
          server: "hub",
          name: "hub",
          status: "active",
          cursor: "hub:2",
          stableId,
        },
      },
    },
  });
  const before = feed.state.notice;

  assert.equal(
    feed.ingest({
      customType: "mcp-events",
      details: { events: [eventItem("hub:1", null, "event-1", "s2")] },
    }),
    false,
  );
  const replay = feed.state.events.find((event) => event.id === "event-1");
  assert.equal(replay?.replayed, true);
  assert.equal(feed.state.notice, before);

  assert.equal(
    feed.ingest({
      customType: "mcp-events",
      details: { events: [eventItem("hub:3", null, "event-2", "s2")] },
    }),
    true,
  );
  assert.equal(feed.state.notice, "new event from hub");
  assert.equal(feed.state.events.at(-1)?.id, "event-2");
  assert.equal(feed.state.events.at(-1)?.replayed, undefined);
  await registry.close();
});

test("persists delivered ids so the next process can recognise the replay", async (t) => {
  const dir = await tempDir(t);
  const stableId = deriveStableId("hub", "hub", {});
  const registry = new McpSubscriptionRegistry(dir);
  const feed = new McpEventFeed(registry);
  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe" },
      result: {
        subscription: {
          id: "first",
          server: "hub",
          name: "hub",
          status: "active",
          cursor: null,
          stableId,
        },
      },
    },
  });
  assert.equal(
    feed.ingest({
      customType: "mcp-events",
      details: { events: [eventItem("hub:7", null, "event-7")] },
    }),
    true,
  );
  await registry.close();

  const restarted = new McpSubscriptionRegistry(dir);
  const [saved] = await restarted.read();
  assert.deepEqual(saved?.deliveredEventIds, ["event-7"]);

  const nextFeed = new McpEventFeed(restarted);
  await nextFeed.hydrate();
  nextFeed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe", restored: true },
      result: {
        subscription: {
          id: "second",
          server: "hub",
          name: "hub",
          status: "active",
          cursor: "hub:7",
          stableId,
        },
      },
    },
  });
  assert.equal(
    nextFeed.ingest({
      customType: "mcp-events",
      details: { events: [eventItem("hub:6", null, "event-7", "second")] },
    }),
    false,
  );
  assert.equal(nextFeed.state.events[0]?.replayed, true);
  await restarted.close();
});

test("cancelling by stableId after a restore stops the stream and survives a restart", async (t) => {
  const dataDir = await tempDir(t);
  await withAgentConfig(t, {
    mcpServers: {
      stub: { command: process.execPath, args: [resolve("e2e/stub-mcp.mjs")] },
    },
    web: { command: process.execPath, disabled: true },
  });
  const registry = new McpSubscriptionRegistry(dataDir);
  await registry.record(
    subscription({ server: "stub", name: "stub-hub", cursor: "hub:500", status: "active" }),
  );
  await registry.close();

  const runtime = await startMcpRuntime({ dataDir });
  const restored = runtime.restoredSubscriptions[0];
  const stableId = restored?.stableId;
  assert.ok(stableId);
  assert.equal(stableId, deriveStableId("stub", "stub-hub", {}));
  try {
    const cancelled = await runtime.cancelSubscription(stableId);
    assert.equal(cancelled?.status, "cancelled");
    assert.equal(cancelled?.enabled, false);
    // Repeating the cancellation is harmless.
    assert.equal((await runtime.cancelSubscription(stableId))?.status, "cancelled");
    const saved = await runtime.subscriptionRegistry?.read();
    const record = saved?.find((entry) => entry.stableId === stableId);
    assert.equal(record?.status, "cancelled");
    assert.equal(record?.enabled, false);
  } finally {
    await runtime.close();
  }

  const restarted = await startMcpRuntime({ dataDir });
  try {
    assert.deepEqual(restarted.restoredSubscriptions, []);
  } finally {
    await restarted.close();
  }
});

test("a late status notice cannot revive a cancelled stable id", async (t) => {
  const dir = await tempDir(t);
  const stableId = deriveStableId("hub", "hub", {});
  const registry = new McpSubscriptionRegistry(dir);
  const feed = new McpEventFeed(registry);
  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe" },
      result: {
        subscription: {
          id: "s1",
          server: "hub",
          name: "hub",
          status: "active",
          cursor: null,
          stableId,
        },
      },
    },
  });
  feed.cancel(stableId);
  assert.equal(feed.findByStableId(stableId)?.status, "cancelled");
  await registry.flush();

  feed.ingest({
    customType: "mcp-events-status",
    details: {
      subscriptions: [{ id: "s1", server: "hub", name: "hub", status: "reconnecting", stableId }],
    },
  });
  assert.equal(feed.findByStableId(stableId)?.status, "cancelled");

  // A queued status can also reach the registry after the cancellation.
  await registry.record(
    subscription({
      stableId,
      id: "s1",
      status: "reconnecting",
      updatedAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  );
  await registry.flush();
  const [saved] = await registry.read();
  assert.equal(saved?.status, "cancelled");
  assert.equal(saved?.enabled, false);
  await registry.close();
});

test("cancelling again after a resubscribe stops every live adapter id", async (t) => {
  const dataDir = await tempDir(t);
  await withAgentConfig(t, {
    mcpServers: {
      stub: { command: process.execPath, args: [resolve("e2e/stub-mcp.mjs")] },
    },
    web: { command: process.execPath, disabled: true },
  });
  const registry = new McpSubscriptionRegistry(dataDir);
  await registry.record(
    subscription({ server: "stub", name: "stub-hub", cursor: "hub:500", status: "active" }),
  );
  await registry.close();

  const runtime = await startMcpRuntime({ dataDir });
  const feed = new McpEventFeed(runtime.subscriptionRegistry);
  await feed.hydrate();
  runtime.setObserver((notice) => feed.ingest(notice));
  const stableId = deriveStableId("stub", "stub-hub", {});
  const first = feed.findByStableId(stableId);
  assert.ok(first);
  const cancel = async () => {
    await runtime.cancelSubscription(stableId, feed.adapterIdsForStableId(stableId));
    feed.cancel(stableId);
  };

  try {
    await cancel();
    assert.equal(feed.findByStableId(stableId)?.status, "cancelled");

    const args = {
      action: "subscribe",
      server: "stub",
      name: "stub-hub",
      arguments: {},
      cursor: null,
    };
    const result = await runtime.shim.callTool("mcp_events", args);
    const details = result.details as { subscription?: { id?: string } } | undefined;
    const secondId = details?.subscription?.id;
    assert.ok(secondId);
    assert.notEqual(secondId, first.id);
    feed.ingest({
      customType: "mcp-events-tool",
      details: { args, result: result.details ?? null },
    });

    const rows = feed.state.subscriptions.filter((item) => item.stableId === stableId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, secondId);
    assert.equal(rows[0]?.status, "active");
    assert.ok(feed.adapterIdsForStableId(stableId).includes(first.id));

    await cancel();
    assert.equal(feed.findByStableId(stableId)?.status, "cancelled");

    const listed = await runtime.shim.callTool("mcp_events", { action: "list" });
    const list = listed.details as
      | { subscriptions?: { name?: string; status?: string }[] }
      | undefined;
    const active = (list?.subscriptions ?? []).filter(
      (item) =>
        item.name === "stub-hub" &&
        (item.status === "opening" || item.status === "active" || item.status === "reconnecting"),
    );
    assert.deepEqual(active, []);
  } finally {
    runtime.setObserver(undefined);
    await runtime.close();
  }

  const restarted = await startMcpRuntime({ dataDir });
  try {
    assert.deepEqual(restarted.restoredSubscriptions, []);
  } finally {
    await restarted.close();
  }
});

async function withAgentConfig(
  t: { after: (fn: () => Promise<void>) => void },
  config: unknown,
): Promise<void> {
  const agentDir = await tempDir(t);
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify(config));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
}

test("restores a persisted active subscription at boot from now, not from its stored cursor", async (t) => {
  const dataDir = await tempDir(t);
  await withAgentConfig(t, {
    mcpServers: {
      stub: { command: process.execPath, args: [resolve("e2e/stub-mcp.mjs")] },
    },
    web: { command: process.execPath, disabled: true },
  });
  const registry = new McpSubscriptionRegistry(dataDir);
  await registry.record(
    subscription({ server: "stub", name: "stub-hub", cursor: "hub:500", status: "active" }),
  );
  await registry.close();

  const lines: string[] = [];
  const log = console.log;
  console.log = (line: unknown) => lines.push(String(line));
  const runtime = await startMcpRuntime({ dataDir });
  try {
    const restored = runtime.restoredSubscriptions;
    assert.equal(restored.length, 1);
    assert.equal(restored[0]?.server, "stub");
    assert.equal(restored[0]?.name, "stub-hub");
    assert.equal(restored[0]?.cursor, null);
    assert.ok(restored[0]?.id);
    assert.ok(lines.some((line) => line.includes("mcp: restored subscription stub/stub-hub")));
  } finally {
    await runtime.close();
    console.log = log;
  }
});

test("keeps an entry whose server was unavailable at boot", async (t) => {
  const dataDir = await tempDir(t);
  await withAgentConfig(t, {
    mcpServers: {
      offline: { command: "/nonexistent/pi-ui-mcp-server" },
    },
    web: { command: process.execPath, disabled: true },
  });
  const registry = new McpSubscriptionRegistry(dataDir);
  await registry.record(
    subscription({ server: "offline", name: "jobs", cursor: "hub:12", status: "reconnecting" }),
  );
  await registry.close();

  const runtime = await startMcpRuntime({ dataDir });
  try {
    assert.deepEqual(runtime.restoredSubscriptions, []);
  } finally {
    await runtime.close();
  }
  const [kept] = await new McpSubscriptionRegistry(dataDir).read();
  assert.equal(kept?.server, "offline");
  assert.equal(kept?.cursor, "hub:12");
  assert.equal(kept?.status, "reconnecting");
});

test("a dead stream stalls on a busy hub and becomes dead after two silent recoveries", async (t) => {
  const dir = await tempDir(t);
  const stableId = deriveStableId("hub", "hub", {});
  const registry = new McpSubscriptionRegistry(dir);
  let now = Date.now();
  const lastPush = new Date(now - 120_000).toISOString();
  await registry.record(
    subscription({
      stableId,
      id: "dead-stream",
      cursor: "hub:10",
      status: "active",
      lastEventAt: lastPush,
      updatedAt: new Date(now).toISOString(),
    }),
  );
  await registry.flush();

  let hubCursor = "hub:20";
  const reopened: Array<{ id: string; cursor: string | null }> = [];
  const watchdog = new McpSubscriptionWatchdog({
    registry,
    now: () => now,
    intervalMs: 15_000,
    stallAfterMs: 60_000,
    poll: async () => ({
      // The hub keeps producing events. A poll must not be mistaken for push
      // traffic, so this cannot reset the silence clock.
      events: [{ event: { cursor: hubCursor, timestamp: new Date(now).toISOString() } }],
    }),
    reopen: async (record, cursor) => {
      reopened.push({ id: record.id ?? "", cursor });
      return { id: "live-stream", cursor, status: "active" };
    },
  });

  try {
    await watchdog.tick();
    assert.deepEqual(reopened, [{ id: "dead-stream", cursor: "hub:20" }]);
    const [first] = await registry.read();
    assert.equal(first?.cursor, "hub:20");
    assert.equal(first?.lastEventAt, lastPush);
    assert.equal(first?.state, "active");
    assert.equal(first?.recoveryPending, true);
    assert.equal(first?.reconnects, 1);

    // Still inside the re-subscribed stream's silence window: no second open,
    // but the poll's server cursor is still persisted.
    hubCursor = "hub:30";
    now += 30_000;
    await watchdog.tick();
    assert.equal(reopened.length, 1);
    const [waiting] = await registry.read();
    assert.equal(waiting?.cursor, "hub:30");
    assert.equal(waiting?.lastEventAt, lastPush);

    // The first re-subscribe never delivered a heartbeat: it counts as a
    // failed recovery, and one more silent re-subscribe is attempted.
    hubCursor = "hub:40";
    now += 30_000;
    await watchdog.tick();
    assert.deepEqual(reopened.at(-1), { id: "live-stream", cursor: "hub:40" });
    assert.equal(reopened.length, 2);
    const [second] = await registry.read();
    assert.equal(second?.cursor, "hub:40");
    assert.equal(second?.recoveryFailures, 1);
    assert.equal(second?.recoveryPending, true);

    // The second re-subscribe is silent too: dead, and no third open.
    hubCursor = "hub:50";
    now += 60_000;
    await watchdog.tick();
    assert.equal(reopened.length, 2);
    const [dead] = await registry.read();
    assert.equal(dead?.cursor, "hub:50");
    assert.equal(dead?.state, "dead");
    assert.equal(dead?.status, "failed");
    assert.equal(dead?.enabled, false);
    assert.equal(dead?.recoveryFailures, 2);
    assert.match(dead?.lastError ?? "", /failed 2 times/);
  } finally {
    await watchdog.close();
    await registry.close();
  }
});

test("a healthy subscription is left alone", async (t) => {
  const dir = await tempDir(t);
  const stableId = deriveStableId("hub", "hub", {});
  const registry = new McpSubscriptionRegistry(dir);
  await registry.record(
    subscription({ stableId, id: "healthy", cursor: "hub:20", status: "active" }),
  );
  await registry.flush();

  let polls = 0;
  const reopened: string[] = [];
  const watchdog = new McpSubscriptionWatchdog({
    registry,
    intervalMs: 60_000,
    poll: async () => {
      polls += 1;
      return { events: [{ event: { cursor: "hub:20" } }] };
    },
    reopen: async (record) => {
      reopened.push(record.id ?? "");
      return null;
    },
  });

  try {
    await watchdog.tick();
    assert.equal(polls, 1);
    assert.deepEqual(reopened, []);
    const [saved] = await registry.read();
    assert.equal(saved?.id, "healthy");
    assert.equal(saved?.cursor, "hub:20");
    assert.equal(saved?.reconnects, undefined);
  } finally {
    await watchdog.close();
    await registry.close();
  }
});

test("a restored historical id stays a replay and never produces a notice", async (t) => {
  const dir = await tempDir(t);
  const stableId = deriveStableId("hub", "hub", {});
  const registry = new McpSubscriptionRegistry(dir);
  await registry.record(
    subscription({
      stableId,
      id: "old-adapter-id",
      cursor: "hub:4",
      status: "active",
      deliveredEventIds: ["event-5"],
    }),
  );
  const feed = new McpEventFeed(registry);
  await feed.hydrate();
  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe", server: "hub", name: "hub", cursor: "hub:4", restored: true },
      result: {
        subscription: {
          id: "s2",
          server: "hub",
          name: "hub",
          status: "active",
          cursor: "hub:4",
          stableId,
        },
      },
    },
  });

  // Event ids are the replay key. A redelivered historical id is stored with
  // the replay mark, and repeating it cannot turn it into a chat notice.
  assert.equal(
    feed.ingest({
      customType: "mcp-events",
      details: { events: [eventItem("hub:3", null, "event-5", "s2")] },
    }),
    false,
  );
  assert.equal(feed.state.events.find((event) => event.id === "event-5")?.replayed, true);
  assert.equal(feed.state.notice, null);
  assert.equal(feed.state.subscriptions[0]?.cursor, "hub:3");

  assert.equal(
    feed.ingest({
      customType: "mcp-events",
      details: { events: [eventItem("hub:4", null, "event-5", "s2")] },
    }),
    false,
  );
  assert.equal(feed.state.events.filter((event) => event.id === "event-5").length, 1);
  assert.equal(feed.state.events.find((event) => event.id === "event-5")?.replayed, true);
  assert.equal(feed.state.notice, null);
  assert.equal(feed.state.subscriptions[0]?.cursor, "hub:4");
  await registry.close();
});

test("a historical id with a null cursor is still a replay, not a live notice", async (t) => {
  const dir = await tempDir(t);
  const stableId = deriveStableId("hub", "hub", {});
  const registry = new McpSubscriptionRegistry(dir);
  await registry.record(
    subscription({
      stableId,
      id: "old-adapter-id",
      cursor: "hub:8",
      status: "active",
      deliveredEventIds: ["event-8"],
    }),
  );
  const feed = new McpEventFeed(registry);
  await feed.hydrate();
  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe", server: "hub", name: "hub", cursor: "hub:8", restored: true },
      result: {
        subscription: {
          id: "s2",
          server: "hub",
          name: "hub",
          status: "active",
          cursor: "hub:8",
          stableId,
        },
      },
    },
  });

  assert.equal(
    feed.ingest({
      customType: "mcp-events",
      details: { events: [eventItem(null, null, "event-8", "s2")] },
    }),
    false,
  );
  assert.equal(feed.state.notice, null);
  assert.equal(feed.state.events.find((event) => event.id === "event-8")?.replayed, true);
  assert.equal(feed.state.subscriptions[0]?.cursor, "hub:8");
  await registry.close();
});

test("a cancellation during an in-flight poll stays cancelled", async (t) => {
  const dir = await tempDir(t);
  const stableId = deriveStableId("hub", "hub", {});
  const registry = new McpSubscriptionRegistry(dir);
  await registry.record(
    subscription({ stableId, id: "dead-stream", cursor: "hub:10", status: "active" }),
  );
  await registry.flush();

  let resolvePoll!: (value: unknown) => void;
  let pollStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    pollStarted = resolve;
  });
  const reopened: string[] = [];
  const lines: string[] = [];
  const watchdog = new McpSubscriptionWatchdog({
    registry,
    intervalMs: 60_000,
    log: (line) => lines.push(line),
    poll: async () => {
      pollStarted();
      return new Promise((resolve) => {
        resolvePoll = resolve;
      });
    },
    reopen: async (_record, cursor) => {
      assert.ok(cursor !== null);
      reopened.push(cursor);
      return { id: "replacement", cursor, status: "active" };
    },
  });

  try {
    const ticking = watchdog.tick();
    await started;
    await registry.cancel(stableId);
    resolvePoll({ events: [{ event: { cursor: "hub:20" } }] });
    await ticking;

    assert.deepEqual(reopened, []);
    assert.deepEqual(lines, []);
    const [saved] = await registry.read();
    assert.equal(saved?.status, "cancelled");
    assert.equal(saved?.enabled, false);
    assert.equal(saved?.id, "dead-stream");
  } finally {
    await watchdog.close();
    await registry.close();
  }
});

test("a cancellation during an in-flight reopen is undone", async (t) => {
  const dir = await tempDir(t);
  const stableId = deriveStableId("hub", "hub", {});
  const registry = new McpSubscriptionRegistry(dir);
  await registry.record(
    subscription({
      stableId,
      id: "dead-stream",
      cursor: "hub:10",
      status: "active",
      lastEventAt: new Date(Date.now() - 120_000).toISOString(),
    }),
  );
  await registry.flush();

  let resolveReopen!: (value: unknown) => void;
  let reopenStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    reopenStarted = resolve;
  });
  const cancelled: Array<{ stableId: string; liveIds: string | readonly string[] | undefined }> =
    [];
  const published: string[] = [];
  const lines: string[] = [];
  const watchdog = new McpSubscriptionWatchdog({
    registry,
    runtime: {
      cancelSubscription: async (id, liveIds) => {
        cancelled.push({ stableId: id, liveIds });
        return null;
      },
    },
    intervalMs: 60_000,
    log: (line) => lines.push(line),
    poll: async () => ({ events: [{ event: { cursor: "hub:20" } }] }),
    reopen: async () => {
      reopenStarted();
      return new Promise((resolve) => {
        resolveReopen = resolve;
      });
    },
    onReopened: (record) => published.push(record.status),
  });

  try {
    const ticking = watchdog.tick();
    await started;
    await registry.cancel(stableId);
    resolveReopen({ id: "replacement", cursor: "hub:20", status: "active" });
    await ticking;

    assert.deepEqual(cancelled, [{ stableId, liveIds: ["replacement"] }]);
    assert.deepEqual(lines, []);
    assert.deepEqual(published, ["active", "cancelled"]);
    const [saved] = await registry.read();
    assert.equal(saved?.status, "cancelled");
    assert.equal(saved?.enabled, false);
    assert.equal(saved?.id, "dead-stream");
  } finally {
    await watchdog.close();
    await registry.close();
  }
});

test("the watchdog stops when the feed closes", async (t) => {
  const dir = await tempDir(t);
  const stableId = deriveStableId("hub", "hub", {});
  const registry = new McpSubscriptionRegistry(dir);
  await registry.record(
    subscription({ stableId, id: "dead-stream", cursor: "hub:10", status: "active" }),
  );
  await registry.flush();

  let polls = 0;
  const watchdog = new McpSubscriptionWatchdog({
    registry,
    intervalMs: 5,
    poll: async () => {
      polls += 1;
      return { events: [{ event: { cursor: "hub:20" } }] };
    },
    reopen: async () => ({ id: "unexpected", cursor: "hub:20", status: "active" }),
  });

  watchdog.start();
  await watchdog.close();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await watchdog.tick();
  assert.equal(polls, 0);
  await registry.close();
});

test("a failed subscription after retry exhaustion is reopened", async (t) => {
  const dir = await tempDir(t);
  const stableId = deriveStableId("hub", "hub", {});
  const registry = new McpSubscriptionRegistry(dir);
  await registry.record(
    subscription({
      stableId,
      id: "exhausted",
      cursor: "hub:10",
      status: "failed",
      enabled: false,
      endReason: "error",
    }),
  );
  await registry.flush();

  const reopened: string[] = [];
  const watchdog = new McpSubscriptionWatchdog({
    registry,
    intervalMs: 60_000,
    poll: async () => ({ events: [{ event: { cursor: "hub:11" } }] }),
    reopen: async (_record, cursor) => {
      assert.ok(cursor !== null);
      reopened.push(cursor);
      return { id: "replacement", cursor, status: "active" };
    },
  });

  try {
    await watchdog.tick();
    assert.deepEqual(reopened, ["hub:11"]);
    const [saved] = await registry.read();
    assert.equal(saved?.status, "active");
    assert.equal(saved?.enabled, true);
    assert.equal(saved?.endReason, undefined);
    assert.equal(saved?.reconnects, 1);
  } finally {
    await watchdog.close();
    await registry.close();
  }
});

test("repeated watchdog ticks reuse one adapter session per server", async (t) => {
  const dataDir = await tempDir(t);
  await withAgentConfig(t, {
    mcpServers: {},
    web: { command: process.execPath, disabled: true },
  });
  const registry = new McpSubscriptionRegistry(dataDir);
  const stableId = deriveStableId("hub", "hub", {});
  await registry.record(
    subscription({ stableId, id: "dead-stream", cursor: "hub:10", status: "active" }),
  );
  await registry.flush();

  const runtime = await startMcpRuntime({ dataDir });
  let connects = 0;
  let requests = 0;
  let closes = 0;
  const controller = new AbortController();
  const session = {
    signal: controller.signal,
    request: async () => {
      requests += 1;
      return { events: [{ event: { cursor: "hub:20" } }] };
    },
    close: () => {
      closes += 1;
    },
  };
  (runtime as unknown as { protocol: unknown }).protocol = {
    connect: async () => {
      connects += 1;
      return session;
    },
    dispose: () => {},
  };
  const watchdog = new McpSubscriptionWatchdog({
    registry,
    runtime,
    intervalMs: 60_000,
    reopen: async (_record, cursor) => ({ id: "replacement", cursor, status: "active" }),
  });

  try {
    await watchdog.tick();
    await watchdog.tick();
    assert.equal(requests, 2);
    assert.equal(connects, 1);
  } finally {
    await watchdog.close();
    await runtime.close();
    await registry.close();
  }
  assert.equal(closes, 1);
});
