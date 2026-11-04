import assert from "node:assert/strict";
import { test } from "@e2e-dev/web";
import { expect, type JsonValue } from "e2e";
import { parseWidget } from "../src/server/dashboard.js";
import { DEFAULT_DASHBOARD } from "../src/shared/dashboard-default.js";
import { BUILTIN_SOURCES } from "../src/shared/dashboard-sources.js";

// Poll scripts the fake model hands to dashboard_upsert. They call the fake
// ExampleCloud API on the fake model server ({{FAKE_HTTP}}) with env.HCLOUD_TOKEN.
const serversScript = `const res = await fetch("{{FAKE_HTTP}}/example-cloud/v1/servers", {
  headers: { Authorization: \`Bearer \${env.HCLOUD_TOKEN}\` },
});
if (!res.ok) throw new Error(\`ExampleCloud API \${res.status}\`);
const { servers } = await res.json();
log("servers", servers.length);
return servers.map((s) => ({
  name: s.name,
  status: s.status,
  type: s.server_type.name,
  ip: s.public_net.ipv4.ip,
}));`;

const costScript = `const res = await fetch("{{FAKE_HTTP}}/example-cloud/v1/servers", {
  headers: { Authorization: \`Bearer \${env.HCLOUD_TOKEN}\` },
});
if (!res.ok) throw new Error(\`ExampleCloud API \${res.status}\`);
const { servers } = await res.json();
const total = servers.reduce(
  (sum, s) => sum + Number(s.server_type.prices[0].price_monthly.gross),
  0,
);
return { total: \`€\${total.toFixed(2)}\`, servers: \`\${servers.length} servers\` };`;

const createCalls = [
  {
    name: "dashboard_upsert",
    arguments: {
      id: "example-cloud-servers",
      title: "Live servers",
      kind: "table",
      source: { type: "poll", script: serversScript, intervalSec: 0.5 },
      mapping: {
        rows: "$",
        columns: { Name: "name", Status: "status", Type: "type", IP: "ip" },
      },
    },
  },
  {
    name: "dashboard_upsert",
    arguments: {
      id: "example-cloud-cost",
      title: "ExampleCloud monthly cost",
      kind: "stat",
      source: { type: "poll", script: costScript, intervalSec: 0.5 },
      mapping: { value: "total", label: "servers" },
    },
  },
  {
    name: "dashboard_layout",
    arguments: {
      sections: [
        {
          title: "ExampleCloud",
          widgets: [
            { id: "example-cloud-cost", span: "third" },
            { id: "context", span: "third" },
            { id: "tokens", span: "third" },
            { id: "example-cloud-servers", span: "full" },
          ],
        },
        {
          title: "Agent",
          widgets: DEFAULT_DASHBOARD.widgets
            .filter((widget) => widget.id !== "context" && widget.id !== "tokens")
            .map((widget) => ({ id: widget.id, span: "full" })),
        },
      ],
    },
  },
];

const sparkScript = `return { values: [2, 5, 3, 8, 6, 10, 7, 12] };`;

const sparkAreaCall = {
  name: "dashboard_upsert",
  arguments: {
    id: "spark-history",
    title: "Spark history",
    kind: "sparkline",
    source: { type: "poll", script: sparkScript, intervalSec: 0.5 },
    mapping: { series: "values", label: "=history" },
    chart: { type: "area", height: 40, yDomain: "auto" },
  },
};

const sparkBarCall = {
  name: "dashboard_upsert",
  arguments: {
    ...sparkAreaCall.arguments,
    chart: { type: "bar", color: "var(--chart-2)" },
  },
};

// A source key that would end the generated custom property and inject a CSS rule
// if it were used verbatim by ChartStyle.
const unsafeSeriesKey = "x: red; } body { visibility: hidden } .zz";

const spendScript = `return {
  series: {
    ${JSON.stringify(unsafeSeriesKey)}: [42, 68, 91, 118, 132, 149],
    projection: [55, 82, 110, 140, 171, 206],
  },
};`;

