import { test } from "@e2e-dev/web";
import { expect } from "e2e";

type SeedServer = { name: string; available: boolean; authRejected: boolean; tools: string[] };

type DashboardSnapshot = {
  widgets: { id: string }[];
  values: Record<string, { view?: unknown }>;
};

async function readDashboard(browser: {
  evaluate<T>(fn: () => Promise<T> | T): Promise<T>;
}): Promise<DashboardSnapshot> {
  return browser.evaluate(async () => {
    const response = await fetch("/api/dashboard");
    return (await response.json()) as DashboardSnapshot;
  });
}

/** Runs dashboard tool calls through the real message route. */
async function seedDashboard(
  browser: { evaluate<T>(fn: (text: string) => Promise<T> | T, text: string): Promise<T> },
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

test("flattens the dock blur only while the page transition runs", async ({
  app,
  browser,
  screen,
}) => {
  // The suite runs with reduced motion by default; this case asserts the moving
  // transition, so opt back into motion like the shader test does.
  await browser.emulateMedia({ reducedMotion: "no-preference" });
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");
  const read = await browser.evaluate(async () => {
    const dock = document.querySelector<HTMLElement>('[data-testid="composer-dock"]');
    const stats = document.querySelector<HTMLElement>('[data-testid="page-dot-stats"]');
    if (dock === null || stats === null) return null;
    const style = () => {
      const computed = getComputedStyle(dock);
      return {
        blur:
          computed.backdropFilter || computed.getPropertyValue("-webkit-backdrop-filter") || "none",
        background: computed.backgroundColor,
      };
    };
    const waitFor = (read: () => boolean, timeout: number) =>
      new Promise<boolean>((resolve) => {
        const deadline = performance.now() + timeout;
        const check = () => {
          if (read()) {
            resolve(true);
            return;
          }
          if (performance.now() > deadline) {
            resolve(false);
            return;
          }
          window.setTimeout(check, 16);
        };
        check();
      });
    let resolveDuring: (() => void) | null = null;
    const duringSeen = new Promise<void>((resolve) => {
      resolveDuring = resolve;
    });
    const observer = new MutationObserver(() => {
      if (dock.getAttribute("data-transitioning") === "true") resolveDuring?.();
    });
    observer.observe(dock, { attributes: true, attributeFilter: ["data-transitioning"] });
    stats.click();
    const appeared = await Promise.race([
      duringSeen.then(() => true),
      waitFor(() => dock.getAttribute("data-transitioning") === "true", 3000),
    ]);
    const during = style();
    const removed = await waitFor(() => dock.getAttribute("data-transitioning") === null, 5000);
    const after = style();
    observer.disconnect();
    return {
      appeared,
      removed,
      during,
      after,
      current: dock.getAttribute("data-transitioning"),
      background: getComputedStyle(document.documentElement).getPropertyValue("--surface").trim(),
    };
  });
  expect(read).not.toBeNull();
  expect(read?.appeared).toBe(true);
  expect(read?.removed).toBe(true);
  expect(read?.current).toBeNull();
  expect(read?.during.blur).toBe("none");
  expect(read?.after.blur ?? "").toContain("blur");
  expect(read?.during.background).not.toBe("");
  expect(read?.background).not.toBe("");
  await expect(screen.getByTestId("stats-page")).toBeVisible();
});

test("keeps the composer body still under reduced motion and switches in one frame", async ({
  app,
  browser,
  screen,
}) => {
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

  const read = await browser.evaluate(async () => {
    const element = document.querySelector<HTMLElement>('[data-testid="composer-body"]');
    const stats = document.querySelector<HTMLElement>('[data-testid="page-dot-stats"]');
    const chat = document.querySelector<HTMLElement>('[data-testid="page-dot-chat"]');
    if (element === null || stats === null || chat === null) return null;
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const start = element.getBoundingClientRect().height;
    stats.click();
    await nextFrame();
    const collapsed = {
      height: element.getBoundingClientRect().height,
      state: element.getAttribute("data-collapsed"),
    };
    chat.click();
    await nextFrame();
    const expanded = {
      height: element.getBoundingClientRect().height,
      state: element.getAttribute("data-collapsed"),
    };
    return { start, collapsed, expanded };
  });
  expect(read).not.toBeNull();
  expect(read?.collapsed.height).toBeLessThan(1);
  expect(read?.collapsed.state).toBe("true");
  expect(Math.abs((read?.expanded.height ?? 0) - (read?.start ?? 0))).toBeLessThan(0.5);
  expect(read?.expanded.state).toBe("false");

  await expect(dock).toBeVisible();
  await expect(body).toBeVisible();
  expect(await transition("composer-dock")).toBe("none");
  expect(await transition("composer-body")).toBe("none");
});

test("draws the active page marker as a square and settles the switch back to dots", async ({
  app,
  browser,
  screen,
}) => {
  await browser.emulateMedia({ reducedMotion: "no-preference" });
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");

  const marker = (id: string) =>
    browser.evaluate((testId) => {
      const span = document.querySelector(`[data-testid="${testId}"] span`);
      if (span === null) return null;
      const box = span.getBoundingClientRect();
      const style = getComputedStyle(span);
      return {
        width: box.width,
        height: box.height,
        radius: Number.parseFloat(style.borderRadius),
        transition: style.transitionProperty,
      };
    }, `page-dot-${id}`);

  await expect(screen.getByRole("tab", "Chat")).toHaveAttribute("aria-selected", "true");
  const initial = await marker("chat");
  expect(initial === null ? -1 : Math.abs(initial.width - initial.height)).toBeLessThanOrEqual(1);
  expect(initial?.transition ?? "").toContain("width");
  expect(initial?.transition ?? "").toContain("height");
  expect(initial?.transition ?? "").toContain("border-radius");

  await screen.getByRole("tab", "Stats").tap();
  await expect(screen.getByRole("tab", "Stats")).toHaveAttribute("aria-selected", "true");
  await expect(screen.getByRole("tab", "Chat")).toHaveAttribute("aria-selected", "false");
  await browser.evaluate(async () => {
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 360);
    });
    return true;
  });

  const square = await marker("stats");
  const dot = await marker("chat");
  expect(square === null ? -1 : Math.abs(square.width - square.height)).toBeLessThanOrEqual(1);
  expect(square?.width ?? 0).toBeGreaterThan(dot?.width ?? 0);
  expect(square?.radius ?? 99).toBeLessThanOrEqual(4);
  expect(dot === null ? -1 : Math.abs(dot.width - dot.height)).toBeLessThanOrEqual(1);
});

