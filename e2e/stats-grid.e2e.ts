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

/** Drives the page's hold-to-drag pointer shim with the same synthetic events a touch or mouse test uses. */
async function dragPointer(
  browser: {
    evaluate<T>(
      fn: (input: {
        from: string;
        to: string;
        dx: number;
        dy: number;
        holdMs: number;
      }) => Promise<T> | T,
      input: { from: string; to: string; dx: number; dy: number; holdMs: number },
    ): Promise<T>;
  },
  from: string,
  to: string,
  dx = 0,
  dy = 0,
  holdMs = 400,
) {
  await browser.evaluate(
    async ({ from, to, dx, dy, holdMs }) => {
      const source = document.querySelector<HTMLElement>(from);
      const target = document.querySelector<HTMLElement>(to);
      if (source === null || target === null) throw new Error("missing drag element");
      const start = source.getBoundingClientRect();
      const end = target.getBoundingClientRect();
      const x0 = start.left + start.width / 2;
      const y0 = start.top + start.height / 2;
      const x1 = end.left + end.width / 2 + dx;
      const y1 = end.top + end.height / 2 + dy;
      const fire = (type: string, x: number, y: number, buttons: number) => {
        source.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: 11,
            pointerType: "mouse",
            isPrimary: true,
            clientX: x,
            clientY: y,
            button: 0,
            buttons,
          }),
        );
      };
      fire("pointerdown", x0, y0, 1);
      if (holdMs > 0) await new Promise((resolve) => setTimeout(resolve, holdMs));
      for (let step = 1; step <= 6; step += 1) {
        fire("pointermove", x0 + ((x1 - x0) * step) / 6, y0 + ((y1 - y0) * step) / 6, 1);
      }
      fire("pointerup", x1, y1, 0);
      return true;
    },
    { from, to, dx, dy, holdMs },
  );
}

/** A press that ends before the hold delay must stay a tap. */
async function tapPointer(
  browser: {
    evaluate<T>(fn: (selector: string) => Promise<T> | T, selector: string): Promise<T>;
  },
  selector: string,
) {
  await browser.evaluate(async (selector) => {
    const source = document.querySelector<HTMLElement>(selector);
    if (source === null) throw new Error("missing tap element");
    const box = source.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const fire = (type: string, buttons: number) => {
      source.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 13,
          pointerType: "mouse",
          isPrimary: true,
          clientX: x,
          clientY: y,
          button: 0,
          buttons,
        }),
      );
    };
    fire("pointerdown", 1);
    await new Promise((resolve) => setTimeout(resolve, 120));
    fire("pointerup", 0);
    return true;
  }, selector);
}

