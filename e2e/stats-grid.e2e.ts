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

const EXTRA_DEFAULT_IDS = [
  "host-usage",
  "prefix-moments",
  "prefix-cost",
  "hetzner",
  "hetzner-cost",
  "go-usage",
  "bg-jobs",
  "task-durations",
  "bots",
];

/** This file's older grid assertions use the five-widget Session board. */
type GridBrowser = {
  evaluate<T>(fn: (ids: string[]) => Promise<T> | T, ids: string[]): Promise<T>;
  evaluate<T>(fn: () => Promise<T> | T): Promise<T>;
};

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
test("drags a widget into free space, resizes it to half, and keeps both after reload", async ({
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
  await resetMinimalDashboard(browser);
  const status = await browser.evaluate(async () => {
    const response = await fetch("/api/dashboard/layout", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sections: [
          {
            widgets: [
              { id: "context", span: "full", x: 0, y: 0, w: 12, h: 2 },
              { id: "tokens", span: "full", x: 0, y: 4, w: 12, h: 4 },
              { id: "mcp", span: "full", x: 0, y: 10, w: 12, h: 4 },
              { id: "mcp-events", span: "full", x: 0, y: 16, w: 12, h: 4 },
              { id: "task-reopens", span: "full", x: 0, y: 22, w: 12, h: 4 },
            ],
          },
        ],
      }),
    });
    return response.status;
  });
  expect(status).toBe(200);
  await app.open("/?page=stats");
  await expect(screen.getByTestId("widget-context")).toBeVisible({ timeout: 30_000 });
  await expect(screen.getByTestId("widget-tokens")).toBeVisible({ timeout: 30_000 });
  patches.length = 0;

  const before = await readDashboard(browser);
  const slotsBefore = before.layout.sections.flatMap((section) => section.widgets);
  const tokensBefore = slotsBefore.find((slot) => slot.id === "tokens");
  const contextBefore = slotsBefore.find((slot) => slot.id === "context");
  expect(tokensBefore?.y).toBe(4);
  expect(contextBefore?.y).toBe(0);

  // The target row is free: context ends at y=2, tokens starts at y=4.
  await dragPointer(browser, '[data-widget-id="tokens"]', '[data-widget-id="context"]', 0, 168);
  await expect
    .poll(async () => {
      const dashboard = await readDashboard(browser);
      return dashboard.layout.sections
        .flatMap((section) => section.widgets)
        .find((slot) => slot.id === "tokens")?.y;
    })
    .toBe(2);
  const afterDrag = await readDashboard(browser);
  expect(
    afterDrag.layout.sections.flatMap((section) =>
      section.widgets.map((slot) => [slot.id, slot.x, slot.y]),
    ),
  ).toEqual([
    ["context", 0, 0],
    ["tokens", 0, 2],
    ["mcp", 0, 10],
    ["mcp-events", 0, 16],
    ["task-reopens", 0, 22],
  ]);
  await expect.poll(() => patches.length, { timeout: 5_000 }).toBe(1);

  // Resize the full-width card down to half of the 12-column grid.
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
        const slots = dashboard.layout.sections.flatMap((section) => section.widgets);
        const tokens = slots.find((item) => item.id === "tokens");
        const context = slots.find((item) => item.id === "context");
        return {
          tokens: tokens === undefined ? null : [tokens.span, tokens.w],
          context: context === undefined ? null : [context.x, context.y],
        };
      },
      { timeout: 8_000 },
    )
    .toEqual({ tokens: ["half", 6], context: [0, 0] });
  await expect.poll(() => patches.length, { timeout: 5_000 }).toBe(2);
  const resized = patches
    .at(-1)
    ?.sections.flatMap((section) => section.widgets)
    .find((slot) => slot.id === "tokens");
  expect(resized?.span).toBe("half");
  expect(resized?.w).toBe(6);

  // Polling re-renders must not move the committed cells after the drop.
  await browser.evaluate(
    () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 2_000)),
  );
  expect(
    (await readDashboard(browser)).layout.sections.flatMap((section) =>
      section.widgets.map((slot) => [slot.id, slot.x, slot.y]),
    ),
  ).toEqual([
    ["context", 0, 0],
    ["tokens", 0, 2],
    ["mcp", 0, 10],
    ["mcp-events", 0, 16],
    ["task-reopens", 0, 22],
  ]);

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
    (await readDashboard(browser)).layout.sections.flatMap((section) =>
      section.widgets.map((slot) => [slot.id, slot.x, slot.y, slot.span]),
    ),
  ).toEqual([
    ["context", 0, 0, "full"],
    ["tokens", 0, 2, "half"],
    ["mcp", 0, 10, "full"],
    ["mcp-events", 0, 16, "full"],
    ["task-reopens", 0, 22, "full"],
  ]);

  // The route is only for this test's PATCH assertions; leaving it registered
  // would intercept layout writes in every later test in the file.
  await browser.unroute("**/api/dashboard/layout");
});

