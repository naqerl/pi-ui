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
  hasPosition,
  type McpSubscriptionRecord,
  McpSubscriptionRegistry,
} from "../src/server/mcp-subscriptions.js";

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
  // The delivered set records a committed chip, not merely an observed event.
  feed.markDelivered([eventItem("hub:7", null, "event-7")]);
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

test("restores a persisted active subscription from its acknowledged cursor", async (t) => {
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
    assert.equal(restored[0]?.cursor, "hub:500");
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

test("two rows for one server and name load as the newer subscription", async (t) => {
  const dir = await tempDir(t);
  const older = subscription({
    server: "zeroshot",
    name: "hub",
    arguments: { stream: "snapshot" },
    cursor: "hub:snapshot:2:1382",
    status: "failed",
    enabled: false,
    updatedAt: "2026-11-08T20:00:00.000Z",
    deliveredEventIds: [],
  });
  const newer = subscription({
    server: "zeroshot",
    name: "hub",
    arguments: {},
    cursor: "hub:328",
    status: "reconnecting",
    updatedAt: "2026-11-08T21:00:00.000Z",
    lastEventAt: "2026-11-08T21:05:00.000Z",
    deliveredEventIds: ["hub:327"],
  });
  await writeFile(
    join(dir, "mcp-subscriptions.json"),
    JSON.stringify({ version: 1, subscriptions: [older, newer] }),
  );

  const lines: string[] = [];
  const registry = new McpSubscriptionRegistry(dir, { log: (line) => lines.push(line) });
  const records = await registry.read();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.cursor, "hub:328");
  assert.equal(records[0]?.status, "reconnecting");
  assert.deepEqual(records[0]?.deliveredEventIds, ["hub:327"]);
  assert.equal(
    lines.filter((line) => line.includes("duplicate subscription")).length,
    1,
    "the drop is logged once",
  );
  await registry.close();

  const document = JSON.parse(await readFile(join(dir, "mcp-subscriptions.json"), "utf8")) as {
    subscriptions: McpSubscriptionRecord[];
  };
  assert.equal(document.subscriptions.length, 1);
  assert.equal(document.subscriptions[0]?.cursor, "hub:328");
});

test("same-argument rows keep the newer live subscription over a failed one", async (t) => {
  const dir = await tempDir(t);
  const failed = subscription({
    server: "zeroshot",
    name: "hub",
    arguments: {},
    cursor: "hub:snapshot:2:1382",
    status: "failed",
    enabled: false,
    updatedAt: "2026-11-08T20:00:00.000Z",
    deliveredEventIds: [],
  });
  const reconnecting = subscription({
    server: "zeroshot",
    name: "hub",
    arguments: {},
    cursor: "hub:328",
    status: "reconnecting",
    updatedAt: "2026-11-08T21:00:00.000Z",
    lastEventAt: "2026-11-08T21:05:00.000Z",
    deliveredEventIds: ["hub:327"],
  });
  await writeFile(
    join(dir, "mcp-subscriptions.json"),
    JSON.stringify({ version: 1, subscriptions: [failed, reconnecting] }),
  );

  const registry = new McpSubscriptionRegistry(dir, { log: () => {} });
  const records = await registry.read();
  assert.equal(records.length, 1);
  assert.equal(records[0]?.status, "reconnecting");
  assert.equal(records[0]?.cursor, "hub:328");
  assert.deepEqual(records[0]?.deliveredEventIds, ["hub:327"]);
  await registry.close();
});

test("a zero cursor is not a position", () => {
  for (const cursor of [null, undefined, "", "hub:0", "x:0", "prefix:0", "hub:0:0"]) {
    assert.equal(hasPosition(cursor), false, `${String(cursor)} is no position`);
  }
  for (const cursor of ["hub:361", "x:1", "hub:snapshot:2:1382", "start"]) {
    assert.equal(hasPosition(cursor), true, `${cursor} is a position`);
  }
});

test("restores a zero cursor from now and keeps a real cursor", async (t) => {
  await withAgentConfig(t, {
    mcpServers: {
      stub: { command: process.execPath, args: [resolve("e2e/stub-mcp.mjs")] },
    },
    web: { command: process.execPath, disabled: true },
  });

  for (const [stored, sent] of [
    ["hub:0", null],
    ["hub:361", "hub:361"],
  ] as const) {
    const dataDir = await tempDir(t);
    const runtime = await startMcpRuntime({ dataDir });
    const lines: string[] = [];
    const log = console.log;
    try {
      const calls: Record<string, unknown>[] = [];
      const original = runtime.shim.callTool.bind(runtime.shim);
      runtime.shim.callTool = async (name, params, signal) => {
        const request =
          typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
        if (name === "mcp_events" && request.action === "subscribe") calls.push(request);
        return original(name, params, signal);
      };
      await runtime.subscriptionRegistry?.record(
        subscription({ server: "stub", name: "stub-hub", cursor: stored, status: "active" }),
      );
      console.log = (line: unknown) => lines.push(String(line));
      await runtime.restoreSubscriptions();
      const subscribe = calls.find((call) => call.action === "subscribe");
      assert.equal(subscribe?.cursor, sent, `stored ${stored} subscribes at ${String(sent)}`);
      if (stored === "hub:0") {
        assert.ok(
          lines.includes("mcp: stub/stub-hub restarted from now (stored cursor hub:0)"),
          "a start-in-now is logged once",
        );
      } else {
        assert.ok(
          !lines.some((line) => line.includes("restarted from now")),
          "a real cursor does not claim a restart",
        );
      }
    } finally {
      console.log = log;
      await runtime.close();
    }
  }
});

test("a restore stores the cursor the server answered with", async (t) => {
  await withAgentConfig(t, {
    mcpServers: {
      stub: { command: process.execPath, args: [resolve("e2e/stub-mcp.mjs")] },
    },
    web: { command: process.execPath, disabled: true },
  });
  const dataDir = await tempDir(t);
  const runtime = await startMcpRuntime({ dataDir });
  try {
    const original = runtime.shim.callTool.bind(runtime.shim);
    runtime.shim.callTool = async (name, params, signal) => {
      const request =
        typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
      if (name === "mcp_events" && request.action === "subscribe") {
        return {
          content: [],
          details: {
            subscription: {
              id: "server-answer",
              server: "stub",
              name: "stub-hub",
              status: "active",
              cursor: "hub:777",
            },
          },
        };
      }
      return original(name, params, signal);
    };
    await runtime.subscriptionRegistry?.record(
      subscription({ server: "stub", name: "stub-hub", cursor: "hub:0", status: "active" }),
    );
    await runtime.restoreSubscriptions();
    assert.equal(runtime.restoredSubscriptions[0]?.cursor, "hub:777");
    const [saved] = (await runtime.subscriptionRegistry?.read()) ?? [];
    assert.equal(saved?.cursor, "hub:777");
  } finally {
    await runtime.close();
  }
});

test("reopenSubscription returns the server's cursor, not its argument", async (t) => {
  await withAgentConfig(t, {
    mcpServers: {
      stub: { command: process.execPath, args: [resolve("e2e/stub-mcp.mjs")] },
    },
    web: { command: process.execPath, disabled: true },
  });
  const dataDir = await tempDir(t);
  const runtime = await startMcpRuntime({ dataDir });
  try {
    const calls: Record<string, unknown>[] = [];
    const original = runtime.shim.callTool.bind(runtime.shim);
    runtime.shim.callTool = async (name, params, signal) => {
      const request =
        typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
      if (name === "mcp_events" && request.action === "subscribe") {
        calls.push(request);
        return {
          content: [],
          details: {
            subscription: {
              id: "server-answer",
              server: "stub",
              name: "stub-hub",
              status: "active",
              cursor: "hub:999",
            },
          },
        };
      }
      return original(name, params, signal);
    };

    const resumed = await runtime.reopenSubscription(
      subscription({ id: "old", server: "stub", name: "stub-hub", cursor: "hub:361" }),
      "hub:361",
    );
    assert.equal(calls.at(-1)?.cursor, "hub:361", "a real cursor still resumes");
    assert.equal(resumed.cursor, "hub:999", "the returned cursor is the server's");

    const restarted = await runtime.reopenSubscription(
      subscription({ id: "old", server: "stub", name: "stub-hub", cursor: "hub:0" }),
      "hub:0",
    );
    assert.equal(calls.at(-1)?.cursor, null, "a zero cursor starts in now");
    assert.equal(restarted.cursor, "hub:999");
  } finally {
    await runtime.close();
  }
});
