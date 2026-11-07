import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EventsView } from "../src/client/EventsView.js";
import {
  type DashboardHost,
  DashboardManager,
  parseChart,
  parseWidget,
} from "../src/server/dashboard.js";
import { type PollOutcome, type PollRun, runPollScript } from "../src/server/dashboard-runner.js";
import { createDashboardTools } from "../src/server/dashboard-tools.js";
import { taskDurationStats } from "../src/server/tasks.js";
import {
  type DashboardState,
  evalPath,
  MCP_EVENT_LIMIT,
  MCP_EVENT_WIDGET_LIMIT,
  maskSecrets,
  renderWidget,
  validateMapping,
  type Widget,
} from "../src/shared/dashboard.js";
import { DEFAULT_DASHBOARD, defaultDashboardConfig } from "../src/shared/dashboard-default.js";
import {
  type BuiltinInputs,
  type BuiltinName,
  listSources,
  readSource,
} from "../src/shared/dashboard-sources.js";
import { formatTime } from "../src/shared/time.js";
import type { Task } from "../src/shared/types.js";

const dirs: string[] = [];
let http: Server;
let base = "";

before(async () => {
  http = createServer((req, res) => {
    if (req.url === "/servers") {
      if (req.headers.authorization !== "Bearer test-hcloud-token-123") {
        res.writeHead(401).end("{}");
        return;
      }
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          servers: [
            { name: "web-1", status: "running", server_type: { name: "cx22" } },
            { name: "db-1", status: "off", server_type: { name: "cx32" } },
          ],
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => http.close(() => resolve()));
  for (const dir of dirs) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-dash-"));
  dirs.push(dir);
  return dir;
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function widget(partial: Partial<Widget> & Pick<Widget, "kind" | "mapping">): Widget {
  return { id: "w", title: "W", source: { type: "static" }, ...partial } as Widget;
}

// ── mapping ──────────────────────────────────────────────────────────────

test("path expressions pick fields, map arrays and index from either end", () => {
  const data = {
    servers: [
      { name: "a", net: { ip: "1.1.1.1" } },
      { name: "b", net: { ip: "2.2.2.2" } },
    ],
    "odd key": 7,
  };
  assert.deepEqual(evalPath(data, "servers[].name"), ["a", "b"]);
  assert.deepEqual(evalPath(data, "servers[].net.ip"), ["1.1.1.1", "2.2.2.2"]);
  assert.equal(evalPath(data, "servers[0].name"), "a");
  assert.equal(evalPath(data, "servers[-1].name"), "b");
  assert.equal(evalPath(data, "servers.length"), 2);
  assert.equal(evalPath(data, '["odd key"]'), 7);
  assert.equal(evalPath(data, "$"), data);
  assert.equal(evalPath(data, "missing.deep"), undefined);
});

test("widgets render each kind from mapped data", () => {
  const data = {
    total: 1234.5678,
    change: 3,
    servers: [
      { name: "web-1", status: "running", type: "cx22" },
      { name: "db-1", status: "off", type: "cx32" },
      { name: "old", status: "error", type: "cx11" },
    ],
  };
  assert.deepEqual(
    renderWidget(
      widget({ kind: "stat", mapping: { value: "total", label: "=servers", delta: "change" } }),
      data,
    ),
    { kind: "stat", value: "1,234.5678", label: "servers", delta: "+3", trend: "up" },
  );
  assert.deepEqual(
    renderWidget(
      widget({
        kind: "table",
        mapping: { rows: "servers", columns: { Name: "name", Type: "type" } },
      }),
      data,
    ),
    {
      kind: "table",
      columns: ["Name", "Type"],
      rows: [
        ["web-1", "cx22"],
        ["db-1", "cx32"],
        ["old", "cx11"],
      ],
    },
  );
  assert.deepEqual(
    renderWidget(widget({ kind: "table", mapping: { columns: { Name: "servers[].name" } } }), data),
    { kind: "table", columns: ["Name"], rows: [["web-1"], ["db-1"], ["old"]] },
  );
  const status = renderWidget(
    widget({ kind: "status", mapping: { items: "servers", label: "name", state: "status" } }),
    data,
  );
  assert.deepEqual(status.kind === "status" ? status.items.map((item) => item.state) : [], [
    "ok",
    "warn",
    "error",
  ]);
  assert.deepEqual(
    renderWidget(
      widget({ kind: "list", mapping: { items: "servers", label: "name", value: "status" } }),
      data,
    ),
    {
      kind: "list",
      items: [
        { label: "web-1", value: "running" },
        { label: "db-1", value: "off" },
        { label: "old", value: "error" },
      ],
    },
  );
  assert.deepEqual(
    renderWidget(widget({ kind: "sparkline", mapping: { value: "change" } }), data, [1, 2]),
    { kind: "sparkline", points: [1, 2, 3], value: "3" },
  );
  assert.deepEqual(renderWidget(widget({ kind: "markdown", mapping: { text: "=**hi**" } }), data), {
    kind: "markdown",
    text: "**hi**",
  });
});

test("mappings are checked against the kind", () => {
  assert.throws(() => validateMapping("stat", {}), /value/);
  assert.throws(() => validateMapping("table", { columns: "name" }), /columns/);
  assert.throws(() => validateMapping("list", { items: "x", colour: "red" }), /colour/);
  validateMapping("status", { state: "status" });
  validateMapping("sparkline", { series: "series", labels: "labels" });
});

test("sparkline mappings render legacy, named and gapped series with labels", () => {
  assert.deepEqual(
    renderWidget(widget({ kind: "sparkline", mapping: { series: "values" } }), {
      values: [2, 5, 3],
    }),
    { kind: "sparkline", points: [2, 5, 3], value: "3" },
  );
  assert.deepEqual(
    renderWidget(widget({ kind: "sparkline", mapping: { series: "series", labels: "labels" } }), {
      series: { actual: [1, 2], projection: [3, 4, 5] },
      labels: ["Mon", "Tue", "Wed", "Thu"],
    }),
    {
      kind: "sparkline",
      labels: ["Mon", "Tue", "Wed"],
      series: [
        { key: "actual", points: [1, 2] },
        { key: "projection", points: [3, 4, 5] },
      ],
      value: "2",
    },
  );
  assert.deepEqual(
    renderWidget(widget({ kind: "sparkline", mapping: { series: "series", labels: "labels" } }), {
      series: [
        { key: "actual", label: "Actual", points: [1, null, 3] },
        { key: "estimate", points: [2, 4, null] },
      ],
      labels: ["a", "b", "c"],
    }),
    {
      kind: "sparkline",
      labels: ["a", "b", "c"],
      series: [
        { key: "actual", label: "Actual", points: [1, null, 3] },
        { key: "estimate", points: [2, 4, null] },
      ],
      value: "3",
    },
  );
});

test("sparkline headlines can be mapped explicitly or suppressed", () => {
  const data = {
    values: [2, 5, 3],
    series: { actual: [1, 2], projection: [3, 4, 5] },
    headline: "€1.70 accrued · €20.44 projected",
    total: 1234.5,
  };
  const series = [
    { key: "actual", points: [1, 2] },
    { key: "projection", points: [3, 4, 5] },
  ];
  assert.deepEqual(
    renderWidget(
      widget({
        kind: "sparkline",
        mapping: { series: "series", value: "headline", label: "=Spend" },
      }),
      data,
    ),
    { kind: "sparkline", label: "Spend", series, value: "€1.70 accrued · €20.44 projected" },
  );
  assert.deepEqual(
    renderWidget(
      widget({ kind: "sparkline", mapping: { series: "series", value: "total" } }),
      data,
    ),
    { kind: "sparkline", series, value: "1,234.5" },
  );
  assert.deepEqual(
    renderWidget(widget({ kind: "sparkline", mapping: { series: "series" } }), data),
    { kind: "sparkline", series, value: "2" },
  );
  assert.deepEqual(
    renderWidget(
      widget({ kind: "sparkline", mapping: { series: "series", value: "=", label: "=Spend" } }),
      data,
    ),
    { kind: "sparkline", label: "Spend", series },
  );
  assert.deepEqual(
    renderWidget(widget({ kind: "sparkline", mapping: { value: "=" } }), data, [1, 2]),
    { kind: "sparkline", points: [1, 2] },
  );
});

test("parseChart accepts the general spec and keeps the legacy shape valid", () => {
  assert.deepEqual(
    parseChart({
      color: "var(--chart-2)",
      height: 48,
      legend: false,
      showTooltip: true,
      yDomain: [0, 10],
      y: { format: "currency", ticks: 4, currency: "$" },
      x: { labels: ["Mon", "Tue"], format: "day" },
      series: [
        {
          key: "actual",
          label: "Actual",
          color: "var(--chart-1)",
          type: "line",
          dashed: true,
          fillOpacity: 0.5,
          stack: "cost",
        },
      ],
      reference: [{ value: 5, label: "Budget", color: "var(--chart-4)", dashed: false }],
    }),
    {
      color: "var(--chart-2)",
      height: 48,
      legend: false,
      showTooltip: true,
      yDomain: [0, 10],
      y: { format: "currency", ticks: 4, currency: "$" },
      x: { labels: ["Mon", "Tue"], format: "day" },
      series: [
        {
          key: "actual",
          label: "Actual",
          color: "var(--chart-1)",
          type: "line",
          dashed: true,
          fillOpacity: 0.5,
          stack: "cost",
        },
      ],
      reference: [{ value: 5, label: "Budget", color: "var(--chart-4)", dashed: false }],
    },
  );
  assert.deepEqual(parseChart({ type: "area", color: "var(--chart-1)" }), {
    type: "area",
    color: "var(--chart-1)",
  });
  assert.deepEqual(parseChart({}), {});
});

test("parseChart rejects unknown keys, bad colours, counts and ranges", () => {
  assert.throws(() => parseChart({ glow: true }), /glow/);
  assert.throws(() => parseChart({ color: "url(javascript:1)" }), /chart.color/);
  assert.throws(
    () => parseChart({ series: [{ key: "a", color: "url(javascript:1)" }] }),
    /series\[0\]\.color/,
  );
  assert.throws(
    () => parseChart({ reference: [{ value: 1, color: "url(javascript:1)" }] }),
    /reference\[0\]\.color/,
  );
  assert.throws(() => parseChart({ series: [] }), /series/);
  assert.throws(
    () => parseChart({ series: Array.from({ length: 7 }, (_, index) => ({ key: `s${index}` })) }),
    /series/,
  );
  assert.throws(
    () => parseChart({ reference: Array.from({ length: 5 }, (_, index) => ({ value: index })) }),
    /reference/,
  );
  assert.throws(() => parseChart({ series: [{ key: "" }] }), /key/);
  assert.throws(() => parseChart({ series: [{ key: "a", fillOpacity: 1.1 }] }), /fillOpacity/);
  assert.throws(() => parseChart({ series: [{ key: "a", fillOpacity: -0.1 }] }), /fillOpacity/);
  assert.throws(() => parseChart({ y: { ticks: 11 } }), /ticks/);
  assert.throws(() => parseChart({ y: { ticks: -1 } }), /ticks/);
});

test("chart labels longer than the longest series are trimmed with a note", async () => {
  const dashboard = new DashboardManager(await tempDir(), {
    runner: countingRunner(() => ({ ok: true, value: {}, bytes: 2, logs: [], ms: 0 })),
  });
  await dashboard.load();
  dashboard.setHost(fakeHost());
  await dashboard.upsert({
    id: "labels",
    title: "Labels",
    kind: "sparkline",
    source: { type: "static" },
    mapping: { series: "series" },
    chart: {
      x: { labels: ["a", "b", "c", "d"] },
      series: [{ key: "a" }, { key: "b" }],
    },
  });
  const pushed = await dashboard.push("labels", { series: { a: [1, 2], b: [2, 3, 4] } });
  const view = pushed.view as {
    kind: string;
    series: { key: string; points: (number | null)[] }[];
  };
  assert.equal(view.kind, "sparkline");
  assert.deepEqual(
    view.series.map((item) => item.points.length),
    [2, 3],
  );
  assert.ok(pushed.notes.some((note) => /extra labels/.test(note)));
  dashboard.dispose();
  await dashboard.flush();
});

test("the committed default dashboard is the operator board", () => {
  const config = defaultDashboardConfig();
  assert.deepEqual(
    config.widgets.map((item) => item.id),
    [
      "host-usage",
      "prefix-moments",
      "prefix-cost",
      "context",
      "tokens",
      "mcp",
      "mcp-events",
      "task-reopens",
      "task-durations",
      "hetzner",
      "hetzner-cost",
      "go-usage",
      "bg-jobs",
    ],
  );
  assert.deepEqual(
    config.layout.sections.map((section) => section.title),
    [undefined, "Cache & prefix", "Session", "Infrastructure"],
  );
  assert.deepEqual(
    config.layout.sections.flatMap((section) => section.widgets.map((slot) => slot.id)),
    config.widgets.map((item) => item.id),
  );
  assert.deepEqual(config.tombstones, []);
});

test("task durations render p50, p90 and average rows from closed tasks", async () => {
  const base = {
    status: "done" as const,
    parentId: null,
    blockedBy: [],
    completion: null,
  };
  const tasks: Task[] = [
    {
      ...base,
      id: "t30",
      title: "Thirty",
      project: "pi-ui",
      createdAt: "2026-11-04T09:00:00.000Z",
      completedAt: "2026-11-04T09:30:00.000Z",
    },
    {
      ...base,
      id: "t60",
      title: "Sixty",
      project: "PI-UI",
      createdAt: "2026-11-04T09:00:00.000Z",
      completedAt: "2026-11-04T10:00:00.000Z",
    },
    {
      ...base,
      id: "t180",
      title: "Three hours",
      project: "pi-ui",
      createdAt: "2026-11-04T09:00:00.000Z",
      completedAt: "2026-11-04T12:00:00.000Z",
    },
    {
      ...base,
      id: "open",
      title: "Still open",
      status: "open",
      project: "pi-ui",
      createdAt: "2026-11-04T09:00:00.000Z",
      completedAt: null,
    },
    {
      ...base,
      id: "negative",
      title: "Closed before it opened",
      project: "pi-ui",
      createdAt: "2026-11-04T12:00:00.000Z",
      completedAt: "2026-11-04T09:00:00.000Z",
    },
  ];
  const inputs = {
    usage: null,
    context: null,
    mcp: { unavailable: [], servers: [] },
    mcpEvents: { subscriptions: [], events: [], notice: null, revision: 0 },
    jobs: [],
    session: { conversationId: "c", model: null, run: "idle" },
    taskDurations: taskDurationStats(tasks),
  } as unknown as BuiltinInputs;
  const data = (await readSource("task_durations", inputs)) as {
    total: number;
    p50: number;
    p90: number;
    avg: number;
    rows: { key: string; label: string; value: string }[];
  };
  assert.equal(data.total, 3);
  assert.deepEqual({ p50: data.p50, p90: data.p90, avg: data.avg }, { p50: 60, p90: 180, avg: 90 });
  assert.deepEqual(
    data.rows.map((row) => [row.label, row.value]),
    [
      ["p50", "1h"],
      ["p90", "3h"],
      ["avg", "1h 30m"],
      ["pi-ui", "3 tasks · avg 1h 30m · p90 3h"],
    ],
  );
  const widget = DEFAULT_DASHBOARD.widgets.find((item) => item.id === "task-durations");
  assert.ok(widget);
  const view = renderWidget(widget, data) as {
    kind: string;
    items: { label: string; value: string }[];
    empty?: string;
  };
  assert.equal(view.kind, "list");
  assert.deepEqual(
    view.items.map((item) => [item.label, item.value]),
    [
      ["p50", "1h"],
      ["p90", "3h"],
      ["avg", "1h 30m"],
      ["pi-ui", "3 tasks · avg 1h 30m · p90 3h"],
    ],
  );
  const emptyData = await readSource("task_durations", {
    ...inputs,
    taskDurations: taskDurationStats([]),
  });
  const emptyView = renderWidget(widget, emptyData) as { items: unknown[]; empty?: string };
  assert.deepEqual(emptyView.items, []);
  assert.equal(emptyView.empty, "no closed tasks yet");
});

test("every registered source is described, has a sample and the default names it", () => {
  const sources = listSources();
  assert.ok(sources.length > 0);
  for (const spec of sources) {
    assert.notEqual(spec.describe.trim(), "", `${spec.name} has a description`);
    assert.notEqual(spec.sample, undefined, `${spec.name} has a sample`);
    assert.doesNotThrow(
      () =>
        renderWidget(
          {
            id: "sample",
            title: "Sample",
            kind: "stat",
            source: { type: "builtin", name: spec.name as BuiltinName },
            mapping: { value: "$" },
          },
          spec.sample,
        ),
      `${spec.name}'s sample renders`,
    );
  }
  const names = new Set(sources.map((spec) => spec.name));
  for (const widget of DEFAULT_DASHBOARD.widgets) {
    if (widget.source.type === "builtin") {
      assert.ok(names.has(widget.source.name), `${widget.id} names ${widget.source.name}`);
    }
  }
});

test("MCP builtins list recent events newest first and subscriptions per server", async () => {
  const events = Array.from({ length: MCP_EVENT_LIMIT + 5 }, (_, index) => ({
    id: `e${index}`,
    server: "stub",
    name: "ticks",
    timestamp: new Date(Date.UTC(2026, 9, 30, 1, 0, index)).toISOString(),
    summary: `tick ${index}`,
  }));
  const inputs = {
    usage: null,
    context: null,
    mcp: {
      unavailable: ["down"],
      servers: [
        { name: "stub", available: true, authRejected: false, tools: ["stub__echo"] },
        { name: "down", available: false, authRejected: false, tools: [] },
      ],
    },
    mcpEvents: {
      subscriptions: [
        { id: "s1", server: "stub", name: "ticks", status: "active", arguments: {}, cursor: null },
        { id: "s2", server: "down", name: "feed", status: "failed", arguments: {} },
      ],
      events,
      notice: "new event from stub",
      revision: 25,
    },
    jobs: [],
    session: { conversationId: "c", model: null, run: "idle" },
  } as unknown as BuiltinInputs;
  const feed = (await readSource("mcp_events", {
    ...inputs,
    formatTime: (timestamp) => formatTime(timestamp),
  })) as {
    total: number;
    live: string[];
    events: { id: string; label: string; value: string }[];
  };
  assert.equal(feed.total, 25);
  assert.deepEqual(feed.live, ["stub"]);
  assert.equal(feed.events.length, MCP_EVENT_WIDGET_LIMIT);
  assert.equal(feed.events[0]?.id, "e24");
  assert.equal(feed.events.at(-1)?.id, "e22");
  assert.equal(feed.events[0]?.label, "stub · ticks");
  assert.match(feed.events[0]?.value ?? "", /\d\d:\d\d · tick 24$/);
  const status = (await readSource("mcp", inputs)) as {
    servers: { name: string; detail: string }[];
  };
  assert.deepEqual(
    status.servers.map((server) => server.detail),
    ["1 tool · subscribed: ticks", "unavailable · server unreachable"],
  );
  const widget = DEFAULT_DASHBOARD.widgets.find((item) => item.id === "mcp-events");
  assert.ok(widget);
  const view = renderWidget(widget, feed) as { kind: string; items: unknown[] };
  assert.equal(view.kind, "list");
  assert.equal(view.items.length, MCP_EVENT_WIDGET_LIMIT);
});

test("title-less argument subscriptions expose their stable id in both MCP widgets", async () => {
  const stableId = "stub/ticks#a1b2c3d4";
  const subscription = {
    id: "s1",
    stableId,
    server: "stub",
    name: "ticks",
    status: "active",
    arguments: { channel: "jobs" },
    cursor: null,
  };
  const inputs = {
    usage: null,
    context: null,
    mcp: {
      unavailable: [],
      servers: [{ name: "stub", available: true, authRejected: false, tools: [] }],
    },
    mcpEvents: {
      subscriptions: [subscription],
      events: [],
      notice: null,
      revision: 1,
    },
    jobs: [],
    session: { conversationId: "c", model: null, run: "idle" },
  } as unknown as BuiltinInputs;
  const status = (await readSource("mcp", inputs)) as {
    servers: { subscriptions: string[]; detail: string }[];
  };
  assert.deepEqual(status.servers[0]?.subscriptions, [stableId]);
  assert.equal(status.servers[0]?.detail, `no tools · subscribed: ${stableId}`);
  const feed = (await readSource("mcp_events", inputs)) as {
    subscriptions: { stableId: string; label: string; title: string | null }[];
  };
  assert.equal(feed.subscriptions[0]?.stableId, stableId);
  assert.equal(feed.subscriptions[0]?.title, null);
  assert.equal(feed.subscriptions[0]?.label, stableId);

  const markup = renderToStaticMarkup(
    createElement(EventsView, { events: inputs.mcpEvents, ready: true }),
  );
  assert.match(markup, /stub\/ticks#a1b2c3d4/);

  const titled = {
    ...inputs,
    mcpEvents: {
      ...inputs.mcpEvents,
      subscriptions: [{ ...subscription, title: "Nightly jobs" }],
    },
  } as unknown as BuiltinInputs;
  const titledFeed = (await readSource("mcp_events", titled)) as {
    subscriptions: { label: string }[];
  };
  assert.equal(titledFeed.subscriptions[0]?.label, "Nightly jobs");
  const titledMarkup = renderToStaticMarkup(
    createElement(EventsView, { events: titled.mcpEvents, ready: true }),
  );
  assert.match(titledMarkup, /Nightly jobs/);
  assert.doesNotMatch(titledMarkup, /stub\/ticks#a1b2c3d4/);
});

test("the MCP events widget shows the last 3 events and keeps the full total", async () => {
  const events = Array.from({ length: 5 }, (_, index) => ({
    id: `e${index}`,
    server: "stub",
    name: "ticks",
    timestamp: new Date(Date.UTC(2026, 9, 30, 1, 0, index)).toISOString(),
    summary: `tick ${index}`,
  }));
  const inputs = {
    usage: null,
    context: null,
    mcp: { unavailable: [], servers: [] },
    mcpEvents: { subscriptions: [], events, notice: null, revision: 5 },
    jobs: [],
    session: { conversationId: "c", model: null, run: "idle" },
  } as unknown as BuiltinInputs;
  const feed = (await readSource("mcp_events", inputs)) as {
    total: number;
    events: {
      key: string;
      id: string;
      server: string;
      name: string;
      timestamp: string;
      time: string;
      summary: string;
      label: string;
      value: string;
    }[];
  };
  assert.equal(feed.total, 5);
  assert.deepEqual(
    feed.events.map((event) => event.id),
    ["e4", "e3", "e2"],
  );
  assert.deepEqual(
    feed.events.map((event) => event.summary),
    ["tick 4", "tick 3", "tick 2"],
  );
  assert.deepEqual(
    feed.events.map((event) => event.label),
    ["stub · ticks", "stub · ticks", "stub · ticks"],
  );
  assert.deepEqual(Object.keys(feed.events[0] ?? {}).sort(), [
    "id",
    "key",
    "label",
    "name",
    "server",
    "summary",
    "time",
    "timestamp",
    "value",
  ]);
  const widget = DEFAULT_DASHBOARD.widgets.find((item) => item.id === "mcp-events");
  assert.ok(widget);
  const view = renderWidget(widget, feed) as { kind: string; items: unknown[] };
  assert.equal(view.kind, "list");
  assert.equal(view.items.length, MCP_EVENT_WIDGET_LIMIT);
});

test("an older dashboard.json is not overwritten and records defaultVersion", async () => {
  const dir = await tempDir();
  const old = defaultDashboardConfig();
  old.version = 1;
  delete old.defaultVersion;
  old.widgets = old.widgets.filter((item) => item.id !== "mcp-events");
  old.layout = {
    sections: [
      { title: "Infra", widgets: [{ id: "mcp", span: "half" }] },
      {
        widgets: [
          { id: "context", span: "full" },
          { id: "tokens", span: "full" },
        ],
      },
    ],
  };
  await writeFile(join(dir, "dashboard.json"), JSON.stringify(old));
  const first = new DashboardManager(dir);
  await first.load();
  assert.ok(!first.widgets().some((item) => item.id === "mcp-events"));
  assert.equal(first.state().defaultVersion, DEFAULT_DASHBOARD.version);
  const saved = JSON.parse(await readFile(join(dir, "dashboard.json"), "utf8"));
  assert.equal(saved.version, 1);
  assert.equal(saved.defaultVersion, DEFAULT_DASHBOARD.version);
  assert.deepEqual(saved.tombstones, []);
  first.dispose();
  await first.flush();
});

// ── masking ──────────────────────────────────────────────────────────────

test("token-looking strings are masked, ordinary ids are not", () => {
  const masked = maskSecrets(
    "auth Bearer abcdef0123456789xyz key ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 env s3cr3t-value-here",
    ["s3cr3t-value-here"],
  );
  assert.doesNotMatch(masked, /abcdef0123456789xyz|ghp_ABC|s3cr3t/);
  assert.match(masked, /••••/);
  const jwt =
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  assert.doesNotMatch(maskSecrets(`t=${jwt}`), /eyJzdWIi/);
  const sha = "f9b018b3c0ffee0123456789abcdef0123456789";
  assert.equal(maskSecrets(`commit ${sha}`), `commit ${sha}`);
  assert.equal(maskSecrets("web-1 running cx22"), "web-1 running cx22");
});

// ── poll isolation ───────────────────────────────────────────────────────

function run(script: string, extra: Partial<PollRun> = {}): Promise<PollOutcome> {
  return runPollScript({ script, prev: null, env: {}, timeoutMs: 3000, maxBytes: 4096, ...extra });
}

test("a poll script gets fetch, env, prev and log and returns JSON", async () => {
  const outcome = await run(
    `const r = await fetch(${JSON.stringify(`${base}/servers`)}, { headers: { authorization: "Bearer " + env.TOKEN } });
     log("status", r.status);
     const body = await r.json();
     return { names: body.servers.map((s) => s.name), runs: (prev?.runs ?? 0) + 1 };`,
    { env: { TOKEN: "test-hcloud-token-123" }, prev: { runs: 4 } },
  );
  assert.equal(outcome.ok, true, outcome.ok ? "" : outcome.error);
  assert.deepEqual(outcome.ok && outcome.value, { names: ["web-1", "db-1"], runs: 5 });
  assert.deepEqual(outcome.logs, ["status 200"]);
});

test("a busy loop times out without blocking the server", async () => {
  let ticks = 0;
  const timer = setInterval(() => {
    ticks += 1;
  }, 20);
  const started = Date.now();
  const outcome = await run("while (true) {}", { timeoutMs: 600 });
  clearInterval(timer);
  assert.equal(outcome.ok, false);
  assert.match(outcome.ok ? "" : outcome.error, /timed out/);
  assert.ok(Date.now() - started < 3000);
  assert.ok(ticks >= 10, `event loop ticked ${ticks} times`);
});

test("throwing, crashing and oversized scripts fail cleanly", async () => {
  const thrown = await run('throw new Error("nope")');
  assert.match(thrown.ok ? "" : thrown.error, /nope/);
  const exited = await run("process.exit(3)");
  assert.equal(exited.ok, false);
  const big = await run('return "x".repeat(10000)');
  assert.match(big.ok ? "" : big.error, /cap/);
  const undefinedResult = await run("return undefined");
  assert.equal(undefinedResult.ok, true);
  // The server is still fine afterwards.
  const after = await run("return 1 + 1");
  assert.deepEqual(after.ok && after.value, 2);
});

// ── manager ──────────────────────────────────────────────────────────────

interface FakeHost extends DashboardHost {
  notices: string[];
  frames: DashboardState[];
}

function fakeHost(): FakeHost {
  const host: FakeHost = {
    notices: [],
    frames: [],
    async builtinInputs() {
      return {
        usage: null,
        context: null,
        mcp: { servers: [] },
        mcpEvents: { subscriptions: [], events: [], notice: null, revision: 0 },
        jobs: [],
        session: { conversationId: "c", model: null, run: "idle" },
      } as unknown as Awaited<ReturnType<DashboardHost["builtinInputs"]>>;
    },
    builtinsLite: () => ({ jobs: [], session: { conversationId: "c", model: null, run: "idle" } }),
    notify(text) {
      host.notices.push(text);
    },
    broadcast(state) {
      host.frames.push(state);
    },
  };
  return host;
}

function countingRunner(result: () => PollOutcome) {
  const runner = Object.assign(
    async (_run: PollRun): Promise<PollOutcome> => {
      runner.calls += 1;
      return result();
    },
    { calls: 0 },
  );
  return runner;
}

test("polls run only while a client shows the dashboard", async () => {
  const runner = countingRunner(() => ({ ok: true, value: { n: 1 }, bytes: 7, logs: [], ms: 1 }));
  const dashboard = new DashboardManager(await tempDir(), {
    minIntervalMs: 40,
    viewerTtlMs: 300,
    runner,
  });
  await dashboard.load();
  dashboard.setHost(fakeHost());
  const result = await dashboard.upsert({
    id: "n",
    title: "N",
    kind: "stat",
    source: { type: "poll", script: "return { n: 1 }", intervalSec: 0.04 },
    mapping: { value: "n" },
  });
  assert.equal(runner.calls, 1, "upsert polls once even with no viewer");
  assert.deepEqual(result.view, { kind: "stat", value: "1" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(runner.calls, 1, "no polling while nobody looks");

  dashboard.setViewer("tab-1", true);
  const heartbeat = setInterval(() => dashboard.setViewer("tab-1", true), 100);
  await until(() => runner.calls >= 4);
  clearInterval(heartbeat);
  dashboard.setViewer("tab-1", false);
  const stopped = runner.calls;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(runner.calls <= stopped + 1, "polling stops when hidden");

  // A viewer that stops reporting expires.
  dashboard.setViewer("tab-2", true);
  assert.equal(dashboard.polling(), true);
  await until(() => !dashboard.polling(), 2000);
  const expired = runner.calls;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.ok(runner.calls <= expired + 1);
  dashboard.dispose();
  await dashboard.flush();
});

test("failures keep the last value, back off and notify the agent once", async () => {
  let fail = false;
  const runner = countingRunner(() =>
    fail
      ? { ok: false, error: "boom Bearer abcdef0123456789xyz", logs: [], ms: 1 }
      : { ok: true, value: { n: 7 }, bytes: 7, logs: [], ms: 1 },
  );
  const host = fakeHost();
  const dashboard = new DashboardManager(await tempDir(), {
    minIntervalMs: 20,
    viewerTtlMs: 60_000,
    runner,
  });
  await dashboard.load();
  dashboard.setHost(host);
  await dashboard.upsert({
    id: "n",
    title: "N",
    kind: "stat",
    source: { type: "poll", script: "x", intervalSec: 0.02 },
    mapping: { value: "n" },
  });
  fail = true;
  dashboard.setViewer("tab", true);
  await until(() => runner.calls >= 7, 8000);
  const described = await dashboard.describe();
  const value = described.widgets.find((item) => item.id === "n");
  assert.deepEqual(value?.value, { kind: "stat", value: "7" }, "last good value kept");
  assert.match(value?.error ?? "", /boom/);
  assert.doesNotMatch(value?.error ?? "", /abcdef0123456789xyz/, "errors are masked");
  assert.equal(host.notices.length, 1);
  assert.match(host.notices[0] ?? "", /Widget "n" \(N\) failed 5 polls in a row/);
  // After the 5th failure the wait doubles each time, so polls slow down.
  const calls = runner.calls;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.ok(runner.calls - calls <= 2, `backed off: ${runner.calls - calls} more polls`);
  // Recovery clears the error and re-arms the notice.
  fail = false;
  await until(() => dashboard.state().values.n?.error === undefined, 8000);
  assert.equal(dashboard.state().values.n?.failures, 0);
  dashboard.dispose();
  await dashboard.flush();
});

test("upsert, push, layout and remove validate and persist", async () => {
  const dir = await tempDir();
  const dashboard = new DashboardManager(dir, {
    runner: countingRunner(() => ({ ok: false, error: "x", logs: [], ms: 0 })),
  });
  await dashboard.load();
  const host = fakeHost();
  dashboard.setHost(host);
  assert.deepEqual(
    dashboard.widgets().map((item) => item.id),
    DEFAULT_DASHBOARD.widgets.map((item) => item.id),
  );
  await assert.rejects(
    dashboard.upsert({
      id: "bad id!",
      title: "x",
      kind: "stat",
      source: { type: "static" },
      mapping: { value: "a" },
    }),
    /id/,
  );
  await assert.rejects(
    dashboard.upsert({ id: "x", title: "x", kind: "pie", source: { type: "static" }, mapping: {} }),
    /kind/,
  );
  await dashboard.upsert({
    id: "cost",
    title: "Cost",
    kind: "stat",
    source: { type: "static" },
    mapping: { value: "eur", unit: "=€/mo" },
  });
  const pushed = await dashboard.push("cost", { eur: 12.5 });
  assert.deepEqual(pushed.view, { kind: "stat", value: "12.5", unit: "€/mo" });
  await assert.rejects(dashboard.push("context", {}), /static/);
  await assert.rejects(dashboard.setLayout({ sections: [{ widgets: [{ id: "nope" }] }] }), /nope/);
  const layout = await dashboard.setLayout({
    sections: [
      {
        title: "Money",
        widgets: [
          { id: "cost", span: "half" },
          { id: "context", span: "half" },
        ],
      },
      { widgets: [{ id: "tokens", span: "third" }] },
    ],
  });
  const missing = DEFAULT_DASHBOARD.widgets
    .map((item) => item.id)
    .filter((id) => id !== "context" && id !== "tokens");
  assert.deepEqual(
    layout.layout.sections.at(-1)?.widgets.map((slot) => slot.id),
    missing,
  );
  assert.ok(layout.notes.some((note) => /mcp/.test(note)));
  await dashboard.remove("tokens");
  await assert.rejects(dashboard.remove("tokens"), /tokens/);
  await dashboard.flush();

  const again = new DashboardManager(dir);
  await again.load();
  assert.deepEqual(
    again
      .layout()
      .sections.map((section) => [
        section.title,
        section.widgets.map((slot) => `${slot.id}:${slot.span}`),
      ]),
    [
      ["Money", ["cost:half", "context:half"]],
      [
        undefined,
        missing.map((id) => {
          const slot = layout.layout.sections.at(-1)?.widgets.find((item) => item.id === id);
          return `${id}:${slot?.span ?? "full"}`;
        }),
      ],
    ],
  );
  const state = again.state();
  assert.deepEqual(state.values.cost?.view, { kind: "stat", value: "12.5", unit: "€/mo" });
  const saved = JSON.parse(await readFile(join(dir, "dashboard.json"), "utf8"));
  assert.equal(saved.version, DEFAULT_DASHBOARD.version);
  assert.ok(saved.tombstones.includes("tokens"));
  assert.ok(!again.widgets().some((item) => item.id === "tokens"));
});

test("replace keeps a builtin id with a poll source across a reload", async () => {
  const dir = await tempDir();
  const runner = countingRunner(() => ({
    ok: true,
    value: { value: "poll value" },
    bytes: 20,
    logs: [],
    ms: 1,
  }));
  const dashboard = new DashboardManager(dir, { runner });
  await dashboard.load();
  dashboard.setHost(fakeHost());
  const result = await dashboard.upsert({
    id: "context",
    replace: true,
    title: "Context replacement",
    kind: "stat",
    source: { type: "poll", script: "return { value: 'poll value' }", intervalSec: 0.5 },
    mapping: { value: "value" },
  });
  assert.deepEqual(result.view, { kind: "stat", value: "poll value" });
  assert.equal(dashboard.widgets().find((item) => item.id === "context")?.source.type, "poll");
  await dashboard.flush();

  const again = new DashboardManager(dir, { runner });
  await again.load();
  const widget = again.widgets().find((item) => item.id === "context");
  assert.equal(widget?.source.type, "poll");
  assert.equal(widget?.title, "Context replacement");
  assert.deepEqual(again.state().values.context?.view, {
    kind: "stat",
    value: "poll value",
  });
  again.dispose();
  dashboard.dispose();
});

test("deleting a default widget tombstones it and re-adding the id clears it", async () => {
  const dir = await tempDir();
  const dashboard = new DashboardManager(dir);
  await dashboard.load();
  await dashboard.remove("mcp");
  await dashboard.flush();
  let saved = JSON.parse(await readFile(join(dir, "dashboard.json"), "utf8"));
  assert.ok(saved.tombstones.includes("mcp"));

  const again = new DashboardManager(dir);
  await again.load();
  assert.ok(!again.widgets().some((item) => item.id === "mcp"));
  assert.equal(again.state().defaultVersion, undefined);
  await again.upsert({
    id: "mcp",
    title: "MCP replacement",
    kind: "stat",
    source: { type: "static" },
    mapping: { value: "$" },
  });
  await again.flush();
  saved = JSON.parse(await readFile(join(dir, "dashboard.json"), "utf8"));
  assert.ok(!saved.tombstones.includes("mcp"));

  const third = new DashboardManager(dir);
  await third.load();
  const widget = third.widgets().find((item) => item.id === "mcp");
  assert.equal(widget?.source.type, "static");
  assert.equal(widget?.title, "MCP replacement");
  third.dispose();
  again.dispose();
  dashboard.dispose();
});

test("a fresh DATA_DIR seeds DEFAULT_DASHBOARD and reset restores it", async () => {
  const dir = await tempDir();
  const dashboard = new DashboardManager(dir);
  await dashboard.load();
  assert.deepEqual(
    dashboard.widgets().map((item) => item.id),
    DEFAULT_DASHBOARD.widgets.map((item) => item.id),
  );
  assert.deepEqual(
    dashboard.layout().sections.map((section) => section.title),
    DEFAULT_DASHBOARD.sections.map((section) => section.title),
  );
  await dashboard.remove("context");
  await dashboard.upsert({
    id: "extra",
    title: "Extra",
    kind: "stat",
    source: { type: "static" },
    mapping: { value: "$" },
  });
  const state = await dashboard.reset();
  assert.deepEqual(
    state.widgets.map((item) => item.id),
    DEFAULT_DASHBOARD.widgets.map((item) => item.id),
  );
  assert.equal(state.defaultVersion, undefined);
  await dashboard.flush();
  const saved = JSON.parse(await readFile(join(dir, "dashboard.json"), "utf8"));
  assert.equal(saved.version, DEFAULT_DASHBOARD.version);
  assert.deepEqual(saved.tombstones, []);
  assert.deepEqual(
    saved.widgets.map((item: { id: string }) => item.id),
    DEFAULT_DASHBOARD.widgets.map((item) => item.id),
  );
  dashboard.dispose();
});

test("poll scripts never leave the server and intervals are clamped", async () => {
  const notes: string[] = [];
  const parsed = parseWidget(
    {
      id: "p",
      title: "P",
      kind: "stat",
      source: { type: "poll", script: "return 1", intervalSec: 5 },
      mapping: { value: "$" },
    },
    30,
    notes,
  );
  assert.equal(parsed.source.type === "poll" && parsed.source.intervalSec, 30);
  assert.ok(notes.some((note) => /30/.test(note)));
  const dashboard = new DashboardManager(await tempDir(), {
    runner: countingRunner(() => ({ ok: true, value: 1, bytes: 1, logs: [], ms: 0 })),
  });
  await dashboard.load();
  await dashboard.upsert({
    id: "p",
    title: "P",
    kind: "stat",
    source: "static",
    mapping: { value: "$" },
  });
  await dashboard.upsert({
    id: "p",
    title: "P",
    kind: "stat",
    source: { type: "poll", script: "return 'SECRET-SCRIPT'" },
    mapping: { value: "$" },
  });
  assert.doesNotMatch(JSON.stringify(dashboard.state()), /SECRET-SCRIPT/);
  for (let index = 0; index < 9; index += 1) {
    await dashboard.upsert({
      id: `p${index}`,
      title: "P",
      kind: "stat",
      source: { type: "poll", script: "return 1" },
      mapping: { value: "$" },
    });
  }
  await assert.rejects(
    dashboard.upsert({
      id: "p10",
      title: "P",
      kind: "stat",
      source: { type: "poll", script: "return 1" },
      mapping: { value: "$" },
    }),
    /10/,
  );
  dashboard.dispose();
  await dashboard.flush();
});

test("the tools return the first render so the agent can iterate", async () => {
  const dashboard = new DashboardManager(await tempDir(), {
    env: { HCLOUD_TOKEN: "test-hcloud-token-123" },
  });
  await dashboard.load();
  dashboard.setHost(fakeHost());
  const tools = Object.fromEntries(
    createDashboardTools(dashboard).map((tool) => [tool.name, tool]),
  );
  assert.deepEqual(Object.keys(tools).sort(), [
    "dashboard_get",
    "dashboard_layout",
    "dashboard_push",
    "dashboard_remove",
    "dashboard_upsert",
  ]);
  const call = async (name: string, args: unknown) => {
    // biome-ignore lint/suspicious/noExplicitAny: test harness for tool execute
    const result = await (tools[name] as any).execute(args, {});
    return { text: result.output[0].text as string, isError: result.isError === true };
  };
  const wrong = await call("dashboard_upsert", {
    id: "servers",
    title: "Live servers",
    kind: "table",
    source: {
      type: "poll",
      script: `const r = await fetch(${JSON.stringify(`${base}/servers`)}, { headers: { Authorization: "Bearer " + env.HCLOUD_TOKEN } }); return r.json();`,
    },
    mapping: { rows: "items", columns: { Name: "name" } },
  });
  assert.equal(wrong.isError, true);
  assert.match(wrong.text, /items/);
  assert.match(wrong.text, /web-1/, "the sample shows the real shape");
  const right = await call("dashboard_upsert", {
    id: "servers",
    title: "Live servers",
    kind: "table",
    source: {
      type: "poll",
      script: `const r = await fetch(${JSON.stringify(`${base}/servers`)}, { headers: { Authorization: "Bearer " + env.HCLOUD_TOKEN } }); return r.json();`,
    },
    mapping: {
      rows: "servers",
      columns: { Name: "name", Status: "status", Type: "server_type.name" },
    },
  });
  assert.equal(right.isError, false, right.text);
  assert.match(right.text, /"cx22"/);
  assert.doesNotMatch(right.text, /test-hcloud-token-123/);
  const got = JSON.parse((await call("dashboard_get", {})).text);
  assert.deepEqual(
    got.widgets.map((item: { id: string }) => item.id),
    [...DEFAULT_DASHBOARD.widgets.map((item) => item.id), "servers"],
  );
  assert.equal((await call("dashboard_remove", { id: "ghost" })).isError, true);
  dashboard.dispose();
  await dashboard.flush();
});

test("MCP details show tool counts and never the connected label", async () => {
  const inputs = {
    usage: null,
    context: null,
    mcp: {
      unavailable: ["down", "reasoned"],
      servers: [
        { name: "three", available: true, authRejected: false, tools: ["a", "b", "c"] },
        { name: "single", available: true, authRejected: false, tools: ["a"] },
        { name: "empty", available: true, authRejected: false, tools: [] },
        { name: "rejected", available: false, authRejected: true, tools: [] },
        { name: "down", available: false, authRejected: false, tools: [] },
        {
          name: "reasoned",
          available: false,
          authRejected: false,
          tools: [],
          reason: "session lost (http404)",
        },
      ],
    },
    mcpEvents: { subscriptions: [], events: [], notice: null, revision: 0 },
    jobs: [],
    session: { conversationId: "c", model: null, run: "idle" },
  } as unknown as BuiltinInputs;
  const data = (await readSource("mcp", inputs)) as {
    servers: {
      name: string;
      available: boolean;
      authRejected: boolean;
      tools: number;
      state: string;
      detail: string;
    }[];
  };
  assert.deepEqual(
    data.servers.map((server) => server.detail),
    [
      "3 tools",
      "1 tool",
      "no tools",
      "auth rejected",
      "unavailable · server unreachable",
      "unavailable · session lost (http404)",
    ],
  );
  assert.deepEqual(
    data.servers.map((server) => server.state),
    ["ok", "ok", "ok", "warn", "error", "error"],
  );
  assert.deepEqual(
    data.servers.map((server) => [server.available, server.authRejected, server.tools]),
    [
      [true, false, 3],
      [true, false, 1],
      [true, false, 0],
      [false, true, 0],
      [false, false, 0],
      [false, false, 0],
    ],
  );
  for (const server of data.servers) assert.doesNotMatch(server.detail, /connected/);
  assert.ok(data.servers.at(-1)?.detail.startsWith("unavailable · "));
});
