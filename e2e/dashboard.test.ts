import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { type DashboardHost, DashboardManager, parseWidget } from "../src/server/dashboard.js";
import { type PollOutcome, type PollRun, runPollScript } from "../src/server/dashboard-runner.js";
import { createDashboardTools } from "../src/server/dashboard-tools.js";
import {
  builtinData,
  DASHBOARD_SEED,
  type DashboardState,
  defaultDashboard,
  evalPath,
  MCP_EVENT_LIMIT,
  maskSecrets,
  renderWidget,
  validateMapping,
  type Widget,
} from "../src/shared/dashboard.js";

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
});

test("the default dashboard is the old stats page as builtin widgets", () => {
  const config = defaultDashboard();
  assert.deepEqual(
    config.widgets.map((item) => [item.id, item.kind, item.source]),
    [
      ["context", "stat", { type: "builtin", name: "context" }],
      ["tokens", "list", { type: "builtin", name: "tokens" }],
      ["mcp", "status", { type: "builtin", name: "mcp" }],
      ["mcp-events", "list", { type: "builtin", name: "mcp_events" }],
    ],
  );
  assert.equal(config.seeded, DASHBOARD_SEED);
  const inputs = {
    usage: null,
    context: null,
    mcp: { servers: [] },
    mcpEvents: { subscriptions: [], events: [], notice: null, revision: 0 },
    jobs: [],
    session: { conversationId: "c", model: null, run: "idle" },
  } as unknown as Parameters<typeof builtinData>[1];
  for (const item of config.widgets) {
    if (item.source.type !== "builtin") continue;
    renderWidget(item, builtinData(item.source.name, inputs));
  }
});

test("MCP builtins list recent events newest first and subscriptions per server", () => {
  const events = Array.from({ length: 25 }, (_, index) => ({
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
        { id: "s1", server: "stub", name: "ticks", status: "active", arguments: {} },
        { id: "s2", server: "down", name: "feed", status: "failed", arguments: {} },
      ],
      events,
      notice: "new event from stub",
      revision: 25,
    },
    jobs: [],
    session: { conversationId: "c", model: null, run: "idle" },
  } as unknown as Parameters<typeof builtinData>[1];
  const feed = builtinData("mcp_events", inputs) as {
    total: number;
    live: string[];
    events: { id: string; label: string; value: string }[];
  };
  assert.equal(feed.total, 25);
  assert.deepEqual(feed.live, ["stub"]);
  assert.equal(feed.events.length, MCP_EVENT_LIMIT);
  assert.equal(feed.events[0]?.id, "e24");
  assert.equal(feed.events.at(-1)?.id, "e5");
  assert.equal(feed.events[0]?.label, "stub · ticks");
  assert.match(feed.events[0]?.value ?? "", /\d\d:\d\d:\d\d · tick 24$/);
  const status = builtinData("mcp", inputs) as { servers: { name: string; detail: string }[] };
  assert.deepEqual(
    status.servers.map((server) => server.detail),
    ["connected · 1 tool · subscribed: ticks", "unavailable"],
  );
  const widget = defaultDashboard().widgets.find((item) => item.id === "mcp-events");
  assert.ok(widget);
  const view = renderWidget(widget, feed) as { kind: string; items: unknown[] };
  assert.equal(view.kind, "list");
  assert.equal(view.items.length, MCP_EVENT_LIMIT);
});

test("an older dashboard.json gets the MCP events widget once", async () => {
  const dir = await tempDir();
  const old = defaultDashboard() as unknown as Record<string, unknown>;
  delete old.seeded;
  const config = old as unknown as ReturnType<typeof defaultDashboard>;
  config.widgets = config.widgets.filter((item) => item.id !== "mcp-events");
  config.layout = {
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
  await writeFile(join(dir, "dashboard.json"), JSON.stringify(config));
  const first = new DashboardManager(dir);
  await first.load();
  assert.deepEqual(
    first.layout().sections[0]?.widgets.map((slot) => slot.id),
    ["mcp", "mcp-events"],
  );
  const saved = JSON.parse(await readFile(join(dir, "dashboard.json"), "utf8"));
  assert.equal(saved.seeded, DASHBOARD_SEED);
  assert.ok(saved.widgets.some((item: { id: string }) => item.id === "mcp-events"));

  await first.remove("mcp-events");
  await first.flush();
  const second = new DashboardManager(dir);
  await second.load();
  assert.ok(!second.widgets().some((item) => item.id === "mcp-events"));
  second.dispose();
  first.dispose();
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
    ["context", "tokens", "mcp", "mcp-events"],
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
  assert.deepEqual(
    layout.layout.sections.at(-1)?.widgets.map((slot) => slot.id),
    ["mcp", "mcp-events"],
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
      [undefined, ["mcp:full", "mcp-events:full"]],
    ],
  );
  const state = again.state();
  assert.deepEqual(state.values.cost?.view, { kind: "stat", value: "12.5", unit: "€/mo" });
  const saved = JSON.parse(await readFile(join(dir, "dashboard.json"), "utf8"));
  assert.equal(saved.version, 1);
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
    ["context", "tokens", "mcp", "mcp-events", "servers"],
  );
  assert.equal((await call("dashboard_remove", { id: "ghost" })).isError, true);
  dashboard.dispose();
  await dashboard.flush();
});