const spendChartCall = {
  name: "dashboard_upsert",
  arguments: {
    id: "spend-chart",
    title: "Spend by day",
    kind: "sparkline",
    source: { type: "poll", script: spendScript, intervalSec: 0.5 },
    mapping: { series: "series" },
    chart: {
      height: 180,
      showTooltip: true,
      y: { format: "currency", ticks: 4 },
      x: { labels: ["1", "8", "15", "22", "29", "30"] },
      series: [
        { key: unsafeSeriesKey, label: "Actual", color: "var(--chart-1)", type: "line" },
        {
          key: "projection",
          label: "Projection",
          color: "var(--chart-2)",
          type: "line",
          dashed: true,
        },
      ],
      reference: [{ value: 175, label: "Budget", color: "var(--chart-4)" }],
    },
  },
};

const spendResetCalls = [{ name: "dashboard_remove", arguments: { id: "spend-chart" } }];

const defaultIds = DEFAULT_DASHBOARD.widgets.map((widget) => widget.id);
const resetCalls = [
  { name: "dashboard_remove", arguments: { id: "example-cloud-servers" } },
  { name: "dashboard_remove", arguments: { id: "example-cloud-cost" } },
  {
    name: "dashboard_layout",
    arguments: { sections: DEFAULT_DASHBOARD.sections },
  },
];

type DashboardRead = {
  polling: boolean;
  widgets: { id: string }[];
  values: Record<string, { updatedAt?: string; error?: string; view?: unknown }>;
};

async function readDashboard(browser: {
  evaluate<T>(fn: () => Promise<T> | T): Promise<T>;
}): Promise<DashboardRead> {
  return browser.evaluate(async () => {
    const res = await fetch("/api/dashboard");
    return (await res.json()) as DashboardRead;
  });
}

const lastAssistant = () =>
  [...document.querySelectorAll<HTMLElement>('[data-role="assistant"]')].at(-1)?.textContent ?? "";

