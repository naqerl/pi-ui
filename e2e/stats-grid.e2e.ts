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

test("resizing one widget leaves its neighbours' widths and spans alone", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 1000 });
  await app.open("/?page=stats");
  await resetMinimalDashboard(browser);
  const patched = await browser.evaluate(async () => {
    const response = await fetch("/api/dashboard/layout", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sections: [
          {
            widgets: [
              { id: "context", span: "half", x: 0, y: 0, w: 5, h: 4 },
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
  expect(patched).toBe(200);
  await app.open("/?page=stats");
  await expect(screen.getByTestId("widget-tokens-resize")).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => {
      const dashboard = await readDashboard(browser);
      const slot = dashboard.layout.sections
        .flatMap((section) => section.widgets)
        .find((item) => item.id === "context");
      return slot === undefined ? null : [slot.span, slot.w];
    })
    .toEqual(["half", 5]);

  await browser.evaluate(() => {
    const card = document.querySelector<HTMLElement>('[data-widget-id="tokens"]');
    const handle = card?.querySelector<HTMLElement>(".react-resizable-handle-se");
    if (card === null || card === undefined || handle === null || handle === undefined) {
      throw new Error("missing resize handle");
    }
    const box = card.getBoundingClientRect();
    const start = handle.getBoundingClientRect();
    const x0 = start.left + start.width / 2;
    const y0 = start.top + start.height / 2;
    const x1 = box.left + box.width / 2;
    const fire = (type: string, x: number, buttons: number) =>
      handle.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 17,
          pointerType: "mouse",
          isPrimary: true,
          clientX: x,
          clientY: y0,
          button: 0,
          buttons,
        }),
      );
    fire("pointerdown", x0, 1);
    for (let step = 1; step <= 6; step += 1) {
      fire("pointermove", x0 + ((x1 - x0) * step) / 6, 1);
    }
    fire("pointerup", x1, 0);
    return true;
  });

  await expect
    .poll(async () => {
      const dashboard = await readDashboard(browser);
      const slots = dashboard.layout.sections.flatMap((section) => section.widgets);
      const context = slots.find((slot) => slot.id === "context");
      const tokens = slots.find((slot) => slot.id === "tokens");
      return {
        context: context === undefined ? null : [context.span, context.w],
        tokens: tokens === undefined ? null : [tokens.span, tokens.w],
      };
    })
    .toEqual({ context: ["half", 5], tokens: ["half", 6] });
});

