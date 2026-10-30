import { test } from "@e2e-dev/web";
import { expect } from "e2e";

type SeedServer = { name: string; available: boolean; authRejected: boolean; tools: string[] };

function snapshot(options: {
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  context: { tokens: number; window: number | null; percent: number | null };
  servers: SeedServer[];
}) {
  const { usage } = options;
  return {
    conversationId: "stats-e2e",
    messages: [],
    activity: [],
    run: "idle",
    queue: [],
    usage: {
      ...usage,
      totalTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    },
    context: options.context,
    mcp: {
      servers: options.servers,
      unavailable: options.servers.filter((server) => !server.available).map((s) => s.name),
    },
  };
}

const busy = snapshot({
  usage: { input: 12_000, output: 4_700, cacheRead: 36_000, cacheWrite: 0, cost: 0.4213 },
  context: { tokens: 52_700, window: 200_000, percent: 26.4 },
  servers: [
    { name: "web", available: true, authRejected: false, tools: ["search", "fetch"] },
    { name: "linear", available: false, authRejected: true, tools: [] },
    {
      name: "a-server-with-a-really-long-name-that-should-wrap",
      available: false,
      authRejected: false,
      tools: [],
    },
  ],
});

for (const width of [390, 1280]) {
  test(`shows conversation stats left of chat at ${width}px`, async ({ app, browser, screen }) => {
    await browser.setViewport({ width, height: 844 });
    await browser.route("**/api/state**", async (route) => {
      await route.fulfill({ json: busy });
    });
    await app.open("/");
    await expect(screen.getByRole("textbox", "Message")).toBeVisible();
    expect(
      await browser.evaluate(() =>
        [...document.querySelectorAll("[data-testid=page-dots] [role=tab]")].map(
          (tab) => tab.getAttribute("aria-label") ?? "",
        ),
      ),
    ).toEqual(["Stats", "Chat", "Tasks"]);
    expect(
      await browser.evaluate(
        () => document.querySelector("[data-testid=pager]")?.getAttribute("data-page") ?? null,
      ),
    ).toBe("chat");

    await screen.getByRole("tab", "Stats").tap();
    await expect(screen.getByText("26.4%", { exact: false })).toBeVisible();
    expect(await browser.evaluate(() => new URLSearchParams(location.search).get("page"))).toBe(
      "stats",
    );
    const read = await browser.evaluate(() => {
      const value = (id: string) =>
        document.querySelector(`[data-testid="${id}"] dd`)?.textContent ??
        document.querySelector(`[data-testid="${id}"]`)?.textContent ??
        null;
      const page = document.querySelector("[data-testid=stats-page]");
      const cards = [...(page?.querySelectorAll("section") ?? [])];
      const tokens = document.querySelector('[data-testid="widget-tokens"]');
      const note = tokens?.querySelector('[data-testid="widget-tokens-note"]') ?? null;
      const firstRow = tokens?.querySelector("dl > div") ?? null;
      return {
        note: note?.textContent ?? null,
        noteBeforeRows:
          note !== null &&
          firstRow !== null &&
          (note.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        context: value("stat-context"),
        input: value("stat-input"),
        output: value("stat-output"),
        hit: value("stat-cache-hit"),
        cost: value("stat-cost"),
        web: value("stat-mcp-web"),
        linear: value("stat-mcp-linear"),
        long: value("stat-mcp-a-server-with-a-really-long-name-that-should-wrap"),
        overflow: page === null ? true : page.scrollWidth > page.clientWidth,
        clipped: cards.some((card) => card.scrollWidth > card.clientWidth),
        inside: cards.every((card) => card.getBoundingClientRect().right <= window.innerWidth),
      };
    });
    expect(read).toEqual({
      note: "Totals cover this conversation. Input excludes cached tokens; cache hit is cache read over all prompt tokens.",
      noteBeforeRows: true,
      context: expect.stringContaining("52,700 / 200,000 · 26.4%"),
      input: "12,000",
      output: "4,700",
      hit: "75%",
      cost: "$0.4213",
      web: expect.stringContaining("2 tools"),
      linear: expect.stringContaining("auth rejected"),
      long: expect.stringContaining("unavailable"),
      overflow: false,
      clipped: false,
      inside: true,
    });

    await screen.getByRole("tab", "Chat").tap();
    expect(await browser.evaluate(() => new URLSearchParams(location.search).get("page"))).toBe(
      "chat",
    );
  });
}

test("MCP rows show only tool counts and keep unavailable styling", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({
      json: snapshot({
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 },
        context: { tokens: 2, window: 200_000, percent: 0 },
        servers: [
          { name: "three", available: true, authRejected: false, tools: ["a", "b", "c"] },
          { name: "empty", available: true, authRejected: false, tools: [] },
          { name: "rejected", available: false, authRejected: true, tools: [] },
          { name: "down", available: false, authRejected: false, tools: [] },
        ],
      }),
    });
  });
  await app.open("/?page=stats");
  await expect(screen.getByText("three", { exact: true })).toBeVisible();
  const read = await browser.evaluate(() => {
    const row = (name: string) => {
      const item = document.querySelector(`[data-testid="stat-mcp-${name}"]`);
      const detail = item?.querySelectorAll(":scope > span")[1] ?? null;
      return {
        detail: detail?.textContent ?? null,
        unavailable: detail?.querySelector("[data-unavailable]") !== null,
        state: item?.getAttribute("data-state") ?? null,
      };
    };
    return {
      three: row("three"),
      empty: row("empty"),
      rejected: row("rejected"),
      down: row("down"),
      mcp: document.querySelector('[data-testid="widget-mcp"]')?.textContent ?? "",
    };
  });
  expect(read.three).toEqual({ detail: "3 tools", unavailable: false, state: "ok" });
  expect(read.empty).toEqual({ detail: "no tools", unavailable: false, state: "ok" });
  expect(read.rejected).toEqual({ detail: "auth rejected", unavailable: false, state: "warn" });
  expect(read.down).toEqual({
    detail: "unavailable · server unreachable",
    unavailable: true,
    state: "error",
  });
  expect(read.mcp).not.toMatch(/connected/i);
});

