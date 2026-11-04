import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const state = {
  conversationId: "theme-tokens-e2e",
  messages: [],
  activity: [],
  run: "idle",
  queue: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
  context: { tokens: 0, window: 200_000, percent: 0 },
  mcp: {
    servers: [{ name: "web", available: true, authRejected: false, tools: ["search"] }],
    unavailable: [],
  },
};

const suffix = `${process.pid}-${Date.now().toString(36)}`;
const themeRoot = join(process.cwd(), ".e2e/home/.config/omarchy/themes");
const first = `e2e-tokens-a-${suffix}`;
const second = `e2e-tokens-b-${suffix}`;

function colorsToml(options: {
  mode: "light" | "dark";
  background: string;
  foreground: string;
  palette: {
    red: string;
    green: string;
    yellow: string;
    blue: string;
    magenta: string;
    cyan: string;
    orange: string;
    brown: string;
  };
}): string {
  return [
    `mode = "${options.mode}"`,
    `background = "${options.background}"`,
    `foreground = "${options.foreground}"`,
    ...Object.entries(options.palette).map(([name, value]) => `${name} = "${value}"`),
    "",
  ].join("\n");
}

const themes = {
  first: colorsToml({
    mode: "dark",
    background: "#101315",
    foreground: "#d8dee9",
    palette: {
      red: "#e05a5a",
      green: "#57c785",
      yellow: "#e5c158",
      blue: "#3d9bff",
      magenta: "#b978ff",
      cyan: "#43d4d0",
      orange: "#ff9558",
      brown: "#a98268",
    },
  }),
  second: colorsToml({
    mode: "light",
    background: "#f3eee6",
    foreground: "#2f2a25",
    palette: {
      red: "#b42318",
      green: "#027a48",
      yellow: "#a15c00",
      blue: "#175cd3",
      magenta: "#9b2c8f",
      cyan: "#0e7490",
      orange: "#c2410c",
      brown: "#78350f",
    },
  }),
};

const chartCall = {
  name: "dashboard_upsert",
  arguments: {
    id: "theme-chart",
    title: "Theme chart",
    kind: "sparkline",
    source: {
      type: "poll",
      script: "return { values: [1, 3, 2, 5] };",
      intervalSec: 0.5,
    },
    mapping: { series: "values", label: "=series" },
    chart: { type: "line", height: 80 },
  },
};

type Readout = {
  status: string | null;
  chart: string | null;
  chartTokens: string[];
  statusInfo: string;
};

test("theme palette drives status dots and chart series, and rejects literal colours", async ({
  app,
  browser,
  screen,
}) => {
  await mkdir(join(themeRoot, first), { recursive: true });
  await mkdir(join(themeRoot, second), { recursive: true });
  await writeFile(join(themeRoot, first, "colors.toml"), themes.first, "utf8");
  await writeFile(join(themeRoot, second, "colors.toml"), themes.second, "utf8");

  const readout = (): Promise<Readout> =>
    browser.evaluate(() => {
      const dot = document.querySelector('[data-testid="stat-mcp-web"] [role="img"]');
      const line = document.querySelector(
        '[data-testid="widget-theme-chart"] .recharts-line-curve',
      );
      const root = getComputedStyle(document.documentElement);
      return {
        status: dot === null ? null : getComputedStyle(dot).backgroundColor,
        chart: line === null ? null : getComputedStyle(line).stroke,
        chartTokens: Array.from({ length: 6 }, (_, index) =>
          root.getPropertyValue(`--chart-${index + 1}`).trim(),
        ),
        statusInfo: root.getPropertyValue("--status-info").trim(),
      };
    });

  const ready = async () => {
    const read = await readout();
    return read.status !== null && read.chart !== null;
  };

  const choose = async (slug: string) => {
    const saved = await browser.evaluate(async (id) => {
      const response = await fetch("/api/theme", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: id }),
      });
      return response.ok;
    }, slug);
    expect(saved).toBe(true);
    await app.open("/?page=stats");
    await expect(screen.getByTestId("stat-mcp-web")).toBeVisible();
    await expect.poll(ready, { timeout: 30_000 }).toBe(true);
    return readout();
  };

  const send = (calls: unknown[]) =>
    browser.evaluate(
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

  const lastAssistant = () =>
    browser.evaluate(
      () =>
        [...document.querySelectorAll<HTMLElement>('[data-role="assistant"]')].at(-1)
          ?.textContent ?? "",
    );

  try {
    await browser.setViewport({ width: 390, height: 844 });
    await browser.route("**/api/state**", async (route) => {
      await route.fulfill({ json: state });
    });
    await app.open("/");
    await send([chartCall]);
    await app.open("/?page=stats");
    await expect(screen.getByTestId("widget-theme-chart")).toBeVisible();

    const before = await choose(first);
    expect(before.status).not.toBeNull();
    expect(before.chart).not.toBeNull();
    expect(before.chartTokens.every((token) => token.length > 0)).toBe(true);
    expect(before.statusInfo.length).toBeGreaterThan(0);

    const after = await choose(second);
    expect(after.status).not.toBeNull();
    expect(after.chart).not.toBeNull();
    expect(after.status).not.toBe(before.status);
    expect(after.chart).not.toBe(before.chart);

    await browser.unroute("**/api/state**");
    await app.open("/");
    await expect(screen.getByRole("textbox", "Message")).toBeVisible();
    const base = {
      id: "theme-literal-check",
      title: "Literal check",
      kind: "sparkline",
      source: { type: "static" },
      mapping: { value: "value" },
    };
    await send([{ name: "dashboard_upsert", arguments: { ...base, chart: { color: "#ff0000" } } }]);
    await expect.poll(lastAssistant, { timeout: 30_000 }).toContain("literal");
    await send([
      { name: "dashboard_upsert", arguments: { ...base, chart: { color: "var(--chart-2)" } } },
    ]);
    await expect
      .poll(
        () =>
          browser.evaluate(async () => {
            const response = await fetch("/api/dashboard");
            const dashboard = (await response.json()) as { widgets: { id: string }[] };
            return dashboard.widgets.some((widget) => widget.id === "theme-literal-check");
          }),
        { timeout: 30_000 },
      )
      .toBe(true);
  } finally {
    await rm(join(themeRoot, first), { recursive: true, force: true });
    await rm(join(themeRoot, second), { recursive: true, force: true });
  }
});