test("vibrates once per page change and never on mount", async ({ app, browser, screen }) => {
  await browser.addInitScript(() => {
    let calls = 0;
    Object.defineProperty(navigator, "vibrate", {
      configurable: true,
      value: () => {
        calls += 1;
        (window as unknown as { __vibrationCalls?: number }).__vibrationCalls = calls;
        return true;
      },
    });
  });
  await browser.setViewport({ width: 390, height: 844 });
  await browser.emulateMedia({ reducedMotion: "no-preference" });
  await app.open("/");
  await expect(screen.getByRole("tab", "Chat")).toHaveAttribute("aria-selected", "true");

  const calls = () =>
    browser.evaluate(
      () => (window as unknown as { __vibrationCalls?: number }).__vibrationCalls ?? 0,
    );
  expect(await calls()).toBe(0);

  await screen.getByRole("tab", "Stats").tap();
  await expect.poll(calls).toBe(1);
  await screen.getByRole("tab", "Chat").tap();
  await expect.poll(calls).toBe(2);

  await screen.getByRole("tab", "Chat").tap();
  await browser.evaluate(async () => {
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 80);
    });
    return true;
  });
  expect(await calls()).toBe(2);
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
  expect(read.value ?? "").toMatch(/^\d\d:\d\d · alert 24$/);
  expect(read.web).toBe("web2 tools · subscribed: alerts");
  await app.screenshot("mcp-events-widget");
  await screen.getByRole("tab", "Chat").tap();
});