test("marks stats the server cannot report as unavailable", async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({
      json: snapshot({
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        context: { tokens: 0, window: null, percent: null },
        servers: [],
      }),
    });
  });
  await app.open("/?page=stats");
  await expect(screen.getByText("no MCP servers configured", { exact: true })).toBeVisible();
  const read = await browser.evaluate(() => {
    const value = (id: string) =>
      document.querySelector(`[data-testid="${id}"] dd`)?.textContent ?? null;
    return {
      context: value("stat-context"),
      hit: value("stat-cache-hit"),
      cost: value("stat-cost"),
      input: value("stat-input"),
    };
  });
  expect(read).toEqual({
    context: "unavailable · no model call yet",
    hit: "unavailable · no model call yet",
    cost: "unavailable · no model call yet",
    input: "0",
  });
});

test("collapses the composer on the stats page and restores it on chat and tasks", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");
  const dock = screen.getByTestId("composer-dock");
  const body = screen.getByTestId("composer-body");
  const dots = screen.getByTestId("page-dots");
  await expect(dock).toBeVisible();
  await expect(body).toBeVisible();
  expect(await body.getAttribute("data-hidden")).toBe("false");
  expect(
    await browser.evaluate(() => {
      const element = document.querySelector('[data-testid="composer-body"]');
      return element === null ? "" : getComputedStyle(element).transitionProperty;
    }),
  ).toContain("grid-template-rows");

  await screen.getByRole("tab", "Stats").tap();
  await expect(screen.getByTestId("stats-page")).toBeVisible();
  await expect(dock).toBeVisible();
  await expect(body).toBeHidden();
  await expect(dots).toBeVisible();
  expect(await body.getAttribute("data-hidden")).toBe("true");
  expect(await body.getAttribute("aria-hidden")).toBe("true");
  expect(
    await browser.evaluate(() => {
      const element = document.querySelector('[data-testid="composer-body"]');
      if (element === null || !element.hasAttribute("inert")) return null;
      return getComputedStyle(element).visibility;
    }),
  ).toBe("hidden");

  await screen.getByRole("tab", "Chat").tap();
  await expect(dock).toBeVisible();
  await expect(body).toBeVisible();
  expect(await body.getAttribute("data-hidden")).toBe("false");

  await screen.getByRole("tab", "Tasks").tap();
  await expect(dock).toBeVisible();
  await expect(body).toBeVisible();
  await expect(screen.getByRole("textbox", "New task")).toBeVisible();
});

