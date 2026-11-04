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
      note: null,
      noteBeforeRows: false,
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
  await browser.emulateMedia({ reducedMotion: "no-preference" });
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");
  const dock = screen.getByTestId("composer-dock");
  const slide = screen.getByTestId("composer-slide");
  const body = screen.getByTestId("composer-body");
  const dots = screen.getByTestId("page-dots");
  const composer = screen.getByRole("textbox", "Message");
  const draft = "draft kept across the page switch";
  await composer.fill(draft);
  await expect(dock).toBeVisible();
  await expect(body).toBeVisible();
  expect(await body.getAttribute("data-hidden")).toBe("false");
  expect(await body.getAttribute("data-collapsed")).toBe("false");
  const transition = await browser.evaluate(() => {
    const element = document.querySelector('[data-testid="composer-body"]');
    return element === null ? "" : getComputedStyle(element).transitionProperty;
  });
  expect(transition).toContain("height");
  expect(transition).toContain("opacity");
  expect(transition).not.toContain("transform");

  await screen.getByRole("tab", "Stats").tap();
  await expect(screen.getByTestId("stats-page")).toBeVisible();
  await expect(dock).toBeVisible();
  await expect(body).toBeHidden();
  await expect(dots).toBeVisible();
  expect(await body.getAttribute("data-hidden")).toBe("true");
  expect(await body.getAttribute("aria-hidden")).toBe("true");
  await expect(body).toHaveAttribute("data-collapsed", "true");
  await expect
    .poll(
      async () =>
        browser.evaluate(() => {
          const element = document.querySelector('[data-testid="composer-body"]');
          if (element === null || !element.hasAttribute("inert")) return null;
          return getComputedStyle(element).visibility;
        }),
      { timeout: 1500 },
    )
    .toBe("hidden");

  await screen.getByRole("tab", "Chat").tap();
  await expect(dock).toBeVisible();
  await expect(body).toBeVisible();
  expect(await body.getAttribute("data-hidden")).toBe("false");
  await expect(body).toHaveAttribute("data-collapsed", "false");
  await expect(composer).toHaveValue(draft);
  expect(
    await browser.evaluate(() => {
      const field = document.querySelector('textarea[aria-label="Message"]');
      if (field instanceof HTMLElement) field.focus();
      return document.activeElement === field;
    }),
  ).toBe(true);

  await screen.getByRole("tab", "Tasks").tap();
  await expect(dock).toBeVisible();
  await expect(body).toBeVisible();
  await expect(screen.getByRole("textbox", "New task")).toBeVisible();
  await expect(body).toHaveAttribute("data-collapsed", "false");
  await expect(slide).toBeVisible();
});

test("moves the navigation row without a snap at either end of the page switch", async ({
  app,
  browser,
  screen,
}) => {
  await browser.emulateMedia({ reducedMotion: "no-preference" });
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");
  await expect(screen.getByTestId("working-status")).toBeVisible();

  const trace = await browser.evaluate(async () => {
    const status = document.querySelector<HTMLElement>('[data-testid="working-status"]');
    const stats = document.querySelector<HTMLElement>('[data-testid="page-dot-stats"]');
    const chat = document.querySelector<HTMLElement>('[data-testid="page-dot-chat"]');
    if (status === null || stats === null || chat === null) return null;
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 50));
    const sample = async (button: HTMLElement) => {
      const before = status.getBoundingClientRect().top;
      button.click();
      // Let React commit the page state, then take the animation away from the
      // frame clock. Stepping its currentTime makes the sample cadence exact
      // even when a loaded runner drops rAF frames.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const animations = document
        .getAnimations()
        .filter((animation) => animation.playState !== "finished");
      const duration = animations.reduce(
        (longest, animation) =>
          Math.max(longest, Number(animation.effect?.getComputedTiming().endTime ?? 0)),
        0,
      );
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = 0;
      }
      const tops = [status.getBoundingClientRect().top];
      for (let time = 1; time <= duration; time += 1) {
        for (const animation of animations) {
          const end = Number(animation.effect?.getComputedTiming().endTime ?? duration);
          animation.currentTime = Math.min(time, end);
        }
        tops.push(status.getBoundingClientRect().top);
      }
      // A timer that commits the old end state does not run while this loop is
      // synchronous. Catch it after the transition's own duration has elapsed.
      await new Promise<void>((resolve) => setTimeout(resolve, 350));
      tops.push(status.getBoundingClientRect().top);
      for (const animation of document.getAnimations()) animation.cancel();
      return { before, duration, tops };
    };
    const down = await sample(stats);
    await settle();
    const up = await sample(chat);
    return { down, up };
  });
  expect(trace).not.toBeNull();

  for (const run of [trace?.down, trace?.up]) {
    const tops = run?.tops ?? [];
    expect(run?.duration ?? 0).toBeGreaterThan(0);
    expect(tops.length).toBeGreaterThan(1);
    const deltas = tops.slice(1).map((top, index) => Math.abs(top - (tops[index] ?? top)));
    const average = deltas.reduce((sum, delta) => sum + delta, 0) / deltas.length;
    const largest = Math.max(...deltas);
    const last = deltas[deltas.length - 1] ?? 0;
    expect(Math.abs((tops[0] ?? 0) - (run?.before ?? 0))).toBeLessThan(0.5);
    expect(largest).toBeLessThanOrEqual(average + 1);
    expect(last).toBeLessThanOrEqual(Math.min(...deltas));
  }
});

test("keeps the composer body's resting height after ten page switches", async ({
  app,
  browser,
  screen,
}) => {
  await browser.emulateMedia({ reducedMotion: "no-preference" });
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");
  await expect(screen.getByTestId("composer-body")).toBeVisible();

  const height = () =>
    browser.evaluate(() => {
      const body = document.querySelector<HTMLElement>('[data-testid="composer-body"]');
      return body === null ? null : body.getBoundingClientRect().height;
    });

  const before = await height();
  expect(before).not.toBeNull();
  expect(before ?? 0).toBeGreaterThan(0);

  for (let index = 0; index < 10; index += 1) {
    await screen.getByTestId("page-dot-stats").tap();
    await expect.poll(height, { timeout: 5_000 }).toBeLessThan(0.5);
    await screen.getByTestId("page-dot-chat").tap();
    await expect.poll(height, { timeout: 5_000 }).toBeGreaterThan((before ?? 0) - 0.5);
  }

  // The last switch is back to chat, so poll the height through the 220ms
  // transition instead of sampling a mid-animation frame on a loaded runner.
  await expect
    .poll(
      async () => {
        const after = await height();
        return after === null ? null : Math.abs(after - (before ?? 0));
      },
      { timeout: 5_000 },
    )
    .toBeLessThan(0.5);
  const after = await height();
  expect(
    Math.abs((after ?? 0) - (before ?? 0)),
    `composer body was ${after}px after ten switches; its resting height is ${before}px`,
  ).toBeLessThan(0.5);
});