/** Runs dashboard tool calls through the real message route. */
async function seedDashboard(
  browser: { evaluate<T>(fn: (text: string) => Promise<T> | T, text: string): Promise<T> },
  calls: unknown[],
) {
  await browser.evaluate(
    async (text) => {
      const response = await fetch("/api/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) throw new Error(`message failed: ${response.status}`);
      return null;
    },
    `TOOLCALLS ${JSON.stringify(calls)}`,
  );
}

async function dashboardHas(
  browser: { evaluate<T>(fn: () => Promise<T> | T): Promise<T> },
  ids: string[],
) {
  await expect
    .poll(
      async () => {
        const widgets = (await readDashboard(browser)).widgets.map((widget) => widget.id);
        return ids.every((id) => widgets.includes(id));
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

test("the agent builds dashboard widgets that render at 1280px and 390px", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 900 });
  await app.open("/");
  await screen.getByRole("textbox", "Message").fill(`TOOLCALLS ${JSON.stringify(createCalls)}`);
  await screen.getByRole("button", "Send").tap();
  await expect
    .poll(() => browser.evaluate(lastAssistant), { timeout: 20_000 })
    .toContain("Tool result:");

  await screen.getByRole("tab", "Stats").tap();
  await expect(screen.getByText("Live servers", { exact: true })).toBeVisible();
  await expect(screen.getByText("€16.67", { exact: false })).toBeVisible();

  const layout = () =>
    browser.evaluate(() => {
      const page = document.querySelector("[data-testid=stats-page]");
      const box = (id: string) => {
        const rect = document
          .querySelector(`[data-testid="widget-${id}"]`)
          ?.getBoundingClientRect();
        return rect === undefined
          ? null
          : {
              top: rect.top,
              bottom: rect.bottom,
              left: rect.left,
              right: rect.right,
              width: rect.width,
            };
      };
      const table = document.querySelector("[data-testid=widget-example-cloud-servers] table");
      const cards = [...(page?.querySelectorAll("section") ?? [])];
      return {
        sections: [...document.querySelectorAll("[data-testid=dashboard-section] > h2")].map(
          (h) => h.textContent,
        ),
        cost:
          document.querySelector("[data-testid=stat-example-cloud-cost] dd")?.textContent ?? null,
        costLabel:
          document.querySelector("[data-testid=stat-example-cloud-cost] dt")?.textContent ?? null,
        header: [...(table?.querySelectorAll("th") ?? [])].map((th) => th.textContent),
        rows: [...(table?.querySelectorAll("tbody tr") ?? [])].map((tr) =>
          [...tr.querySelectorAll("td")].map((td) => td.textContent),
        ),
        cost_box: box("example-cloud-cost"),
        context_box: box("context"),
        servers_box: box("example-cloud-servers"),
        overflow: page === null ? true : page.scrollWidth > page.clientWidth,
        inside: cards.every(
          (card) => card.getBoundingClientRect().right <= window.innerWidth + 0.5,
        ),
        token: document.body.textContent?.includes("e2e-hcloud-token") ?? false,
      };
    });

  const wide = await layout();
  expect(wide.sections).toEqual(["ExampleCloud", "Agent"]);
  expect(wide.cost).toContain("€16.67");
  expect(wide.costLabel).toBe("3 servers");
  expect(wide.header).toEqual(["Name", "Status", "Type", "IP"]);
  expect(wide.rows).toEqual([
    ["web-1", "running", "cx22", "203.0.113.101"],
    ["db-1", "running", "cx32", "203.0.113.102"],
    ["worker-1", "off", "cx22", "203.0.113.103"],
  ]);
  expect(wide.overflow).toBe(false);
  expect(wide.inside).toBe(true);
  expect(wide.token).toBe(false);
  // Thirds sit side by side on wide screens; the full-width table goes below.
  expect(wide.cost_box && wide.context_box).toBeTruthy();
  if (wide.cost_box && wide.context_box && wide.servers_box) {
    expect(Math.abs(wide.cost_box.top - wide.context_box.top)).toBeLessThan(2);
    expect(wide.context_box.left).toBeGreaterThan(wide.cost_box.right - 1);
    expect(wide.servers_box.top).toBeGreaterThan(wide.cost_box.bottom - 1);
    expect(wide.servers_box.width).toBeGreaterThan(wide.cost_box.width * 2);
  }

  await browser.setViewport({ width: 390, height: 844 });
  await expect
    .poll(async () => {
      const narrow = await layout();
      return (
        narrow.cost_box !== null &&
        narrow.context_box !== null &&
        narrow.context_box.top > narrow.cost_box.bottom - 1
      );
    })
    .toBe(true);
  const narrow = await layout();
  expect(narrow.overflow).toBe(false);
  expect(narrow.inside).toBe(true);
  expect(narrow.rows.length).toBe(3);

  // Leaving the page tells the server right away, so the next test starts unwatched.
  await screen.getByRole("tab", "Chat").tap();
  await expect.poll(async () => (await readDashboard(browser)).polling).toBe(false);
  // Leave the default dashboard behind for whichever isolated session runs next.
  await seedDashboard(browser, resetCalls);
  await dashboardHas(browser, defaultIds);
});

test("sources are discoverable and reset restores the committed default board", async ({
  app,
  browser,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");
  const sources = (await browser.evaluate(async () => {
    const response = await fetch("/api/dashboard/sources");
    if (!response.ok) throw new Error(`sources failed: ${response.status}`);
    return (await response.json()) as unknown as JsonValue;
  })) as unknown as {
    sources: { name: string; description: string; sample?: unknown }[];
  };
  assert.deepEqual(
    sources.sources.map((source) => source.name).sort(),
    [...BUILTIN_SOURCES].sort(),
  );
  for (const source of sources.sources) {
    assert.notEqual(source.description.trim(), "", `${source.name} has a description`);
    assert.notEqual(source.sample, undefined, `${source.name} has a sample`);
  }

  // Delete a builtin and add an unrelated widget, then reset.
  await browser.evaluate(async () => {
    const removed = await fetch("/api/dashboard/widgets/context", { method: "DELETE" });
    if (!removed.ok) throw new Error(`delete failed: ${removed.status}`);
    const response = await fetch("/api/dashboard/reset", { method: "POST" });
    if (!response.ok) throw new Error(`reset failed: ${response.status}`);
    return (await response.json()) as unknown as JsonValue;
  });
  await expect
    .poll(async () => (await readDashboard(browser)).widgets.map((widget) => widget.id))
    .toEqual(defaultIds);
  const state = (await browser.evaluate(async () => {
    const response = await fetch("/api/dashboard");
    return (await response.json()) as unknown as JsonValue;
  })) as unknown as {
    layout: { sections: { title?: string; widgets: { id: string }[] }[] };
  };
  assert.deepEqual(
    state.layout.sections.map((section) => section.title),
    DEFAULT_DASHBOARD.sections.map((section) => section.title),
  );
  assert.deepEqual(
    state.layout.sections.flatMap((section) => section.widgets.map((slot) => slot.id)),
    defaultIds,
  );
});

test("polls run only while the dashboard is visible, and widgets can be removed", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");
  // Each parallel worker may land on a fresh app shard, so build the widgets
  // this test removes rather than relying on the previous test's session.
  await seedDashboard(browser, createCalls);
  await dashboardHas(browser, [
    "example-cloud-cost",
    "context",
    "tokens",
    "example-cloud-servers",
    "mcp",
  ]);
  await app.open("/?page=stats");
  await expect(screen.getByText("Live servers", { exact: true })).toBeVisible();

  // Visible: the servers widget keeps refreshing.
  await expect.poll(async () => (await readDashboard(browser)).polling).toBe(true);
  const first = (await readDashboard(browser)).values["example-cloud-servers"]?.updatedAt;
  await expect
    .poll(async () => (await readDashboard(browser)).values["example-cloud-servers"]?.updatedAt, {
      timeout: 10_000,
    })
    .not.toBe(first);

  // Hidden: once no client shows the page, polling stops and values stay put.
  await screen.getByRole("tab", "Chat").tap();
  await expect
    .poll(async () => (await readDashboard(browser)).polling, { timeout: 5_000 })
    .toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const parked = (await readDashboard(browser)).values["example-cloud-servers"]?.updatedAt;
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  expect((await readDashboard(browser)).values["example-cloud-servers"]?.updatedAt).toBe(parked);

  // Back on the page: polling resumes.
  await screen.getByRole("tab", "Stats").tap();
  await expect.poll(async () => (await readDashboard(browser)).polling).toBe(true);
  await expect
    .poll(async () => (await readDashboard(browser)).values["example-cloud-servers"]?.updatedAt, {
      timeout: 10_000,
    })
    .not.toBe(parked);

  // The user removes a widget from its menu.
  await screen.getByRole("button", "ExampleCloud monthly cost menu").tap();
  await screen.getByRole("menuitem", "Remove widget").tap();
  await expect
    .poll(() =>
      browser.evaluate(
        () => document.querySelector("[data-testid=widget-example-cloud-cost]") === null,
      ),
    )
    .toBe(true);
  expect((await readDashboard(browser)).widgets.map((w) => w.id)).not.toContain(
    "example-cloud-cost",
  );

  // The agent removes the other one and restores the default layout.
  await screen.getByRole("tab", "Chat").tap();
  await screen.getByRole("textbox", "Message").fill(`TOOLCALLS ${JSON.stringify(resetCalls)}`);
  await screen.getByRole("button", "Send").tap();
  await expect
    .poll(async () => (await readDashboard(browser)).widgets.map((w) => w.id), {
      timeout: 20_000,
    })
    .toEqual(defaultIds);
});

test("the MCP events widget shows at most 3 rows", async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  const events = Array.from({ length: 5 }, (_, index) => ({
    id: `e${index}`,
    server: "web",
    name: "alerts",
    timestamp: new Date(Date.UTC(2026, 9, 30, 1, 0, index)).toISOString(),
    summary: `alert ${index}`,
  }));
  await app.open("/");
  await seedDashboard(browser, resetCalls);
  await dashboardHas(browser, defaultIds);
  const state = await browser.evaluate(async () => {
    const res = await fetch("/api/state");
    return (await res.json()) as { [key: string]: JsonValue };
  });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({
      json: {
        ...state,
        mcpEvents: {
          subscriptions: [],
          events,
          notice: "new event from web",
          revision: 5,
        },
      },
    });
  });
  await app.open("/?page=stats");
  await expect(screen.getByTestId("widget-mcp-events")).toBeVisible();
  const read = await browser.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid="widget-mcp-events"] dl > div')];
    return {
      count: rows.length,
      ids: rows.map((row) => row.getAttribute("data-testid")),
    };
  });
  expect(read.count).toBe(3);
  expect(read.ids).toEqual(["stat-mcp-event-e4", "stat-mcp-event-e3", "stat-mcp-event-e2"]);
});