test("keeps the composer body still under reduced motion", async ({ app, browser, screen }) => {
  await browser.emulateMedia({ reducedMotion: "reduce" });
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");
  const dock = screen.getByTestId("composer-dock");
  const body = screen.getByTestId("composer-body");
  const transition = (testId: string) =>
    browser.evaluate((id) => {
      const element = document.querySelector(`[data-testid="${id}"]`);
      return element === null ? null : getComputedStyle(element).transitionProperty;
    }, testId);
  await expect(dock).toBeVisible();
  await expect(body).toBeVisible();
  expect(await transition("composer-dock")).toBe("none");
  expect(await transition("composer-body")).toBe("none");

  await screen.getByRole("tab", "Stats").tap();
  await expect(dock).toBeVisible();
  await expect(body).toBeHidden();
  expect(await transition("composer-body")).toBe("none");

  await screen.getByRole("tab", "Chat").tap();
  await expect(body).toBeVisible();
  expect(await transition("composer-body")).toBe("none");
});

test("swipes right from chat to stats", async ({ app, browser }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");
  const page = await browser.evaluate(async () => {
    const pager = document.querySelector("[data-testid=pager]");
    if (!(pager instanceof HTMLElement)) return null;
    const box = pager.getBoundingClientRect();
    const y = box.top + Math.min(120, box.height / 2);
    const start = box.left + box.width * 0.2;
    const fire = (type: string, x: number) => {
      pager.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 7,
          pointerType: "touch",
          isPrimary: true,
          clientX: x,
          clientY: y,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
        }),
      );
    };
    fire("pointerdown", start);
    fire("pointermove", start + 24);
    fire("pointermove", start + 160);
    fire("pointerup", start + 160);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return pager.getAttribute("data-page");
  });
  expect(page).toBe("stats");
});

test("lists MCP events newest first in the default widget, not the composer chrome", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  const events = Array.from({ length: 25 }, (_, index) => ({
    id: `e${index}`,
    server: "web",
    name: "alerts",
    timestamp: new Date(Date.UTC(2026, 9, 30, 1, 0, index)).toISOString(),
    summary: `alert ${index}`,
  }));
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({
      json: {
        ...busy,
        mcpEvents: {
          subscriptions: [
            {
              id: "s1",
              server: "web",
              name: "alerts",
              status: "active",
              arguments: {},
              cursor: null,
            },
          ],
          events,
          notice: "new event from web",
          revision: 25,
        },
      },
    });
  });
  await app.open("/");
  await expect(screen.getByRole("textbox", "Message")).toBeVisible();
  expect(
    await browser.evaluate(
      () => document.querySelector('[data-testid="composer-dock"]')?.textContent ?? "",
    ),
  ).not.toMatch(/web|linear|unavailable|new event/);

  await screen.getByRole("tab", "Stats").tap();
  await expect(screen.getByTestId("widget-mcp-events")).toBeVisible();
  const read = await browser.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-testid="widget-mcp-events"] dl > div')];
    return {
      count: rows.length,
      first: rows[0]?.getAttribute("data-testid") ?? null,
      last: rows.at(-1)?.getAttribute("data-testid") ?? null,
      label: rows[0]?.querySelector("dt")?.textContent ?? null,
      value: rows[0]?.querySelector("dd")?.textContent ?? null,
      web: document.querySelector('[data-testid="stat-mcp-web"]')?.textContent ?? null,
    };
  });
  expect(read.count).toBe(3);
  expect(read.first).toBe("stat-mcp-event-e24");
  expect(read.last).toBe("stat-mcp-event-e22");
  expect(read.label).toBe("web · alerts");
  expect(read.value ?? "").toMatch(/^\d\d:\d\d:\d\d · alert 24$/);
  expect(read.web).toBe("web2 tools · subscribed: alerts");
  await app.screenshot("mcp-events-widget");
  await screen.getByRole("tab", "Chat").tap();
});
