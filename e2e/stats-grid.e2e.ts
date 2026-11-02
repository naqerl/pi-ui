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
};

async function readDashboard(browser: {
  evaluate<T>(fn: () => Promise<T> | T): Promise<T>;
}): Promise<DashboardRead> {
  return browser.evaluate(async () => {
    const response = await fetch("/api/dashboard");
    return (await response.json()) as DashboardRead;
  });
}

/** Drives the page's pointer shim with the same synthetic events a touch or mouse test uses. */
async function dragPointer(
  browser: {
    evaluate<T>(
      fn: (input: { from: string; to: string; dx: number; dy: number }) => T,
      input: { from: string; to: string; dx: number; dy: number },
    ): Promise<T>;
  },
  from: string,
  to: string,
  dx = 0,
  dy = 0,
) {
  await browser.evaluate(
    ({ from, to, dx, dy }) => {
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
      for (let step = 1; step <= 6; step += 1) {
        fire("pointermove", x0 + ((x1 - x0) * step) / 6, y0 + ((y1 - y0) * step) / 6, 1);
      }
      fire("pointerup", x1, y1, 0);
      return true;
    },
    { from, to, dx, dy },
  );
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
  await expect(screen.getByTestId("widget-context")).toBeVisible();
  await expect(screen.getByTestId("widget-tokens")).toBeVisible();
  await expect(screen.getByTestId("widget-tokens-drag")).toBeVisible();

  await dragPointer(
    browser,
    '[data-testid="widget-tokens-drag"]',
    '[data-testid="widget-context"]',
    0,
    -18,
  );
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
    .toEqual(["tokens", "context", "mcp", "mcp-events"]);

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
  await expect(screen.getByTestId("widget-tokens")).toBeVisible();
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
});

test("renames, adds and deletes sections, and moves a widget between them", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 1000 });
  await app.open("/?page=stats");
  await expect(screen.getByTestId("dashboard-add-section")).toBeVisible();

  const title = screen.getByRole("textbox", "Section title");
  await title.fill("Runtime");
  await title.press("Enter");
  await expect
    .poll(async () => (await readDashboard(browser)).layout.sections[0]?.title)
    .toBe("Runtime");

  await screen.getByTestId("dashboard-add-section").tap();
  await expect
    .poll(async () => (await readDashboard(browser)).layout.sections.length, { timeout: 5_000 })
    .toBe(2);
  await browser.evaluate(() => {
    const inputs = document.querySelectorAll<HTMLInputElement>('[data-testid="section-title"]');
    const second = inputs[1];
    if (second === undefined) throw new Error("missing second section title");
    second.focus();
    second.value = "Agent";
    second.blur();
    return true;
  });
  await expect
    .poll(async () => (await readDashboard(browser)).layout.sections[1]?.title)
    .toBe("Agent");

  await dragPointer(browser, '[data-testid="widget-mcp-drag"]', '[data-section-index="1"]');
  await expect
    .poll(async () => {
      const dashboard = await readDashboard(browser);
      return dashboard.layout.sections.map((section) => section.widgets.map((slot) => slot.id));
    })
    .toEqual([["context", "tokens", "mcp-events"], ["mcp"]]);

  await screen.getByTestId("section-delete-1").tap();
  await expect
    .poll(async () => {
      const dashboard = await readDashboard(browser);
      return dashboard.layout.sections.map((section) => section.widgets.map((slot) => slot.id));
    })
    .toEqual([["context", "tokens", "mcp-events", "mcp"]]);

  // Deleting the first section reuses its DOM slot. The surviving title must
  // replace it instead of leaving the removed section's draft behind.
  await screen.getByTestId("dashboard-add-section").tap();
  await expect
    .poll(async () => (await readDashboard(browser)).layout.sections.length, { timeout: 5_000 })
    .toBe(2);
  await browser.evaluate(() => {
    const inputs = document.querySelectorAll<HTMLInputElement>('[data-testid="section-title"]');
    const second = inputs[1];
    if (second === undefined) throw new Error("missing second section title");
    second.focus();
    second.value = "Survivor";
    second.blur();
    return true;
  });
  await expect
    .poll(async () => (await readDashboard(browser)).layout.sections[1]?.title)
    .toBe("Survivor");
  await screen.getByTestId("section-delete-0").tap();
  await expect
    .poll(async () => {
      const dashboard = await readDashboard(browser);
      return {
        titles: dashboard.layout.sections.map((section) => section.title),
        inputs: await browser.evaluate(() =>
          [...document.querySelectorAll<HTMLInputElement>('[data-testid="section-title"]')].map(
            (input) => input.value,
          ),
        ),
      };
    })
    .toEqual({ titles: ["Survivor"], inputs: ["Survivor"] });
});

test("applies an external PATCH title and y spacing while the page is open", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 1000 });
  await app.open("/?page=stats");
  await expect(screen.getByTestId("widget-context")).toBeVisible();
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
  await expect(screen.getByTestId("widget-tokens")).toBeVisible();
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
            ],
          },
        ],
      }),
    });
    return response.status;
  });
  expect(patched).toBe(200);
  await app.open("/?page=stats");
  await expect(screen.getByTestId("widget-tokens-drag")).toBeVisible();

  await browser.evaluate(() => {
    const handle = document.querySelector<HTMLElement>('[data-testid="widget-tokens-drag"]');
    if (handle === null) throw new Error("missing drag handle");
    const start = handle.getBoundingClientRect();
    const x = start.left + start.width / 2;
    const y = start.top + start.height / 2;
    const fire = (type: string, clientY: number, buttons: number) =>
      handle.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 31,
          pointerType: "mouse",
          isPrimary: true,
          clientX: x,
          clientY,
          button: 0,
          buttons,
        }),
      );
    fire("pointerdown", y, 1);
    fire("pointermove", y + 56, 1);
    fire("pointerup", y + 56, 0);
    return true;
  });

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
      stored: { context: 0, tokens: 5, mcp: 9, "mcp-events": 13 },
      rendered: { context: 0, tokens: 5, mcp: 9, "mcp-events": 13 },
    });
});

test("resizes with touch and disables page scrolling on the resize handle", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 1000 });
  await app.open("/?page=stats");
  await expect(screen.getByTestId("widget-context-resize")).toBeVisible();
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

test("a phone-width viewport keeps the single-column stack and no drag handles", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=stats");
  await expect(screen.getByTestId("stats-page")).toBeVisible();
  await expect(screen.getByTestId("widget-context")).toBeVisible();
  expect(
    await browser.evaluate(() => ({
      handles: document.querySelectorAll(".dashboard-drag-handle").length,
      grids: document.querySelectorAll(".dashboard-grid").length,
      stacks: document.querySelectorAll('[data-testid^="dashboard-stack-"]').length,
    })),
  ).toEqual({ handles: 0, grids: 0, stacks: 1 });
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
  await expect(screen.getByTestId("widget-context")).toBeVisible();
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
    await browser.evaluate(() => document.querySelectorAll(".dashboard-drag-handle").length),
  ).toBeGreaterThan(0);
});