type GridSnapshot = {
  spans: [string, string][];
  titles: (string | null)[];
  scrollTop: number;
};

/** The committed board and the reader's position: what a maximize round trip must leave alone. */
async function gridSnapshot(browser: {
  evaluate<T>(fn: () => Promise<T> | T): Promise<T>;
}): Promise<GridSnapshot> {
  const dashboard = await readDashboard(browser);
  const scrollTop = await browser.evaluate(
    () => document.querySelector<HTMLElement>('[data-testid="stats-page"]')?.scrollTop ?? -1,
  );
  return {
    spans: dashboard.layout.sections.flatMap((section) =>
      section.widgets.map((widget) => [widget.id, widget.span ?? ""] as [string, string]),
    ),
    titles: dashboard.layout.sections.map((section) => section.title ?? null),
    scrollTop,
  };
}

async function overlayHistoryId(browser: {
  evaluate<T>(fn: () => Promise<T> | T): Promise<T>;
}): Promise<string | null> {
  return browser.evaluate(() => {
    const state = window.history.state as { piWidgetFullscreen?: string } | null;
    return state?.piWidgetFullscreen ?? null;
  });
}

type OverlayCoverage = {
  left: number;
  top: number;
  width: number;
  height: number;
  innerWidth: number;
  innerHeight: number;
  inside: boolean;
  onDock: boolean;
};

/** The overlay's viewport rect and what a hit test at the dock finds on top. */
async function overlayCoverage(browser: {
  evaluate<T>(fn: () => Promise<T> | T): Promise<T>;
}): Promise<OverlayCoverage | null> {
  return browser.evaluate(() => {
    const overlay = document.querySelector<HTMLElement>(
      '[data-testid="widget-context-fullscreen"]',
    );
    if (overlay === null) return null;
    const rect = overlay.getBoundingClientRect();
    const point = document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 2);
    return {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      inside: point !== null && overlay.contains(point),
      onDock: point?.closest('[data-testid="composer-dock"]') !== null,
    };
  });
}

