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
    await browser.route("**/api/state", async (route) => {
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
      return {
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
      context: expect.stringContaining("52,700 / 200,000 · 26.4%"),
      input: "12,000",
      output: "4,700",
      hit: "75%",
      cost: "$0.4213",
      web: expect.stringContaining("connected · 2 tools"),
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

test("marks stats the server cannot report as unavailable", async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await browser.route("**/api/state", async (route) => {
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