test("a real mouse drag of context by two columns and rows leaves neighbours still", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 1000 });
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
              { id: "context", span: "third", x: 0, y: 0, w: 4, h: 2 },
              { id: "tokens", span: "half", x: 6, y: 0, w: 6, h: 4 },
              { id: "mcp", span: "full", x: 0, y: 6, w: 12, h: 4 },
              { id: "mcp-events", span: "full", x: 0, y: 12, w: 12, h: 4 },
              { id: "task-reopens", span: "full", x: 0, y: 18, w: 12, h: 4 },
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

  const before = await readDashboard(browser);
  const beforeSlots = before.layout.sections
    .flatMap((section) => section.widgets)
    .map((slot) => [slot.id, slot.x, slot.y]);
  const geometry = await browser.evaluate(() => {
    const grid = document.querySelector<HTMLElement>(".dashboard-grid");
    const handle = document.querySelector<HTMLElement>(
      '[data-widget-id="context"] [data-testid="dashboard-drag-handle"]',
    );
    if (grid === null || handle === null) return null;
    const box = handle.getBoundingClientRect();
    const width = grid.getBoundingClientRect().width;
    const column = (width - 12 * 11) / 12 + 12;
    return { x: box.left + box.width / 2, y: box.top + box.height / 2, column, row: 44 + 12 };
  });
  expect(geometry).not.toBeNull();
  if (geometry === null) throw new Error("missing drag geometry");
  const { x, y, column, row } = geometry;
  await browser.mouse.move(x, y);
  await browser.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await browser.mouse.move(x + (column * 2 * step) / 8, y + (row * 2 * step) / 8);
  }
  await browser.mouse.up();

  await expect
    .poll(async () => {
      const dashboard = await readDashboard(browser);
      const slot = dashboard.layout.sections
        .flatMap((section) => section.widgets)
        .find((item) => item.id === "context");
      return slot === undefined ? null : [slot.x, slot.y];
    })
    .toEqual([2, 2]);
  const afterSlots = (await readDashboard(browser)).layout.sections
    .flatMap((section) => section.widgets)
    .map((slot) => [slot.id, slot.x, slot.y]);
  expect(afterSlots).toEqual([
    ["tokens", 6, 0],
    ["context", 2, 2],
    ["mcp", 0, 6],
    ["mcp-events", 0, 12],
    ["task-reopens", 0, 18],
  ]);
  for (const [id, slotX, slotY] of beforeSlots) {
    if (id === "context") continue;
    expect(
      afterSlots.some(
        ([afterId, afterX, afterY]) => afterId === id && afterX === slotX && afterY === slotY,
      ),
    ).toBe(true);
  }

  // Polling keeps re-rendering the page; none of that may move a committed cell.
  await browser.evaluate(
    () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 2_000)),
  );
  expect(
    (await readDashboard(browser)).layout.sections.flatMap((section) =>
      section.widgets.map((slot) => [slot.id, slot.x, slot.y]),
    ),
  ).toEqual([
    ["tokens", 6, 0],
    ["context", 2, 2],
    ["mcp", 0, 6],
    ["mcp-events", 0, 12],
    ["task-reopens", 0, 18],
  ]);

  await app.open("/?page=stats");
  await expect(screen.getByTestId("widget-context")).toBeVisible({ timeout: 30_000 });
  expect(
    (await readDashboard(browser)).layout.sections.flatMap((section) =>
      section.widgets.map((slot) => [slot.id, slot.x, slot.y]),
    ),
  ).toEqual([
    ["tokens", 6, 0],
    ["context", 2, 2],
    ["mcp", 0, 6],
    ["mcp-events", 0, 12],
    ["task-reopens", 0, 18],
  ]);
});

test("creates a section through the agent, moves a widget into it, then renames and deletes it", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 1800 });
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
  await resetMinimalDashboard(browser);
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

  // Crossing the Agent heading moves mcp out of the first grid and appends it
  // below the card the agent already placed there.
  const drop = await browser.evaluate(() => {
    const handle = document.querySelector<HTMLElement>(
      '[data-widget-id="mcp"] [data-testid="dashboard-drag-handle"]',
    );
    const heading = document.querySelector<HTMLElement>(
      '[data-section-index="1"] [data-section-heading]',
    );
    const grid = document.querySelector<HTMLElement>('[data-section-index="1"] .dashboard-grid');
    if (handle === null || heading === null || grid === null) return null;
    const from = handle.getBoundingClientRect();
    const head = heading.getBoundingClientRect();
    const box = grid.getBoundingClientRect();
    return {
      x0: from.left + from.width / 2,
      y0: from.top + from.height / 2,
      x1: box.left + box.width / 2,
      y1: box.top + 24,
      headingTop: head.top,
    };
  });
  expect(drop).not.toBeNull();
  if (drop === null) throw new Error("missing cross-section drag geometry");
  await browser.mouse.move(drop.x0, drop.y0);
  await browser.mouse.down();
  for (let step = 1; step <= 10; step += 1) {
    await browser.mouse.move(
      drop.x0 + ((drop.x1 - drop.x0) * step) / 10,
      drop.y0 + ((drop.y1 - drop.y0) * step) / 10,
    );
  }
  expect(
    await browser.evaluate(
      () =>
        document
          .querySelector<HTMLElement>('[data-section-index="1"]')
          ?.hasAttribute("data-drop-target") ?? false,
    ),
  ).toBe(true);
  // The delete below reuses the same debounced save path, so wait for the
  // cross-section PATCH response instead of racing its 600 ms timer.
  const saved = browser.waitForResponse("**/api/dashboard/layout", { timeout: 10_000 });
  await browser.mouse.up();
  await saved;
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
  expect(
    await browser.evaluate(
      () =>
        document
          .querySelector<HTMLElement>('[data-section-index="1"]')
          ?.hasAttribute("data-drop-target") ?? false,
    ),
  ).toBe(false);

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

