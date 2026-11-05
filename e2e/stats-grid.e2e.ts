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
  await resetMinimalDashboard(browser);
  patches.length = 0;
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

  await expect.poll(() => patches.length, { timeout: 5_000 }).toBe(1);
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
  await expect.poll(() => patches.length, { timeout: 5_000 }).toBe(2);
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

test("drags from the grip with a real mouse", async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 1280, height: 1000 });
  await app.open("/?page=stats");
  await resetMinimalDashboard(browser);
  await expect(screen.getByTestId("widget-tokens")).toBeVisible({ timeout: 30_000 });
  const before = await readDashboard(browser);
  const startY = before.layout.sections
    .flatMap((section) => section.widgets)
    .find((slot) => slot.id === "tokens")?.y;
  expect(startY).toBeDefined();

  const grip = await browser
    .locator('[data-widget-id="tokens"] [data-testid="dashboard-drag-handle"]')
    .boundingBox();
  const target = await browser.locator('[data-widget-id="context"]').boundingBox();
  if (grip === null || target === null) throw new Error("missing drag geometry");
  const x0 = grip.x + grip.width / 2;
  const y0 = grip.y + grip.height / 2;
  const x1 = target.x + target.width / 2;
  const y1 = target.y + target.height / 4;
  await browser.mouse.move(x0, y0);
  await browser.mouse.down();
  for (let step = 1; step <= 6; step += 1) {
    await browser.mouse.move(x0 + ((x1 - x0) * step) / 6, y0 + ((y1 - y0) * step) / 6);
  }
  await browser.mouse.up();

  await expect
    .poll(async () => {
      const dashboard = await readDashboard(browser);
      return dashboard.layout.sections
        .flatMap((section) => section.widgets)
        .find((slot) => slot.id === "tokens")?.y;
    })
    .toBeLessThan(startY ?? Number.POSITIVE_INFINITY);
});

test("creates a section through the agent, keeps drags inside it, then renames and deletes it", async ({
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

  // A drag cannot move a widget into another section; RGL keeps it in its own
  // grid, so the agent-created section stays untouched.
  await dragPointer(browser, '[data-widget-id="mcp"]', '[data-section-index="1"]');
  await expect
    .poll(async () => {
      const dashboard = await readDashboard(browser);
      return dashboard.layout.sections.map((section) =>
        section.widgets.map((slot) => slot.id).sort(),
      );
    })
    .toEqual([["context", "mcp", "mcp-events", "task-reopens", "tokens"], ["agent-note"]]);

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

test("packs a free drag collision into the persisted layout", async ({ app, browser, screen }) => {
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

  const preview = await browser.evaluate(async () => {
    const handle = document.querySelector<HTMLElement>(
      '[data-widget-id="tokens"] [data-testid="dashboard-drag-handle"]',
    );
    const card = document.querySelector<HTMLElement>('[data-widget-id="tokens"]');
    const pushed = document.querySelector<HTMLElement>('[data-widget-id="mcp"]');
    if (handle === null || card === null || pushed === null) throw new Error("missing card");
    const start = handle.getBoundingClientRect();
    const x = start.left + start.width / 2;
    const y = start.top + start.height / 2;
    const top = (element: HTMLElement) => element.getBoundingClientRect().top;
    const before = { tokens: top(card), mcp: top(pushed) };
    const fire = (type: string, clientY: number, buttons: number) =>
      handle.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 19,
          pointerType: "mouse",
          isPrimary: true,
          clientX: x,
          clientY,
          button: 0,
          buttons,
        }),
      );
    fire("pointerdown", y, 1);
    for (let step = 1; step <= 6; step += 1) fire("pointermove", y + (56 * step) / 6, 1);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const during = {
      tokens: top(card),
      mcp: top(pushed),
      dragging: card.classList.contains("react-draggable-dragging"),
      placeholder: document.querySelectorAll(".react-grid-placeholder").length,
    };
    fire("pointerup", y + 56, 0);
    return { before, during };
  });
  expect(preview.during.dragging).toBe(true);
  expect(preview.during.placeholder).toBeGreaterThan(0);
  expect(preview.during.tokens).toBeGreaterThan(preview.before.tokens);
  expect(preview.during.mcp).toBeGreaterThan(preview.before.mcp);

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
      stored: { context: 0, tokens: 5, mcp: 12, "mcp-events": 16, "task-reopens": 30 },
      rendered: { context: 0, tokens: 5, mcp: 12, "mcp-events": 16, "task-reopens": 30 },
    });
});