test("drags a widget to the top, resizes it to half, and keeps both after reload", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 1000 });
  const patches: PatchBody[] = [];
  await browser.route("**/api/dashboard/layout", async (route) => {
    if (route.request.method === "PATCH") {
      patches.push(JSON.parse(route.request.postData ?? "{}") as PatchBody);
    }
    await route.continue();
  });
  await app.open("/?page=stats");
  await expect(screen.getByTestId("widget-context")).toBeVisible({ timeout: 30_000 });
  await expect(screen.getByTestId("widget-tokens")).toBeVisible({ timeout: 30_000 });
  expect(
    await browser.evaluate(() => ({
      add: document.querySelectorAll('[data-testid="dashboard-add-section"]').length,
      sections: document.querySelectorAll('[data-testid="dashboard-section"]').length,
      widgets: document.querySelectorAll("[data-widget-id]").length,
    })),
  ).toEqual({ add: 0, sections: 1, widgets: 5 });

  await dragPointer(browser, '[data-widget-id="tokens"]', '[data-widget-id="context"]', 0, -18);
  await expect
    .poll(
      () =>
        browser.evaluate(() => {
          const page = document.querySelector("[data-testid=stats-page]");
          return [...(page?.querySelectorAll("[data-widget-id]") ?? [])].map((item) =>
            item.getAttribute("data-widget-id"),
          );
        }),
      { timeout: 5_000 },
    )
    .toEqual(["tokens", "context", "mcp", "mcp-events", "task-reopens"]);

  await expect.poll(() => patches.length, { timeout: 5_000 }).toBeGreaterThan(0);
  const first = patches.at(-1);
  expect(first?.sections[0]?.widgets.map((slot) => slot.id).slice(0, 2)).toEqual([
    "tokens",
    "context",
  ]);
  expect(first?.sections[0]?.widgets[0]?.y).toBeLessThan(
    first?.sections[0]?.widgets[1]?.y ?? Number.POSITIVE_INFINITY,
  );

  // Resize the first full-width card down to half of the 12-column grid.
  await browser.evaluate(() => {
    const card = document.querySelector<HTMLElement>('[data-widget-id="tokens"]');
    const handle = card?.querySelector<HTMLElement>(".react-resizable-handle-se");
    if (card === null || handle == null) throw new Error("missing resize handle");
    const box = card.getBoundingClientRect();
    const start = handle.getBoundingClientRect();
    const x0 = start.left + start.width / 2;
    const y0 = start.top + start.height / 2;
    const x1 = box.left + box.width / 2;
    const y1 = y0 + 12;
    const fire = (type: string, x: number, y: number, buttons: number) => {
      handle.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 12,
          pointerType: "mouse",
          isPrimary: true,
          clientX: x,
          clientY: y,
          button: 0,
          buttons,
        }),
      );
    };
    fire("pointerdown", x0, y0, 1);
    for (let step = 1; step <= 6; step += 1) {
      fire("pointermove", x0 + ((x1 - x0) * step) / 6, y0 + ((y1 - y0) * step) / 6, 1);
    }
    fire("pointerup", x1, y1, 0);
    return true;
  });

  await expect
    .poll(
      async () => {
        const dashboard = await readDashboard(browser);
        const slot = dashboard.layout.sections
          .flatMap((section) => section.widgets)
          .find((item) => item.id === "tokens");
        return slot === undefined ? null : [slot.span, slot.w];
      },
      { timeout: 8_000 },
    )
    .toEqual(["half", 6]);
  await expect.poll(() => patches.length, { timeout: 5_000 }).toBeGreaterThan(1);
  const resized = patches
    .at(-1)
    ?.sections.flatMap((section) => section.widgets)
    .find((slot) => slot.id === "tokens");
  expect(resized?.span).toBe("half");
  expect(resized?.w).toBe(6);

  // Reload: the stored coordinates and span drive the page again.
  await app.open("/?page=stats");
  await expect(screen.getByTestId("widget-tokens")).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() =>
      browser.evaluate(() => {
        const card = document.querySelector<HTMLElement>('[data-widget-id="tokens"]');
        return card?.getAttribute("data-span") ?? null;
      }),
    )
    .toBe("half");
  expect(
    await browser.evaluate(() => {
      const page = document.querySelector("[data-testid=stats-page]");
      return [...(page?.querySelectorAll("[data-widget-id]") ?? [])]
        .map((item) => item.getAttribute("data-widget-id"))
        .slice(0, 2);
    }),
  ).toEqual(["tokens", "context"]);

  // The route is only for this test's PATCH assertions; leaving it registered
  // would intercept layout writes in every later test in the file.
  await browser.unroute("**/api/dashboard/layout");
});

test("creates a section through the agent, then renames and deletes it", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 1600 });
  const calls = [
    {
      name: "dashboard_upsert",
      arguments: {
        id: "agent-note",
        title: "Agent note",
        kind: "markdown",
        source: { type: "static" },
        mapping: { text: "=Created by the agent" },
      },
    },
    {
      name: "dashboard_layout",
      arguments: {
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
          { title: "Agent", widgets: [{ id: "agent-note", span: "full" }] },
        ],
      },
    },
  ];
  await app.open("/");
  await screen.getByRole("textbox", "Message").fill(`TOOLCALLS ${JSON.stringify(calls)}`);
  await screen.getByRole("button", "Send").tap();
  await expect
    .poll(async () => (await readDashboard(browser)).layout.sections.length, { timeout: 30_000 })
    .toBe(2);
  await screen.getByRole("tab", "Stats").tap();
  await expect(screen.getByTestId("widget-agent-note")).toBeVisible({ timeout: 30_000 });

  expect(
    await browser.evaluate(() => ({
      add: document.querySelectorAll('[data-testid="dashboard-add-section"]').length,
      titles: [...document.querySelectorAll<HTMLInputElement>('[data-testid="section-title"]')].map(
        (input) => input.value || null,
      ),
      widgets: [...document.querySelectorAll<HTMLElement>("[data-widget-id]")].map(
        (card) => card.dataset.widgetId ?? "",
      ),
    })),
  ).toEqual({
    add: 0,
    titles: [null, "Agent"],
    widgets: ["context", "tokens", "mcp", "mcp-events", "task-reopens", "agent-note"],
  });

  const title = screen.getByRole("textbox", "Section title").first();
  await title.fill("Runtime");
  await title.press("Enter");
  await expect
    .poll(async () => (await readDashboard(browser)).layout.sections[0]?.title)
    .toBe("Runtime");

  await dragPointer(browser, '[data-widget-id="mcp"]', '[data-section-index="1"]');
  await expect
    .poll(async () => {
      const dashboard = await readDashboard(browser);
      return dashboard.layout.sections.map((section) =>
        section.widgets.map((slot) => slot.id).sort(),
      );
    })
    .toEqual([
      ["context", "mcp-events", "task-reopens", "tokens"],
      ["agent-note", "mcp"],
    ]);

  await screen.getByTestId("section-delete-1").tap();
  await expect
    .poll(async () => {
      const dashboard = await readDashboard(browser);
      return {
        sections: dashboard.layout.sections.map((section) =>
          section.widgets.map((slot) => slot.id).sort(),
        ),
        titles: dashboard.layout.sections.map((section) => section.title),
      };
    })
    .toEqual({
      sections: [["agent-note", "context", "mcp", "mcp-events", "task-reopens", "tokens"]],
      titles: ["Runtime"],
    });
});

