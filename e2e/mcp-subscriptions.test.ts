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

function eventItem(cursor: string | null, payloadCursor?: string | null, eventId = cursor ?? "e") {
  return {
    subscription_id: "s1",
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

test("drops an event at or below the high-water mark", () => {
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
  const before = feed.state;
  for (const cursor of ["hub:837", "hub:836", "hub:1"]) {
    assert.equal(
      feed.ingest({ customType: "mcp-events", details: { events: [eventItem(cursor)] } }),
      false,
    );
  }
  assert.deepEqual(feed.state, before);

  assert.equal(
    feed.ingest({ customType: "mcp-events", details: { events: [eventItem("hub:838")] } }),
    true,
  );
  assert.equal(feed.state.subscriptions[0]?.cursor, "hub:838");
  assert.equal(feed.state.events.length, 1);
});

test("coalesces a replay burst into one skipped notice and no turn", () => {
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
  feed.ingest({
    customType: "mcp-events",
    details: { events: [eventItem("hub:59", null, "new")] },
  });
  const before = feed.state;

  const burst = Array.from({ length: 16 }, (_, index) =>
    eventItem(`hub:${index + 2}`, null, `${index + 2}`),
  );
  const revision = before.revision;
  const notice = before.notice;
  assert.equal(feed.ingest({ customType: "mcp-events", details: { events: burst } }), false);
  assert.equal(feed.state.revision, revision);
  assert.equal(feed.state.notice, notice);
  assert.equal(feed.state.events.length, before.events.length);

  // The same decision gates pi-mcp-events' follow-up message, so a pure
  // replay cannot start a turn.
  const shim = new DurableExtensionShim();
  const submitted: string[] = [];
  shim.setObserver(() => false);
  shim.setMessageSink((text) => submitted.push(text));
  shim.sendMessage({ customType: "mcp-events", content: "replay", details: { events: burst } });
  assert.deepEqual(submitted, []);

  // A flush that also has news is delivered once and names the replay count.
  assert.equal(
    feed.ingest({
      customType: "mcp-events",
      details: { events: [...burst, eventItem("hub:60", null, "60")] },
    }),
    true,
  );
  assert.equal(feed.state.notice, "replayed 16 event(s) from hub, skipped");
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
      cursor: "hub:1",
      status: "active",
      deliveredEventIds: ["event-1"],
    }),
  );
  const feed = new McpEventFeed(registry);
  await feed.hydrate();
  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe", server: "hub", name: "hub", cursor: "hub:1" },
      result: {
        subscription: {
          id: "s2",
          server: "hub",
          name: "hub",
          status: "active",
          cursor: "hub:1",
          stableId,
        },
      },
    },
  });
  const before = feed.state.notice;

  assert.equal(
    feed.ingest({
      customType: "mcp-events",
      details: { events: [eventItem("hub:1", null, "event-1")] },
    }),
    false,
  );
  const replay = feed.state.events.find((event) => event.id === "event-1");
  assert.equal(replay?.replayed, true);
  assert.equal(feed.state.notice, before);

  assert.equal(
    feed.ingest({
      customType: "mcp-events",
      details: { events: [eventItem("hub:2", null, "event-2")] },
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
      details: { events: [eventItem("hub:7", null, "event-7")] },
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

test("restores a persisted active subscription at boot with its stored cursor", async (t) => {
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
    assert.ok(lines.includes("mcp: restored subscription stub/stub-hub at hub:500"));
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