test("a phone drag cannot move a widget into another section", async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=stats");
  await resetMinimalDashboard(browser);
  const status = await browser.evaluate(async () => {
    const response = await fetch("/api/dashboard/layout", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sections: [
          {
            title: "A",
            widgets: [
              { id: "context", span: "full" },
              { id: "tokens", span: "full" },
              { id: "mcp", span: "full" },
            ],
          },
          {
            title: "B",
            widgets: [
              { id: "mcp-events", span: "full" },
              { id: "task-reopens", span: "full" },
            ],
          },
        ],
      }),
    });
    return response.status;
  });
  expect(status).toBe(200);
  await app.open("/?page=stats");
  await expect(screen.getByTestId("widget-tokens")).toBeVisible({ timeout: 30_000 });
  const sections = async () => {
    const dashboard = await readDashboard(browser);
    return dashboard.layout.sections.map((section) =>
      section.widgets.map((widget) => widget.id).sort(),
    );
  };
  const before = await sections();

  const start = await browser.evaluate(() => {
    const handle = document.querySelector<HTMLElement>(
      '[data-widget-id="tokens"] [data-testid="dashboard-drag-handle"]',
    );
    const target = document.querySelector<HTMLElement>('[data-widget-id="mcp-events"]');
    if (handle === null || target === null) return null;
    const from = handle.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    return {
      x0: from.left + from.width / 2,
      y0: from.top + from.height / 2,
      x1: to.left + to.width / 2,
      y1: to.top + to.height / 2,
    };
  });
  expect(start).not.toBeNull();
  if (start === null) throw new Error("missing drag geometry");
  await browser.evaluate(async ({ x0, y0, x1, y1 }) => {
    const handle = document.querySelector<HTMLElement>(
      '[data-widget-id="tokens"] [data-testid="dashboard-drag-handle"]',
    );
    if (handle === null) throw new Error("missing drag handle");
    const fire = (type: string, x: number, y: number, buttons: number) =>
      handle.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 44,
          pointerType: "touch",
          isPrimary: true,
          clientX: x,
          clientY: y,
          button: 0,
          buttons,
        }),
      );
    fire("pointerdown", x0, y0, 1);
    await new Promise((resolve) => setTimeout(resolve, 400));
    for (let step = 1; step <= 6; step += 1) {
      fire("pointermove", x0 + ((x1 - x0) * step) / 6, y0 + ((y1 - y0) * step) / 6, 1);
    }
    fire("pointerup", x1, y1, 0);
    return true;
  }, start);
  await browser.evaluate(
    () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 900)),
  );
  expect(await sections()).toEqual(before);
});

test("refuses a drag onto an occupied cell and leaves every widget where it was", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 1000 });
  await app.open("/?page=stats");
  await resetMinimalDashboard(browser);
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
  const readCells = async () =>
    (await readDashboard(browser)).layout.sections.flatMap((section) =>
      section.widgets.map((slot) => ({
        id: slot.id,
        x: slot.x ?? 0,
        y: slot.y ?? 0,
        w: slot.w ?? 1,
        h: slot.h ?? 1,
      })),
    );
  const before = await readCells();

  // One row down puts tokens over mcp; RGL must refuse rather than displace it.
  await dragPointer(browser, '[data-widget-id="tokens"]', '[data-widget-id="mcp"]', 0, -168);
  await browser.evaluate(
    () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 1_000)),
  );
  const slots = await readCells();
  expect(slots).toEqual(before);

  // No cell may have moved by more than its own height, and none may overlap.
  const beforeById = new Map(before.map((slot) => [slot.id, slot]));
  for (const slot of slots) {
    const previous = beforeById.get(slot.id);
    if (previous === undefined) continue;
    expect(Math.abs(slot.y - previous.y)).toBeLessThanOrEqual(previous.h);
  }
  const occupied = new Set<string>();
  let overlap = false;
  for (const slot of slots) {
    for (let row = slot.y ?? 0; row < (slot.y ?? 0) + (slot.h ?? 1); row += 1) {
      for (let column = slot.x ?? 0; column < (slot.x ?? 0) + (slot.w ?? 1); column += 1) {
        const key = `${column}:${row}`;
        if (occupied.has(key)) overlap = true;
        occupied.add(key);
      }
    }
  }
  expect(overlap).toBe(false);
});

