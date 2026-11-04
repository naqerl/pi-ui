import { test } from "@e2e-dev/web";
import { expect } from "e2e";

type PatchBody = {
  sections: {
    title?: string;
    widgets: { id: string; span?: string; x?: number; y?: number; w?: number; h?: number }[];
  }[];
};

type DashboardRead = {
  layout: PatchBody;
  widgets: { id: string }[];
  values: Record<string, { error?: string; view?: unknown }>;
};

async function readDashboard(browser: {
  evaluate<T>(fn: () => Promise<T> | T): Promise<T>;
}): Promise<DashboardRead> {
  return browser.evaluate(async () => {
    const response = await fetch("/api/dashboard");
    return (await response.json()) as DashboardRead;
  });
}

async function callDashboard(
  browser: {
    evaluate<T>(fn: (text: string) => Promise<T> | T, text: string): Promise<T>;
  },
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

const EXTRA_DEFAULT_IDS = [
  "host-usage",
  "prefix-moments",
  "prefix-cost",
  "hetzner",
  "hetzner-cost",
  "go-usage",
  "bg-jobs",
];

type GridBrowser = {
  evaluate<T>(fn: (ids: string[]) => Promise<T> | T, ids: string[]): Promise<T>;
  evaluate<T>(fn: () => Promise<T> | T): Promise<T>;
};

/** Keep the five-widget Session board these grid assertions were written for. */
async function resetMinimalDashboard(browser: GridBrowser) {
  await browser.evaluate(async (ids) => {
    const reset = await fetch("/api/dashboard/reset", { method: "POST" });
    if (!reset.ok) throw new Error(`reset failed: ${reset.status}`);
    for (const id of ids) {
      const removed = await fetch(`/api/dashboard/widgets/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!removed.ok) throw new Error(`delete ${id} failed: ${removed.status}`);
    }
    const layout = await fetch("/api/dashboard/layout", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sections: [
          {
            widgets: [
              { id: "context", span: "full" },
              { id: "tokens", span: "full" },
              { id: "mcp", span: "full" },
              { id: "mcp-events", span: "full" },
              { id: "task-reopens", span: "full" },
            ],
          },
        ],
      }),
    });
    if (!layout.ok) throw new Error(`layout failed: ${layout.status}`);
    return null;
  }, EXTRA_DEFAULT_IDS);
  await expect.poll(async () => (await readDashboard(browser)).layout.sections.length).toBe(1);
  await expect
    .poll(async () => (await readDashboard(browser)).widgets.map((widget) => widget.id))
    .toEqual(["context", "tokens", "mcp", "mcp-events", "task-reopens"]);
}

const pinValues = [10, 20, 30, 40, 50, 60, 70, 80];

function pinChartCall(id: string) {
  return {
    name: "dashboard_upsert",
    arguments: {
      id,
      title: id === "pin-touch" ? "Touch chart" : "Pinned chart",
      kind: "sparkline",
      source: {
        type: "poll",
        script: `return { values: ${JSON.stringify(pinValues)} };`,
        intervalSec: 0.5,
      },
      mapping: { series: "values" },
      chart: {
        height: 160,
        showTooltip: true,
        y: { format: "currency", ticks: 4 },
        x: { labels: pinValues.map((_, index) => String(index)) },
        series: [{ key: "values", label: "Value", color: "var(--chart-1)", type: "line" }],
      },
    },
  };
}

async function waitForChart(
  browser: {
    evaluate<T>(fn: () => Promise<T> | T): Promise<T>;
  },
  id: string,
) {
  await expect
    .poll(async () => (await readDashboard(browser)).values[id]?.view !== undefined, {
      timeout: 30_000,
    })
    .toBe(true);
}

function readPin(
  browser: {
    evaluate<T>(fn: (id: string) => T, id: string): Promise<T>;
  },
  id: string,
) {
  return browser.evaluate((widgetId) => {
    const card = document.querySelector(`[data-testid="widget-${widgetId}"]`);
    const chart = document.querySelector<HTMLElement>(`[data-chart-widget="${widgetId}"]`);
    const caption = card?.querySelector<HTMLElement>('[data-testid="chart-pin-caption"]');
    const status = card?.querySelector<HTMLElement>('[data-testid="chart-pin-status"]');
    const box = chart?.getBoundingClientRect();
    return {
      height: box === undefined ? 0 : Math.round(box.height),
      line: card?.querySelector('[data-testid="chart-pin"]') !== null,
      dots: card?.querySelectorAll('[data-testid="chart-pin-dot"]').length ?? 0,
      caption: caption?.textContent ?? null,
      status: status?.textContent ?? null,
    };
  }, id);
}

type ChartLocator = {
  scrollIntoView(): Promise<void>;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  click(options: { position: { x: number; y: number } }): Promise<void>;
  tap(options: { position: { x: number; y: number } }): Promise<void>;
};

async function clickChart(
  browser: { locator(selector: string): ChartLocator },
  id: string,
  ratio: number,
  pointerType: "mouse" | "touch" = "touch",
) {
  const chart = browser.locator(`[data-chart-widget="${id}"]`);
  await chart.scrollIntoView();
  const box = await chart.boundingBox();
  if (box === null) throw new Error("missing chart");
  // Click the center of the row rather than the boundary between two rows.
  const position = { x: box.width * ratio, y: box.height / 2 };
  if (pointerType === "mouse") await chart.click({ position });
  else await chart.tap({ position });
}

test("resizes with touch and disables page scrolling on the resize handle", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 1000 });
  await app.open("/?page=stats");
  await resetMinimalDashboard(browser);
  await expect(screen.getByTestId("widget-context-resize")).toBeVisible({ timeout: 30_000 });
  expect(
    await browser.evaluate(() => {
      const handle = document.querySelector<HTMLElement>('[data-testid="widget-context-resize"]');
      return handle === null ? null : getComputedStyle(handle).touchAction;
    }),
  ).toBe("none");
  await browser.evaluate(() => {
    const card = document.querySelector<HTMLElement>('[data-widget-id="context"]');
    const handle = card?.querySelector<HTMLElement>(".react-resizable-handle-se");
    if (card === null || card === undefined || handle === null || handle === undefined) {
      throw new Error("missing resize handle");
    }
    const box = card.getBoundingClientRect();
    const start = handle.getBoundingClientRect();
    const x0 = start.left + start.width / 2;
    const y0 = start.top + start.height / 2;
    const x1 = box.left + box.width / 2;
    const fire = (type: string, x: number, y: number, buttons: number) =>
      handle.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 32,
          pointerType: "touch",
          isPrimary: true,
          clientX: x,
          clientY: y,
          button: 0,
          buttons,
        }),
      );
    fire("pointerdown", x0, y0, 1);
    for (let step = 1; step <= 6; step += 1) {
      fire("pointermove", x0 + ((x1 - x0) * step) / 6, y0, 1);
    }
    fire("pointerup", x1, y0, 0);
    return true;
  });
  await expect
    .poll(async () => {
      const dashboard = await readDashboard(browser);
      const slot = dashboard.layout.sections
        .flatMap((section) => section.widgets)
        .find((item) => item.id === "context");
      return slot === undefined ? null : [slot.span, slot.w];
    })
    .toEqual(["half", 6]);
  expect(
    await browser.evaluate(
      () => document.querySelector<HTMLElement>('[data-widget-id="context"]')?.dataset.span ?? null,
    ),
  ).toBe("half");
});

test("PATCH /api/dashboard/layout rejects an unknown widget id", async ({ app, browser }) => {
  await app.open("/");
  const result = await browser.evaluate(async () => {
    const response = await fetch("/api/dashboard/layout", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sections: [{ widgets: [{ id: "not-a-widget" }] }] }),
    });
    return { status: response.status, text: await response.text() };
  });
  expect(result.status).toBe(400);
  expect(result.text).toContain("not-a-widget");
});

test("a phone-width viewport keeps the single-column stack and no drag grips", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=stats");
  await resetMinimalDashboard(browser);
  await expect(screen.getByTestId("stats-page")).toBeVisible({ timeout: 30_000 });
  await expect(screen.getByTestId("widget-context")).toBeVisible({ timeout: 30_000 });
  expect(
    await browser.evaluate(() => ({
      grips: document.querySelectorAll(".dashboard-drag-handle").length,
      add: document.querySelectorAll('[data-testid="dashboard-add-section"]').length,
      grids: document.querySelectorAll(".dashboard-grid").length,
      stacks: document.querySelectorAll('[data-testid^="dashboard-stack-"]').length,
    })),
  ).toEqual({ grips: 0, add: 0, grids: 0, stacks: 1 });
  expect(
    await browser.evaluate(() => {
      const cards = [...document.querySelectorAll("[data-widget-id]")];
      return cards.every((card) => {
        const box = card.getBoundingClientRect();
        return box.width > 0 && box.right <= window.innerWidth + 0.5;
      });
    }),
  ).toBe(true);

  // Crossing md after mount must measure the newly rendered grid instead of
  // keeping the mobile mount's fallback width.
  await browser.setViewport({ width: 800, height: 900 });
  await expect(screen.getByTestId("widget-context")).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() =>
      browser.evaluate(() => {
        const grid = document.querySelector<HTMLElement>(".dashboard-grid");
        const card = document.querySelector<HTMLElement>('[data-widget-id="context"]');
        const page = document.querySelector<HTMLElement>("[data-testid=stats-page]");
        if (grid === null || card === null || page === null) return null;
        const gridBox = grid.getBoundingClientRect();
        const cardBox = card.getBoundingClientRect();
        return {
          grid: Math.round(gridBox.width),
          card: Math.round(cardBox.width),
          inside: cardBox.right <= window.innerWidth + 0.5,
          overflow: page.scrollWidth > page.clientWidth,
        };
      }),
    )
    .toEqual({ grid: 768, card: 768, inside: true, overflow: false });
  expect(
    await browser.evaluate(() => ({
      grips: document.querySelectorAll(".dashboard-drag-handle").length,
      resize: document.querySelectorAll(".dashboard-resize-handle").length,
    })),
  ).toEqual({ grips: 0, resize: 5 });
});

test("clicking a chart pins its row, a second click or Escape clears it, and a drag does not pin", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 1000 });
  await app.open("/?page=stats");
  await expect(screen.getByTestId("stats-page")).toBeVisible({ timeout: 30_000 });
  await callDashboard(browser, [pinChartCall("pin-chart")]);
  try {
    await expect(screen.getByText("Pinned chart", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await waitForChart(browser, "pin-chart");

    const center = await browser.evaluate(() => {
      const chart = document.querySelector<HTMLElement>('[data-chart-widget="pin-chart"]');
      if (chart === null) return null;
      chart.scrollIntoView({ block: "center" });
      const box = chart.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    });
    expect(center).not.toBeNull();
    if (center === null) throw new Error("missing chart box");
    await browser.mouse.move(center.x, center.y);
    await expect
      .poll(() =>
        browser.evaluate(
          () =>
            document.querySelector('[data-testid="widget-pin-chart"] .recharts-tooltip-wrapper')
              ?.textContent ?? "",
        ),
      )
      .toContain("Value");

    await clickChart(browser, "pin-chart", 4 / 7, "mouse");
    await expect
      .poll(() => readPin(browser, "pin-chart"))
      .toEqual({
        height: 160,
        line: true,
        dots: 1,
        caption: "4\nValue: €50",
        status: "4\nValue: €50",
      });

    await clickChart(browser, "pin-chart", 4 / 7, "mouse");
    await expect
      .poll(() => readPin(browser, "pin-chart"))
      .toEqual({ height: 160, line: false, dots: 0, caption: null, status: "" });

    await clickChart(browser, "pin-chart", 4 / 7, "mouse");
    await expect.poll(() => readPin(browser, "pin-chart").then((state) => state.line)).toBe(true);
    await browser.keyboard.press("Escape");
    await expect.poll(() => readPin(browser, "pin-chart").then((state) => state.line)).toBe(false);

    const dragChart = browser.locator('[data-chart-widget="pin-chart"]');
    await dragChart.scrollIntoView();
    const box = await dragChart.boundingBox();
    if (box === null) throw new Error("missing chart");
    const y = box.y + box.height / 2;
    const x0 = box.x + box.width * 0.25;
    const x1 = box.x + box.width * 0.75;
    await browser.mouse.move(x0, y);
    await browser.mouse.down();
    await browser.mouse.move(x0 + 30, y);
    await browser.mouse.move(x1, y);
    await browser.mouse.up();
    await expect.poll(() => readPin(browser, "pin-chart").then((state) => state.line)).toBe(false);
  } finally {
    await callDashboard(browser, [{ name: "dashboard_remove", arguments: { id: "pin-chart" } }]);
    await expect
      .poll(async () => (await readDashboard(browser)).widgets.map((widget) => widget.id))
      .not.toContain("pin-chart");
  }
});

test("a tap on a phone viewport pins the same row without a hover", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=stats");
  await expect(screen.getByTestId("stats-page")).toBeVisible({ timeout: 30_000 });
  await callDashboard(browser, [pinChartCall("pin-touch")]);
  try {
    await expect(screen.getByText("Touch chart", { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await waitForChart(browser, "pin-touch");

    await clickChart(browser, "pin-touch", 4 / 7);
    await expect
      .poll(() => readPin(browser, "pin-touch"))
      .toEqual({
        height: 160,
        line: true,
        dots: 1,
        caption: "4\nValue: €50",
        status: "4\nValue: €50",
      });
    expect((await readPin(browser, "pin-touch")).height).toBeGreaterThanOrEqual(24);

    await clickChart(browser, "pin-touch", 4 / 7);
    await expect.poll(() => readPin(browser, "pin-touch").then((state) => state.line)).toBe(false);
  } finally {
    await callDashboard(browser, [{ name: "dashboard_remove", arguments: { id: "pin-touch" } }]);
    await expect
      .poll(async () => (await readDashboard(browser)).widgets.map((widget) => widget.id))
      .not.toContain("pin-touch");
  }
});
