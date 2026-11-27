import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { ChatService } from "../src/server/chat-service.js";
import { McpEventFeed, unattributedStatusKey } from "../src/server/mcp-events.js";
import {
  MCP_OUTAGE_NOTIFY_MS,
  OutageQuiet,
  type StatusView,
} from "../src/server/mcp-outage-quiet.js";
import { MCP_RETRY_BUDGET_MS, MCP_SUPERVISE_DEFAULT_MS } from "../src/server/mcp-retry-budget.js";
import { deriveStableId } from "../src/server/mcp-subscriptions.js";
import { buildTranscript } from "../src/server/session.js";
import { MCP_STATUS_HEAD } from "../src/shared/notices.js";

function status(subs: Array<{ id: string; status: string }>): string {
  return `${MCP_STATUS_HEAD}\n${JSON.stringify({ subscriptions: subs })}`;
}

function trackedFeed(
  windowMs: number,
  server = "hub",
  name = "hub",
): {
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
      result: { subscription: { id: "s1", server, name, status: "active" } },
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

test("a reconnecting frame after fresh traffic still draws a chip and starts the clock", () => {
  const { feed, now, advance } = trackedFeed(150);
  const stableId = deriveStableId("hub", "hub", {});
  const down = status([{ id: "s1", status: "reconnecting" }]);
  const up = status([{ id: "s1", status: "active" }]);
  feed.ingest({
    customType: "mcp-events-traffic",
    details: {
      subscription_id: "s1",
      server: "hub",
      cursor: "hub:1",
      timestamp: new Date(now()).toISOString(),
    },
  });

  feed.ingest({
    customType: "mcp-events-status",
    details: JSON.parse(down.slice(MCP_STATUS_HEAD.length + 1)),
  });
  assert.equal(feed.filterStatusNotice(down).mode, "chip");
  assert.equal(feed.isOutageEscalated(stableId), false);

  advance(150);
  assert.equal(feed.takeOutageEscalation(stableId), down, "fresh traffic cannot silence the clock");

  feed.ingest({
    customType: "mcp-events-status",
    details: JSON.parse(up.slice(MCP_STATUS_HEAD.length + 1)),
  });
  assert.equal(feed.filterStatusNotice(up).mode, "deliver");
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

function statusChat(feed: McpEventFeed): {
  chat: ChatService;
  entries: EntryRecord[];
  submitted: string[];
} {
  const entries: EntryRecord[] = [];
  const submitted: string[] = [];
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
  ).submit = async (text, _mode, options) => {
    submitted.push(text);
    if (options?.entry !== undefined) append(options.entry.kind, options.entry.data);
    return {};
  };
  return { chat, entries, submitted };
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

test("a second escalated outage and its recovery still keep the one chip", async () => {
  const { feed, advance } = trackedFeed(150);
  const stableId = deriveStableId("hub", "hub", {});
  const down = status([{ id: "s1", status: "reconnecting" }]);
  const up = status([{ id: "s1", status: "active" }]);
  const downDetails = JSON.parse(down.slice(MCP_STATUS_HEAD.length + 1));
  const upDetails = JSON.parse(up.slice(MCP_STATUS_HEAD.length + 1));
  const { chat, entries } = statusChat(feed);

  for (const cycle of [1, 2]) {
    feed.ingest({ customType: "mcp-events-status", details: downDetails });
    assert.equal(feed.filterStatusNotice(down).mode, "chip", `cycle ${cycle} starts a chip`);
    advance(150);
    const escalated = feed.takeOutageEscalation(stableId);
    assert.equal(escalated, down, `cycle ${cycle} speaks once after the window`);
    await chat.recordMcpStatusChip(down);
    await chat.submitMcpEventNotice(escalated ?? "", undefined, { bypassGate: true });

    feed.ingest({ customType: "mcp-events-status", details: upDetails });
    assert.equal(feed.filterStatusNotice(up).mode, "deliver", `cycle ${cycle} recovery speaks`);
    await chat.submitMcpDelivery({
      id: `recovery-${cycle}`,
      text: up,
      at: new Date(Date.now() + cycle * 1_000).toISOString(),
    });
  }

  const expectedId = `mcp/status#${stableId}`;
  assert.equal(
    entries.every((entry) => (entry.data as { noticeId?: string }).noticeId === expectedId),
    true,
    "the chip, both escalations and both recoveries name the same notice row",
  );
  const transcript = buildTranscript(entries);
  assert.equal(transcript.messages.length, 1, "two full cycles leave one chip");
  assert.equal(transcript.messages[0]?.text, up, "the one chip ends on active");
  await chat.close();
});

test("repeated adapter prose is a chip and never starts a turn", async () => {
  const { feed, advance } = trackedFeed(60_000, "ntfy-mcp", "ntfy-mcp");
  const prose = `${MCP_STATUS_HEAD}\nntfy-mcp: MCP request stream ended without a final response`;
  assert.equal(unattributedStatusKey(prose), "unattributed:ntfy-mcp");
  assert.equal(
    unattributedStatusKey(`${MCP_STATUS_HEAD}\nntfy-mcp/topic: MCP request stream ended`),
    "unattributed:ntfy-mcp/topic",
  );
  const { chat, entries, submitted } = statusChat(feed);

  for (let repeat = 0; repeat < 3; repeat++) {
    const gate = feed.filterStatusNotice(prose, undefined, "mcp-ui-status");
    assert.equal(gate.mode, "chip", `repeat ${repeat + 1} is display history`);
    assert.equal(gate.text, prose);
    await chat.recordMcpStatusChip(gate.text);
    advance(10_000);
  }

  assert.deepEqual(submitted, [], "adapter prose never becomes a model turn");
  assert.deepEqual(
    entries.map((entry) => (entry.data as { noticeId?: string }).noticeId),
    Array.from({ length: 3 }, () => "mcp/status#unattributed:ntfy-mcp"),
    "every repeat updates the one unattributed row",
  );
  const transcript = buildTranscript(entries);
  assert.equal(transcript.messages.length, 1, "three repeats leave one visible chip");
  assert.equal(transcript.messages[0]?.text, prose);
  await chat.close();
});

test("a restore gap still reaches the model", () => {
  const { feed } = trackedFeed(60_000);
  const text = `${MCP_STATUS_HEAD}\nSome events were missed while pi was not running (from hub:1 since 2026-11-21T13:27:01.126Z).`;
  const gate = feed.filterStatusNotice(
    text,
    { kind: "restore-gap", server: "hub", name: "hub", count: 0 },
    "mcp-events-gap",
  );

  assert.equal(gate.mode, "deliver");
  assert.equal(gate.text, text);
  assert.equal(
    feed.filterStatusNotice(text).mode,
    "deliver",
    "gap prose needs no metadata to deliver",
  );
});

test("exhaustion prose for an untracked server is still dropped", () => {
  const { feed } = trackedFeed(60_000);
  const gate = feed.filterStatusNotice(
    `${MCP_STATUS_HEAD}\nzeroshot: Reconnect attempts exhausted: MCP connection or session ended`,
    undefined,
    "mcp-ui-status",
  );

  assert.equal(gate.mode, "drop");
});

test("a non-status notice passes through unchanged", () => {
  const { feed } = trackedFeed(60_000);
  const text = "a plain notice without a status head";
  const gate = feed.filterStatusNotice(text);

  assert.equal(gate.mode, "deliver");
  assert.equal(gate.text, text);
});

test("a self-healed runtime session is one chip that never starts a turn", async () => {
  const { feed, advance } = trackedFeed(60_000, "tracer", "tracer");
  const text = `${MCP_STATUS_HEAD}\nmcp tracer: session lost (http404), re-initialized, tool list refreshed`;
  assert.equal(unattributedStatusKey(text), "unattributed:tracer");
  const { chat, entries, submitted } = statusChat(feed);

  for (let repeat = 0; repeat < 3; repeat++) {
    const gate = feed.filterStatusNotice(text, undefined, "mcp-recovery");
    assert.equal(gate.mode, "chip", `repeat ${repeat + 1} is display state`);
    assert.equal(gate.text, text, "the chip keeps the runtime's words verbatim");
    await chat.recordMcpStatusChip(gate.text);
    advance(20_000);
  }

  assert.deepEqual(submitted, [], "a self-healed reconnect never becomes a model turn");
  assert.deepEqual(
    entries.map((entry) => (entry.data as { noticeId?: string }).noticeId),
    Array.from({ length: 3 }, () => "mcp/status#unattributed:tracer"),
    "every repeat updates the one unattributed row",
  );
  const transcript = buildTranscript(entries);
  assert.equal(transcript.messages.length, 1, "three repeats leave one visible chip");
  assert.equal(transcript.messages[0]?.text, text);
  await chat.close();
});

test("a truncation warning and the events envelope still reach the model", () => {
  const { feed } = trackedFeed(60_000);
  const truncated = `${MCP_STATUS_HEAD}\nhub: replay is truncated for hub; some events are unavailable.`;
  assert.equal(feed.filterStatusNotice(truncated).mode, "deliver");

  const envelope = `${MCP_STATUS_HEAD}\n${JSON.stringify({ events: [], dropped_events: 0 })}`;
  assert.equal(feed.filterStatusNotice(envelope, undefined, "mcp-events").mode, "deliver");

  const gapDetails = { kind: "restore-gap", server: "hub", name: "hub", count: 0 };
  assert.equal(
    feed.filterStatusNotice(`${MCP_STATUS_HEAD}\nnothing to replay yet`, gapDetails).mode,
    "deliver",
    "details.kind restore-gap delivers without gap prose",
  );
});

test("the allow-listed senders stay chips and a live supersession still drops", () => {
  const { feed, now } = trackedFeed(60_000);
  const prose = `${MCP_STATUS_HEAD}\nhub: s1 is failed.`;

  for (const customType of [undefined, "mcp-ui-status", "mcp-events-status"]) {
    const gate = feed.filterStatusNotice(prose, undefined, customType);
    assert.equal(gate.mode, "chip", `customType ${customType ?? "undefined"} is display state`);
    assert.equal(gate.text, prose);
  }

  feed.ingest({
    customType: "mcp-events-traffic",
    details: {
      subscription_id: "s1",
      server: "hub",
      cursor: "hub:1",
      timestamp: new Date(now()).toISOString(),
    },
  });
  const exhaustion = `${MCP_STATUS_HEAD}\nhub: Reconnect attempts exhausted: MCP connection or session ended`;
  assert.equal(
    feed.filterStatusNotice(exhaustion, undefined, "mcp-ui-status").mode,
    "drop",
    "a live generation already serves this prose",
  );
});

test("a retry inside the shipped window stays silent", () => {
  const { feed, advance } = trackedFeed(MCP_OUTAGE_NOTIFY_MS);
  const stableId = deriveStableId("hub", "hub", {});
  const down = status([{ id: "s1", status: "reconnecting" }]);
  const up = status([{ id: "s1", status: "active" }]);
  feed.ingest({
    customType: "mcp-events-status",
    details: JSON.parse(down.slice(MCP_STATUS_HEAD.length + 1)),
  });

  assert.equal(feed.filterStatusNotice(down).mode, "chip", "the cut is first a chip");
  advance(60_000);
  assert.equal(feed.filterStatusNotice(down).mode, "chip", "a 60 s retry is still a chip");
  assert.equal(feed.takeOutageEscalation(stableId), null, "the ladder is still spending time");
  assert.equal(feed.isOutageEscalated(stableId), false);

  advance(1_000);
  feed.ingest({
    customType: "mcp-events-status",
    details: JSON.parse(up.slice(MCP_STATUS_HEAD.length + 1)),
  });
  assert.equal(feed.filterStatusNotice(up).mode, "chip", "the heal updates the same chip");
  assert.equal(feed.isOutageEscalated(stableId), false, "the outage never reached the model");
});

test("an exhausted ladder speaks once and leaves one recovery", async () => {
  const { feed } = trackedFeed(MCP_OUTAGE_NOTIFY_MS);
  const stableId = deriveStableId("hub", "hub", {});
  const stall = `${MCP_STATUS_HEAD}\nhub/hub is stalled: temporary stream cut (since 2026-01-01T00:00:00.000Z)`;
  const stallDetails = {
    subscriptions: [{ stableId, server: "hub", name: "hub", status: "failed", state: "stalled" }],
  };
  const up = status([{ id: "s1", status: "active" }]);
  const { chat, entries, submitted } = statusChat(feed);

  feed.ingest({ customType: "mcp-recovery", details: stallDetails });
  const spoken = feed.filterStatusNotice(stall, stallDetails, "mcp-recovery");
  assert.equal(spoken.mode, "deliver", "a stalled frame is an exhausted ladder, not a retry");
  await chat.submitMcpEventNotice(spoken.text, undefined, { bypassGate: true });
  assert.equal(feed.takeOutageEscalation(stableId), null, "the chat timer cannot speak twice");

  const repeat = feed.filterStatusNotice(stall, stallDetails, "mcp-recovery");
  assert.equal(repeat.mode, "chip", "the exhausted episode spoke already");
  await chat.recordMcpStatusChip(repeat.text);

  feed.ingest({
    customType: "mcp-events-status",
    details: JSON.parse(up.slice(MCP_STATUS_HEAD.length + 1)),
  });
  const recovery = feed.filterStatusNotice(up);
  assert.equal(recovery.mode, "deliver", "the following active frame is the one recovery");
  await chat.submitMcpDelivery({
    id: "recovery-1",
    text: recovery.text,
    at: new Date().toISOString(),
  });
  assert.equal(feed.filterStatusNotice(up).mode, "drop", "the recovery speaks exactly once");

  assert.deepEqual(submitted, [stall, up], "one stall turn and one recovery turn");
  assert.deepEqual(
    entries.map((entry) => (entry.data as { noticeId?: string }).noticeId),
    Array.from({ length: 3 }, () => `mcp/status#${stableId}`),
  );
  const transcript = buildTranscript(entries);
  assert.equal(transcript.messages.length, 1, "the stall and its recovery keep one chip");
  assert.equal(transcript.messages[0]?.text, up);
  await chat.close();
});

test("a stalled stream's recovery is not superseded by its replacement adapter id", () => {
  const { feed } = trackedFeed(MCP_OUTAGE_NOTIFY_MS);
  const stableId = deriveStableId("hub", "hub", {});
  const stall = `${MCP_STATUS_HEAD}\nhub/hub is stalled: temporary stream cut (since t0)`;
  const stallDetails = {
    subscriptions: [
      {
        id: "s1",
        stableId,
        server: "hub",
        name: "hub",
        status: "failed",
        state: "stalled",
      },
    ],
  };
  const recovered = `${MCP_STATUS_HEAD}\nhub/hub is active again at hub:9 (recovered after stall since t0)`;
  const recoveredDetails = {
    subscriptions: [{ id: "s2", stableId, server: "hub", name: "hub", status: "active" }],
  };

  feed.ingest({ customType: "mcp-recovery", details: stallDetails });
  assert.equal(feed.filterStatusNotice(stall, stallDetails, "mcp-recovery").mode, "deliver");
  assert.equal(
    feed.filterStatusNotice(recovered, recoveredDetails, "mcp-recovery").mode,
    "deliver",
    "the runtime's recovery is not the superseded generation",
  );
  assert.equal(
    feed.filterStatusNotice(recovered, recoveredDetails, "mcp-recovery").mode,
    "drop",
    "the recovery still speaks exactly once",
  );
});

test("the outbox identity pass keeps the runtime's stall and recovery", () => {
  const { feed } = trackedFeed(MCP_OUTAGE_NOTIFY_MS);
  const stableId = deriveStableId("hub", "hub", {});
  const stall = `${MCP_STATUS_HEAD}\nhub/hub is stalled: temporary stream cut (since t0)`;
  feed.ingest({
    customType: "mcp-recovery",
    details: {
      subscriptions: [{ id: "s1", stableId, server: "hub", name: "hub", status: "failed" }],
    },
  });
  assert.equal(
    feed.filterStatusIdentityNotice(stall),
    stall,
    "naming the durable id is not a superseded generation",
  );

  const recovered = `${MCP_STATUS_HEAD}\nhub/hub is active again at hub:9 (recovered after stall since t0)`;
  feed.ingest({
    customType: "mcp-events-status",
    details: JSON.parse(status([{ id: "s2", status: "active" }]).slice(MCP_STATUS_HEAD.length + 1)),
  });
  assert.equal(
    feed.filterStatusIdentityNotice(recovered),
    recovered,
    "the replacement adapter id does not make the recovery noise",
  );
});

test("the shipped window covers the supervisor's whole retry ladder", () => {
  assert.equal(MCP_RETRY_BUDGET_MS, 135_000, "5 + 10 + 20 + 40 + 60 seconds");
  assert.ok(
    MCP_OUTAGE_NOTIFY_MS >= MCP_RETRY_BUDGET_MS,
    "the window must outlast the ladder it waits on",
  );
  if (process.env.PI_UI_MCP_OUTAGE_NOTIFY_MS === undefined) {
    assert.equal(MCP_OUTAGE_NOTIFY_MS, MCP_RETRY_BUDGET_MS + 2 * MCP_SUPERVISE_DEFAULT_MS);
  }

  const quiet = new OutageQuiet(() => 0);
  const stableId = deriveStableId("hub", "hub", {});
  const retry: StatusView = { stableId, status: "reconnecting", text: "down" };
  assert.deepEqual(quiet.observe([retry], 0).chips, ["down"]);
  assert.deepEqual(quiet.observe([retry], 60_000).escalations, []);
  assert.equal(quiet.escalate(stableId, 60_000), null, "a 60 s retry is inside the ladder");
  assert.deepEqual(quiet.observe([retry], 195_000).escalations, ["down"]);
  assert.equal(quiet.escalate(stableId, 195_000), null, "an episode speaks once");
});

test("a stalled frame escalates even when it is the first frame of its episode", () => {
  const quiet = new OutageQuiet(() => 1_000);
  const stableId = deriveStableId("hub", "hub", {});
  const stalled: StatusView = { stableId, status: "down", text: "stalled", state: "stalled" };

  const first = quiet.observe([stalled], 1_000);
  assert.deepEqual(first.escalations, ["stalled"]);
  assert.deepEqual(quiet.observe([stalled], 1_000).escalations, [], "one turn per episode");
  assert.equal(quiet.escalate(stableId, 200_000), null, "a later timer is idempotent");
});