test("maximizes a widget to the viewport and closes from minimize, Escape and back", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 1000 });
  await app.open("/?page=stats");
  await browser.evaluate(async () => {
    const reset = await fetch("/api/dashboard/reset", { method: "POST" });
    if (!reset.ok) throw new Error(`reset failed: ${reset.status}`);
    return null;
  });
  await app.open("/?page=stats");
  await expect(screen.getByTestId("widget-context")).toBeVisible({ timeout: 30_000 });
  await expect(screen.getByTestId("widget-context-maximize")).toBeVisible();

  await browser.evaluate(() => {
    const page = document.querySelector<HTMLElement>('[data-testid="stats-page"]');
    if (page === null) throw new Error("missing stats page");
    page.scrollTop = Math.min(120, page.scrollHeight - page.clientHeight);
    return page.scrollTop;
  });
  const before = await gridSnapshot(browser);
  expect(before.scrollTop).toBeGreaterThan(0);

  await screen.getByTestId("widget-context-maximize").tap();
  await expect(screen.getByTestId("widget-context-fullscreen")).toBeVisible();
  await expect(screen.getByTestId("widget-context-minimize")).toBeVisible();
  expect(
    await browser.evaluate(() => {
      const overlay = document.querySelector('[data-testid="widget-context-fullscreen"]');
      return overlay === null ? -1 : overlay.querySelectorAll("button").length;
    }),
  ).toBe(1);
  expect(await overlayCoverage(browser)).toEqual({
    left: 0,
    top: 0,
    width: 1280,
    height: 1000,
    innerWidth: 1280,
    innerHeight: 1000,
    inside: true,
    onDock: false,
  });
  expect(await overlayHistoryId(browser)).toBe("context");
  expect(await browser.evaluate(() => window.location.search)).toBe("?page=stats");
  await expect
    .poll(() =>
      browser.evaluate(() => {
        const page = document.querySelector<HTMLElement>('[data-testid="stats-page"]');
        return {
          inert: page?.hasAttribute("inert") ?? false,
          ariaHidden: page?.getAttribute("aria-hidden") ?? null,
          pagerLock: page?.hasAttribute("data-pager-lock") ?? false,
          bodyOverflow: document.body.style.overflow,
        };
      }),
    )
    .toEqual({ inert: true, ariaHidden: "true", pagerLock: true, bodyOverflow: "hidden" });

  await screen.getByTestId("widget-context-minimize").tap();
  await expect(screen.getByTestId("widget-context-fullscreen")).toHaveCount(0);
  await expect(screen.getByTestId("widget-context-maximize")).toBeVisible();
  expect(await overlayHistoryId(browser)).toBeNull();
  expect(await gridSnapshot(browser)).toEqual(before);

  // A forward step returns to the stale entry that minimize left behind. Taking
  // that entry over must still let minimize close the overlay.
  await browser.evaluate(() => {
    window.history.forward();
    return null;
  });
  await expect.poll(() => overlayHistoryId(browser)).toBe("context");
  await screen.getByTestId("widget-context-maximize").tap();
  await expect(screen.getByTestId("widget-context-fullscreen")).toBeVisible();
  await screen.getByTestId("widget-context-minimize").tap();
  await expect(screen.getByTestId("widget-context-fullscreen")).toHaveCount(0);
  expect(await overlayHistoryId(browser)).toBeNull();
  expect(await gridSnapshot(browser)).toEqual(before);

  await screen.getByTestId("widget-context-maximize").tap();
  await expect(screen.getByTestId("widget-context-fullscreen")).toBeVisible();
  await browser.keyboard.press("Escape");
  await expect(screen.getByTestId("widget-context-fullscreen")).toHaveCount(0);
  await expect
    .poll(() => browser.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? null))
    .toBe("widget-context-maximize");
  expect(await overlayHistoryId(browser)).toBeNull();
  expect(await gridSnapshot(browser)).toEqual(before);

  await screen.getByTestId("widget-context-maximize").tap();
  await expect(screen.getByTestId("widget-context-fullscreen")).toBeVisible();
  await browser.back();
  await expect(screen.getByTestId("widget-context-fullscreen")).toHaveCount(0);
  await expect(screen.getByTestId("page-dot-stats")).toHaveAttribute("aria-selected", "true");
  expect(await browser.evaluate(() => window.location.search)).toBe("?page=stats");
  expect(await overlayHistoryId(browser)).toBeNull();
  expect(await gridSnapshot(browser)).toEqual(before);

  // A reload keeps the history entry but loses the overlay state. The overlay
  // must not reopen, and the next maximize must push instead of reusing the
  // stale marker (which would send minimize one page back).
  await screen.getByTestId("widget-context-maximize").tap();
  await expect(screen.getByTestId("widget-context-fullscreen")).toBeVisible();
  await browser.reload();
  await expect(screen.getByTestId("widget-context")).toBeVisible({ timeout: 30_000 });
  await expect(screen.getByTestId("widget-context-fullscreen")).toHaveCount(0);
  await expect.poll(() => overlayHistoryId(browser)).toBeNull();
  const historyLength = await browser.evaluate(() => window.history.length);
  await screen.getByTestId("widget-context-maximize").tap();
  await expect(screen.getByTestId("widget-context-fullscreen")).toBeVisible();
  expect(await browser.evaluate(() => window.history.length)).toBe(historyLength + 1);
  await screen.getByTestId("widget-context-minimize").tap();
  await expect(screen.getByTestId("widget-context-fullscreen")).toHaveCount(0);
  await expect(screen.getByTestId("page-dot-stats")).toHaveAttribute("aria-selected", "true");

  await browser.setViewport({ width: 390, height: 844 });
  await expect(screen.getByTestId("widget-context-maximize")).toBeVisible();
  await screen.getByTestId("widget-context-maximize").tap();
  await expect(screen.getByTestId("widget-context-minimize")).toBeVisible();
  expect(await overlayCoverage(browser)).toEqual({
    left: 0,
    top: 0,
    width: 390,
    height: 844,
    innerWidth: 390,
    innerHeight: 844,
    inside: true,
    onDock: false,
  });
  await screen.getByTestId("widget-context-minimize").tap();
  await expect(screen.getByTestId("widget-context-fullscreen")).toHaveCount(0);
});