test("sparkline widgets render through recharts and honor their chart config", async ({
  app,
  browser,
  screen,
}) => {
  const geometry = (id: string) =>
    browser.evaluate((widgetId) => {
      const card = document.querySelector(`[data-testid="widget-${widgetId}"]`);
      const chart = card?.querySelector("[data-chart]");
      const svg = card?.querySelector("svg.recharts-surface");
      return {
        svg: svg !== null && svg !== undefined,
        chart: chart !== null && chart !== undefined,
        paths: card?.querySelectorAll("path").length ?? 0,
        rects: card?.querySelectorAll("rect").length ?? 0,
        height:
          chart instanceof HTMLElement ? Math.round(chart.getBoundingClientRect().height) : null,
      };
    }, id);

  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");
  await seedDashboard(browser, [sparkAreaCall]);
  await dashboardHas(browser, ["spark-history"]);
  await app.open("/?page=stats");
  await expect(screen.getByText("Spark history", { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await readDashboard(browser)).values["spark-history"]?.view !== undefined)
    .toBe(true);

  const area = await geometry("spark-history");
  expect(area.svg).toBe(true);
  expect(area.chart).toBe(true);
  expect(area.height).toBe(40);
  expect(area.paths + area.rects).toBeGreaterThan(0);

  await seedDashboard(browser, [sparkBarCall]);
  await expect
    .poll(async () => {
      const next = await geometry("spark-history");
      return next.paths + next.rects;
    })
    .toBeGreaterThan(area.paths + area.rects);
  const bar = await geometry("spark-history");
  expect(bar.svg).toBe(true);
  expect(bar.paths + bar.rects).toBeGreaterThan(area.paths + area.rects);

  await screen.getByRole("tab", "Chat").tap();
  await seedDashboard(browser, resetCalls);
  await dashboardHas(browser, defaultIds);
});

test("a chart draws two coloured series, a dashed projection, a reference line and x labels", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");
  await seedDashboard(browser, [spendChartCall]);
  await dashboardHas(browser, ["spend-chart"]);
  await app.open("/?page=stats");
  await expect(screen.getByText("Spend by day", { exact: true })).toBeVisible();
  await expect
    .poll(async () => (await readDashboard(browser)).values["spend-chart"]?.view !== undefined)
    .toBe(true);

  const read = await browser.evaluate(() => {
    const card = document.querySelector('[data-testid="widget-spend-chart"]');
    const paths = [...(card?.querySelectorAll("path") ?? [])];
    const strokes = paths
      .map((path) => path.getAttribute("stroke"))
      .filter((stroke): stroke is string => stroke?.startsWith("var(--color-") === true);
    return {
      strokes: [...new Set(strokes)],
      dashed: paths.filter((path) => path.getAttribute("stroke-dasharray") !== null).length,
      texts: [...(card?.querySelectorAll("text") ?? [])].map((text) => text.textContent),
      content: card?.textContent ?? "",
      bodyVisibility: getComputedStyle(document.body).visibility,
    };
  });
  expect(read.strokes.sort()).toEqual(["var(--color-s0)", "var(--color-s1)"]);
  expect(read.bodyVisibility).toBe("visible");
  expect(read.dashed).toBeGreaterThan(0);
  expect(read.content).toContain("Actual");
  expect(read.content).toContain("Projection");
  expect(read.content).toContain("Budget");
  expect(read.texts).toContain("15");

  await screen.getByRole("tab", "Chat").tap();
  await seedDashboard(browser, spendResetCalls);
  await expect
    .poll(async () => (await readDashboard(browser)).widgets.map((widget) => widget.id))
    .not.toContain("spend-chart");
});

test("the sparkline chart config rejects unknown keys", () => {
  const parsed = parseWidget(
    {
      id: "spark-config",
      title: "Spark config",
      kind: "sparkline",
      source: { type: "static" },
      mapping: { value: "value" },
      chart: {
        type: "bar",
        color: "var(--chart-2)",
        height: 48,
        yDomain: [0, 10],
        showTooltip: true,
      },
    },
    1,
  );
  assert.deepEqual(parsed.chart, {
    type: "bar",
    color: "var(--chart-2)",
    height: 48,
    yDomain: [0, 10],
    showTooltip: true,
  });
  assert.throws(
    () =>
      parseWidget(
        {
          id: "spark-bad",
          title: "Spark bad",
          kind: "sparkline",
          source: { type: "static" },
          mapping: { value: "value" },
          chart: { type: "area", glow: true },
        },
        1,
      ),
    /glow/,
  );
});