test("a widget dragged past a heading lands in the next section", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 1200 });
  await app.open("/?page=stats");
  await resetMinimalDashboard(browser);
  const patched = await browser.evaluate(async () => {
    const response = await fetch("/api/dashboard/layout", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sections: [
          {
            title: "A",
            widgets: [
              { id: "context", span: "full", x: 0, y: 0, w: 12, h: 2 },
              { id: "tokens", span: "half", x: 3, y: 2, w: 6, h: 4 },
            ],
          },
          {
            title: "B",
            widgets: [
              { id: "mcp", span: "full", x: 0, y: 0, w: 12, h: 4 },
              { id: "mcp-events", span: "full", x: 0, y: 4, w: 12, h: 4 },
            ],
          },
          {
            title: "C",
            widgets: [{ id: "task-reopens", span: "full", x: 0, y: 0, w: 12, h: 4 }],
          },
        ],
      }),
    });
    return response.status;
  });
  expect(patched).toBe(200);
  await app.open("/?page=stats");
  await expect(screen.getByTestId("widget-tokens")).toBeVisible({ timeout: 30_000 });

  const drag = await browser.evaluate(() => {
    const handle = document.querySelector<HTMLElement>(
      '[data-widget-id="tokens"] [data-testid="dashboard-drag-handle"]',
    );
    const heading = document.querySelector<HTMLElement>(
      '[data-section-index="1"] [data-section-heading]',
    );
    const grid = document.querySelector<HTMLElement>('[data-section-index="1"] .dashboard-grid');
    if (handle === null || heading === null || grid === null) return null;
    const from = handle.getBoundingClientRect();
    const head = heading.getBoundingClientRect();
    const box = grid.getBoundingClientRect();
    return {
      x0: from.left + from.width / 2,
      y0: from.top + from.height / 2,
      crossingY: head.bottom + 8,
      target: {
        headingTop: Math.round(head.top),
        headingBottom: Math.round(head.bottom),
        gridTop: Math.round(box.top),
        gridBottom: Math.round(box.bottom),
        gridRight: Math.round(box.right),
      },
      headingTop: head.top,
    };
  });
  expect(drag).not.toBeNull();
  if (drag === null) throw new Error("missing cross-section drag geometry");
  expect(drag.headingTop).toBeGreaterThan(drag.y0);

  await browser.mouse.move(drag.x0, drag.y0);
  await browser.mouse.down();
  // Cross the heading in several moves so the page sees a real drag, not a
  // single teleport across the container boundary.
  for (let step = 1; step <= 12; step += 1) {
    await browser.mouse.move(drag.x0, drag.y0 + ((drag.crossingY - drag.y0) * step) / 12);
  }
  // The source grid must not grow and shove the destination down while the
  // pointer is over the old target. Read the live rect and drop there.
  const live = await browser.evaluate(() => {
    const heading = document.querySelector<HTMLElement>(
      '[data-section-index="1"] [data-section-heading]',
    );
    const grid = document.querySelector<HTMLElement>('[data-section-index="1"] .dashboard-grid');
    if (heading === null || grid === null) throw new Error("missing live target");
    const head = heading.getBoundingClientRect();
    const box = grid.getBoundingClientRect();
    return {
      headingTop: Math.round(head.top),
      headingBottom: Math.round(head.bottom),
      gridTop: Math.round(box.top),
      gridBottom: Math.round(box.bottom),
      gridRight: Math.round(box.right),
    };
  });
  expect(live).toEqual(drag.target);
  const x1 = live.gridRight - 24;
  const y1 = live.gridTop + 24;
  for (let step = 1; step <= 6; step += 1) {
    await browser.mouse.move(
      drag.x0 + ((x1 - drag.x0) * step) / 6,
      drag.crossingY + ((y1 - drag.crossingY) * step) / 6,
    );
  }
  await expect
    .poll(() =>
      browser.evaluate(
        () =>
          document
            .querySelector<HTMLElement>('[data-section-index="1"]')
            ?.hasAttribute("data-drop-target") ?? false,
      ),
    )
    .toBe(true);
  await browser.mouse.up();

  await expect
    .poll(async () => {
      const dashboard = await readDashboard(browser);
      return dashboard.layout.sections.map((section) => section.widgets.map((slot) => slot.id));
    })
    .toEqual([["context"], ["mcp", "mcp-events", "tokens"], ["task-reopens"]]);
  const after = await readDashboard(browser);
  const tokens = after.layout.sections
    .flatMap((section) => section.widgets)
    .find((slot) => slot.id === "tokens");
  expect(tokens).toMatchObject({ span: "half", x: 6, y: 8, w: 6, h: 4 });
  expect(
    await browser.evaluate(
      () =>
        document
          .querySelector<HTMLElement>('[data-section-index="1"]')
          ?.hasAttribute("data-drop-target") ?? false,
    ),
  ).toBe(false);

  // The destination stays the destination after a reload and a fresh read.
  await app.open("/?page=stats");
  await expect(screen.getByTestId("widget-tokens")).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => {
      const dashboard = await readDashboard(browser);
      return dashboard.layout.sections.map((section) => section.widgets.map((slot) => slot.id));
    })
    .toEqual([["context"], ["mcp", "mcp-events", "tokens"], ["task-reopens"]]);
  expect(
    await browser.evaluate(
      () =>
        document
          .querySelector<HTMLElement>('[data-widget-id="tokens"]')
          ?.closest<HTMLElement>("[data-section-index]")?.dataset.sectionIndex ?? null,
    ),
  ).toBe("1");
});