test("hold-drags a card body but leaves a short tap alone", async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 1280, height: 1000 });
  const patches: PatchBody[] = [];
  await browser.route("**/api/dashboard/layout", async (route) => {
    if (route.request.method === "PATCH") {
      patches.push(JSON.parse(route.request.postData ?? "{}") as PatchBody);
    }
    await route.continue();
  });
  await app.open("/?page=stats");
  await expect(screen.getByTestId("widget-context")).toBeVisible({ timeout: 30_000 });

  const status = await browser.evaluate(async () => {
    const response = await fetch("/api/dashboard/layout", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sections: [
          {
            widgets: [
              { id: "context", span: "half", x: 0, y: 0, w: 6, h: 4 },
              { id: "tokens", span: "full", x: 0, y: 4, w: 12, h: 4 },
              { id: "mcp", span: "full", x: 0, y: 8, w: 12, h: 4 },
              { id: "mcp-events", span: "full", x: 0, y: 12, w: 12, h: 4 },
              { id: "task-reopens", span: "full", x: 0, y: 16, w: 12, h: 4 },
            ],
          },
        ],
      }),
    });
    return response.status;
  });
  expect(status).toBe(200);
  await expect
    .poll(() =>
      browser.evaluate(
        () =>
          document.querySelector<HTMLElement>('[data-widget-id="context"]')?.dataset.span ?? null,
      ),
    )
    .toBe("half");
  patches.length = 0;
  const left = await browser.evaluate(
    () =>
      document.querySelector<HTMLElement>('[data-widget-id="context"]')?.getBoundingClientRect()
        .left ?? null,
  );
  await dragPointer(browser, '[data-widget-id="context"]', '[data-widget-id="context"]', 120, 0);
  await expect.poll(() => patches.length, { timeout: 5_000 }).toBeGreaterThan(0);
  await expect
    .poll(async () => {
      const dashboard = await readDashboard(browser);
      const slot = dashboard.layout.sections
        .flatMap((section) => section.widgets)
        .find((item) => item.id === "context");
      return slot?.x ?? null;
    })
    .toBeGreaterThan(0);
  expect(
    await browser.evaluate(
      () =>
        document.querySelector<HTMLElement>('[data-widget-id="context"]')?.getBoundingClientRect()
          .left ?? null,
    ),
  ).toBeGreaterThan(left ?? 0);

  const patched = patches.length;
  const tapped = await browser.evaluate(() => {
    const card = document.querySelector<HTMLElement>('[data-widget-id="mcp"]');
    return card === null ? null : [card.dataset.widgetId ?? "", card.getBoundingClientRect().top];
  });
  await tapPointer(browser, '[data-widget-id="mcp"]');
  await browser.evaluate(
    () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 900)),
  );
  expect(patches.length).toBe(patched);
  expect(
    await browser.evaluate(() => {
      const card = document.querySelector<HTMLElement>('[data-widget-id="mcp"]');
      return card === null ? null : [card.dataset.widgetId ?? "", card.getBoundingClientRect().top];
    }),
  ).toEqual(tapped);

  await browser.unroute("**/api/dashboard/layout");
});

test("shows the resize corner only while its card is hovered", async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 1280, height: 1000 });
  await app.open("/?page=stats");
  await expect
    .poll(() =>
      browser.evaluate(
        () => document.querySelector('[data-testid="widget-context-resize"]') !== null,
      ),
    )
    .toBe(true);
  expect(
    await browser.evaluate(() => {
      const handle = document.querySelector<HTMLElement>('[data-testid="widget-context-resize"]');
      return handle === null ? null : getComputedStyle(handle).opacity;
    }),
  ).toBe("0");
  await screen.getByTestId("widget-context").hover();
  await expect
    .poll(() =>
      browser.evaluate(() => {
        const handle = document.querySelector<HTMLElement>('[data-testid="widget-context-resize"]');
        return handle === null ? null : getComputedStyle(handle).opacity;
      }),
    )
    .toBe("1");
});