test("resolves status dot colours from the active theme", async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: busy });
  });
  await browser.route("**/api/themes", async (route) => {
    await route.fulfill({
      json: {
        current: "midnight",
        selected: "midnight",
        themes: [
          {
            slug: "midnight",
            name: "Midnight",
            colors: {
              mode: "dark",
              background: "#101315",
              foreground: "#cacccc",
              surface: "#0c0e10",
              muted: "#080a0b",
              mutedForeground: "#4b4e55",
              border: "#343d41",
              accent: "#798186",
              destructive: "#de6145",
              selection: "#343d41",
              radius: 6,
            },
          },
          {
            slug: "latte",
            name: "Latte",
            colors: {
              mode: "light",
              background: "#eff1f5",
              foreground: "#4c4f69",
              surface: "#e3e4e8",
              muted: "#dce0e8",
              mutedForeground: "#6c6f85",
              border: "#ccd0da",
              accent: "#1e66f5",
              destructive: "#d20f39",
              selection: "#ccd0da",
              radius: 6,
            },
          },
        ],
      },
    });
  });
  await browser.route("**/api/theme", async (route) => {
    if (route.request.method === "POST") {
      await route.fulfill({ json: { slug: "latte" } });
      return;
    }
    await route.continue();
  });
  await app.open("/?page=stats");
  await expect(screen.getByTestId("stat-mcp-web")).toBeVisible();
  await expect
    .poll(() => browser.evaluate(() => document.documentElement.dataset.mode ?? null))
    .toBe("dark");

  const colors = () =>
    browser.evaluate(() => {
      const dot = (id: string) => {
        const row = document.querySelector(`[data-testid="stat-mcp-${id}"]`);
        const element = row?.querySelector<HTMLElement>('[role="img"]') ?? null;
        return element === null ? null : getComputedStyle(element).backgroundColor;
      };
      return { ok: dot("web"), error: dot("a-server-with-a-really-long-name-that-should-wrap") };
    });
  const dark = await colors();
  expect(dark.ok).not.toBeNull();
  expect(dark.error).not.toBeNull();
  expect(dark.ok).not.toBe(dark.error);

  await screen.getByRole("button", "Settings").tap();
  await screen.getByRole("menuitem", { name: /^Theme/ }).tap();
  await screen.getByRole("menuitemradio", { name: "Latte" }).tap();

  await expect
    .poll(async () => {
      const light = await colors();
      return light.ok !== dark.ok && light.error !== dark.error;
    })
    .toBe(true);
  const light = await colors();
  expect(light.ok).not.toBe(light.error);
});

test("a sparkline headline can be a mapped string instead of the derived number", async ({
  app,
  browser,
  screen,
}) => {
  const headline = "€1.70 accrued · €20.44 projected";
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");
  await seedDashboard(browser, [
    {
      name: "dashboard_upsert",
      arguments: {
        id: "spend-headline",
        title: "Spend",
        kind: "sparkline",
        source: {
          type: "poll",
          script: `return { series: { actual: [1, 2, 3] }, headline: ${JSON.stringify(headline)} };`,
          intervalSec: 0.5,
        },
        mapping: { series: "series", value: "headline", label: "=Spend" },
      },
    },
  ]);
  await expect
    .poll(
      async () => {
        const dashboard = await readDashboard(browser);
        return (
          dashboard.widgets.some((widget) => widget.id === "spend-headline") &&
          dashboard.values["spend-headline"]?.view !== undefined
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  await app.open("/?page=stats");
  await expect(screen.getByTestId("stat-spend-headline")).toBeVisible();
  const read = await browser.evaluate(() => {
    const text = document.querySelector('[data-testid="stat-spend-headline"]')?.textContent ?? null;
    return { text, numeric: text !== null && /^-?[\d.,]+$/.test(text) };
  });
  expect(read).toEqual({ text: headline, numeric: false });
});