test("dragging within a section still only reorders it", async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 1280, height: 1200 });
  await app.open("/?page=stats");
  await resetMinimalDashboard(browser);
  const patched = await browser.evaluate(async () => {
    const response = await fetch("/api/dashboard/layout", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sections: [
          {
            title: "A",
            widgets: [
              { id: "context", span: "full", x: 0, y: 0, w: 12, h: 2 },
              { id: "tokens", span: "full", x: 0, y: 4, w: 12, h: 4 },
              { id: "mcp", span: "full", x: 0, y: 12, w: 12, h: 4 },
            ],
          },
          {
            title: "B",
            widgets: [
              { id: "mcp-events", span: "full", x: 0, y: 0, w: 12, h: 4 },
              { id: "task-reopens", span: "full", x: 0, y: 4, w: 12, h: 4 },
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

  const drag = await browser.evaluate(() => {
    const handle = document.querySelector<HTMLElement>(
      '[data-widget-id="tokens"] [data-testid="dashboard-drag-handle"]',
    );
    const grid = document.querySelector<HTMLElement>('[data-section-index="0"] .dashboard-grid');
    if (handle === null || grid === null) return null;
    const from = handle.getBoundingClientRect();
    const box = grid.getBoundingClientRect();
    return {
      x0: from.left + from.width / 2,
      y0: from.top + from.height / 2,
      x1: from.left + from.width / 2,
      // A free four-row band below context and above the mcp card.
      y1: box.top + 8 * (44 + 12) + 20,
    };
  });
  expect(drag).not.toBeNull();
  if (drag === null) throw new Error("missing within-section drag geometry");

  await browser.mouse.move(drag.x0, drag.y0);
  await browser.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await browser.mouse.move(
      drag.x0 + ((drag.x1 - drag.x0) * step) / 8,
      drag.y0 + ((drag.y1 - drag.y0) * step) / 8,
    );
  }
  await browser.mouse.up();

  // The section membership does not change, so wait for the committed cell.
  await expect
    .poll(async () => {
      const dashboard = await readDashboard(browser);
      return {
        sections: dashboard.layout.sections.map((section) =>
          section.widgets.map((slot) => slot.id),
        ),
        tokensY: dashboard.layout.sections[0]?.widgets.find((slot) => slot.id === "tokens")?.y,
      };
    })
    .toEqual({
      sections: [
        ["context", "tokens", "mcp"],
        ["mcp-events", "task-reopens"],
      ],
      tokensY: 8,
    });
  const after = await readDashboard(browser);
  const tokens = after.layout.sections[0]?.widgets.find((slot) => slot.id === "tokens");
  const untouched = after.layout.sections[1]?.widgets.map((slot) => [slot.id, slot.y]);
  expect(tokens).toMatchObject({ x: 0, y: 8, w: 12, h: 4, span: "full" });
  expect(untouched).toEqual([
    ["mcp-events", 0],
    ["task-reopens", 4],
  ]);
});

test("a drop outside every section changes nothing", async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 1280, height: 1200 });
  await app.open("/?page=stats");
  await resetMinimalDashboard(browser);
  const patched = await browser.evaluate(async () => {
    const response = await fetch("/api/dashboard/layout", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sections: [
          {
            title: "A",
            widgets: [
              { id: "context", span: "full", x: 0, y: 0, w: 12, h: 2 },
              { id: "tokens", span: "full", x: 0, y: 4, w: 12, h: 4 },
            ],
          },
          {
            title: "B",
            widgets: [
              { id: "mcp", span: "full", x: 0, y: 0, w: 12, h: 4 },
              { id: "mcp-events", span: "full", x: 0, y: 4, w: 12, h: 4 },
            ],
          },
          {
            title: "C",
            widgets: [{ id: "task-reopens", span: "full", x: 0, y: 0, w: 12, h: 4 }],
          },
        ],
      }),
    });
    return response.status;
  });
  expect(patched).toBe(200);
  await app.open("/?page=stats");
  await expect(screen.getByTestId("widget-tokens")).toBeVisible({ timeout: 30_000 });

  const patches: PatchBody[] = [];
  await browser.route("**/api/dashboard/layout", async (route) => {
    if (route.request.method === "PATCH") {
      patches.push(JSON.parse(route.request.postData ?? "{}") as PatchBody);
    }
    await route.continue();
  });
  const before = await readDashboard(browser);
  const beforeSections = before.layout.sections;
  const drag = await browser.evaluate(() => {
    const handle = document.querySelector<HTMLElement>(
      '[data-widget-id="tokens"] [data-testid="dashboard-drag-handle"]',
    );
    const firstGrid = document.querySelector<HTMLElement>(
      '[data-section-index="0"] .dashboard-grid',
    );
    const secondHeading = document.querySelector<HTMLElement>(
      '[data-section-index="1"] [data-section-heading]',
    );
    const lastGrid = document.querySelector<HTMLElement>(
      '[data-section-index="2"] .dashboard-grid',
    );
    if (handle === null || firstGrid === null || secondHeading === null || lastGrid === null) {
      return null;
    }
    const from = handle.getBoundingClientRect();
    const first = firstGrid.getBoundingClientRect();
    const heading = secondHeading.getBoundingClientRect();
    const last = lastGrid.getBoundingClientRect();
    return {
      x: from.left + from.width / 2,
      y: from.top + from.height / 2,
      gapY: (first.bottom + heading.top) / 2,
      belowY: Math.min(window.innerHeight - 8, last.bottom + 80),
    };
  });
  expect(drag).not.toBeNull();
  if (drag === null) throw new Error("missing outside-section drag geometry");

  const dragTo = async (y: number) => {
    await browser.mouse.move(drag.x, drag.y);
    await browser.mouse.down();
    for (let step = 1; step <= 8; step += 1) {
      await browser.mouse.move(drag.x, drag.y + ((y - drag.y) * step) / 8);
    }
    await browser.mouse.up();
    await browser.evaluate(
      () => new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 900)),
    );
  };

  // The gap between two sections belongs to neither of them.
  await dragTo(drag.gapY);
  expect(patches.length).toBe(0);
  expect((await readDashboard(browser)).layout.sections).toEqual(beforeSections);

  // Empty space below the last section is outside too; it must not delete.
  await dragTo(drag.belowY);
  expect(patches.length).toBe(0);
  expect((await readDashboard(browser)).layout.sections).toEqual(beforeSections);
  expect(
    await browser.evaluate(
      () =>
        document
          .querySelector<HTMLElement>('[data-widget-id="tokens"]')
          ?.closest<HTMLElement>("[data-section-index]")?.dataset.sectionIndex ?? null,
    ),
  ).toBe("0");

  await browser.unroute("**/api/dashboard/layout");
});