test("applies an external PATCH title and y spacing while the page is open", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 1000 });
  await app.open("/?page=stats");
  await expect(screen.getByTestId("widget-context")).toBeVisible({ timeout: 30_000 });
  const response = await browser.evaluate(async () => {
    const result = await fetch("/api/dashboard/layout", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sections: [
          {
            title: "Agent layout",
            widgets: [
              { id: "context", span: "full", x: 0, y: 0, w: 12, h: 4 },
              { id: "tokens", span: "full", x: 0, y: 10, w: 12, h: 4 },
              { id: "mcp", span: "full", x: 0, y: 20, w: 12, h: 4 },
              { id: "mcp-events", span: "full", x: 0, y: 30, w: 12, h: 4 },
              { id: "task-reopens", span: "full", x: 0, y: 40, w: 12, h: 4 },
            ],
          },
        ],
      }),
    });
    return result.status;
  });
  expect(response).toBe(200);
  await expect
    .poll(() =>
      browser.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>('[data-testid="section-title"]');
        const context = document.querySelector<HTMLElement>('[data-widget-id="context"]');
        const tokens = document.querySelector<HTMLElement>('[data-widget-id="tokens"]');
        if (input === null || context === null || tokens === null) return null;
        return {
          title: input.value,
          gap: Math.round(tokens.getBoundingClientRect().top - context.getBoundingClientRect().top),
        };
      }),
    )
    .toEqual({ title: "Agent layout", gap: 560 });
});

test("packs a free drag collision into the persisted layout", async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 1280, height: 1000 });
  await app.open("/?page=stats");
  await expect(screen.getByTestId("widget-tokens")).toBeVisible({ timeout: 30_000 });
  const patched = await browser.evaluate(async () => {
    const response = await fetch("/api/dashboard/layout", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sections: [
          {
            widgets: [
              { id: "context", span: "full", x: 0, y: 0, w: 12, h: 2 },
              { id: "tokens", span: "full", x: 0, y: 4, w: 12, h: 4 },
              { id: "mcp", span: "full", x: 0, y: 8, w: 12, h: 4 },
              { id: "mcp-events", span: "full", x: 0, y: 12, w: 12, h: 4 },
              { id: "task-reopens", span: "full", x: 0, y: 30, w: 12, h: 4 },
            ],
          },
        ],
      }),
    });
    return response.status;
  });
  expect(patched).toBe(200);
  await app.open("/?page=stats");
  await expect(screen.getByTestId("widget-tokens")).toBeVisible({ timeout: 30_000 });

  await dragPointer(browser, '[data-widget-id="tokens"]', '[data-widget-id="tokens"]', 0, 56);

  await expect
    .poll(async () =>
      browser.evaluate(async () => {
        const dashboard = (await (await fetch("/api/dashboard")).json()) as {
          layout: {
            sections: { widgets: { id: string; x: number; y: number; w: number; h: number }[] }[];
          };
        };
        const slots = dashboard.layout.sections.flatMap((section) => section.widgets);
        const occupied = new Set<string>();
        let overlap = false;
        for (const slot of slots) {
          for (let row = slot.y; row < slot.y + slot.h; row += 1) {
            for (let column = slot.x; column < slot.x + slot.w; column += 1) {
              const key = `${column}:${row}`;
              if (occupied.has(key)) overlap = true;
              occupied.add(key);
            }
          }
        }
        const grid = document.querySelector<HTMLElement>(".dashboard-grid");
        if (grid === null) return null;
        const top = grid.getBoundingClientRect().top;
        const rendered = Object.fromEntries(
          [...document.querySelectorAll<HTMLElement>("[data-widget-id]")].map((card) => [
            card.dataset.widgetId,
            Math.round((card.getBoundingClientRect().top - top) / 56),
          ]),
        );
        return {
          overlap,
          stored: Object.fromEntries(slots.map((slot) => [slot.id, slot.y])),
          rendered,
        };
      }),
    )
    .toEqual({
      overlap: false,
      stored: { context: 0, tokens: 5, mcp: 9, "mcp-events": 13, "task-reopens": 30 },
      rendered: { context: 0, tokens: 5, mcp: 9, "mcp-events": 13, "task-reopens": 30 },
    });
});

test("resizes with touch and disables page scrolling on the resize handle", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 1000 });
  await app.open("/?page=stats");
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
