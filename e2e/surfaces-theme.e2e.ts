import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

const messages = Array.from({ length: 60 }, (_, index) => ({
  id: `surface-seed-${index}`,
  role: index % 2 === 0 ? "user" : "assistant",
  text: `Seed message ${index}: translucent surfaces keep the transcript readable while it scrolls.`,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  order: index + 1,
}));

const snapshot = {
  conversationId: "surface-e2e",
  messages,
  activity: [],
  run: "idle",
  queue: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
  context: { tokens: 0, window: null, percent: null },
};

async function shaderFollowsTheme(browser: Browser) {
  return browser.evaluate(() => {
    const node = document.querySelector("[data-testid=shader-bg]");
    if (node === null) return false;
    const page = getComputedStyle(document.body);
    const channels = (color: string | null) => {
      const match = color?.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
      if (match === null || match === undefined) return null;
      return [Number(match[1]), Number(match[2]), Number(match[3])];
    };
    const amount = Number(node.getAttribute("data-shader-ink"));
    const back = channels(page.backgroundColor);
    const ink = channels(page.color);
    const front = channels(node.getAttribute("data-shader-front"));
    if (back === null || ink === null || front === null || !(amount > 0 && amount < 1))
      return false;
    const expected = back.map((channel, index) =>
      Math.round(channel + ((ink[index] ?? channel) - channel) * amount),
    );
    return (
      node.getAttribute("data-shader-shape") === "warp" &&
      node.getAttribute("data-shader-speed") === "1" &&
      node.getAttribute("data-shader-back") === page.backgroundColor &&
      front.every((channel, index) => channel === expected[index]) &&
      node.querySelector("canvas") !== null
    );
  });
}

function alphaOf(color: string): number {
  const slash = color.match(/\/\s*([0-9.]+)\s*\)/);
  if (slash !== null) return Number(slash[1]);
  if (color === "transparent") return 0;
  const rgb = color.match(/^rgba?\(([^)]+)\)$/);
  // oklch(), lab() and color() print an alpha only after a slash.
  if (rgb === null) return /^[a-z-]+\([^)]*\)$/.test(color) ? 1 : Number.NaN;
  const parts = rgb[1].split(/[,\s/]+/).filter(Boolean);
  return parts.length === 4 ? Number(parts[3]) : 1;
}

test("follows the theme color and corner radius on the chrome", async ({
  app,
  browser,
  screen,
}) => {
  // The suite runs with reduced motion for speed; this test covers the shader's
  // normal drifting state explicitly.
  await browser.emulateMedia({ reducedMotion: "no-preference" });
  await browser.route("**/api/themes", async (route) => {
    await route.fulfill({
      json: {
        current: "solitude",
        selected: "solitude",
        themes: [
          {
            slug: "vantablack",
            name: "Vantablack",
            colors: {
              mode: "dark",
              background: "#000000",
              foreground: "#ffffff",
              surface: "#1a1a1a",
              muted: "#090909",
              mutedForeground: "#7a7a7a",
              border: "#1a1a1a",
              accent: "#8d8d8d",
              destructive: "#a4a4a4",
              selection: "#1a1a1a",
              palette: {
                red: "#a4a4a4",
                green: "#8d8d8d",
                yellow: "#b8b8b8",
                blue: "#9c9c9c",
                magenta: "#aaaaaa",
                cyan: "#b0b0b0",
                orange: "#c0c0c0",
                brown: "#7a7a7a",
              },
              radius: 0,
            },
          },
          {
            slug: "solitude",
            name: "Solitude",
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
              palette: {
                red: "#de6145",
                green: "#7f9f7f",
                yellow: "#d8b56a",
                blue: "#6f8fa8",
                magenta: "#a88fa8",
                cyan: "#6fa8a8",
                orange: "#d89a6a",
                brown: "#8a7460",
              },
              radius: 6,
            },
          },
        ],
      },
    });
  });
  await app.open("/");
  // The document and the live stream follow the server theme. Save Solitude
  // first so that setup matches the menu catalog below, then load once more.
  const posted = await browser.evaluate(async () => {
    const response = await fetch("/api/theme", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "solitude" }),
    });
    return response.ok;
  });
  if (posted) await app.open("/");
  await expect(screen.getByRole("button", "Settings")).toBeVisible();
  await expect
    .poll(() =>
      browser.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--radius").trim(),
      ),
    )
    .toBe("6px");

  const solitude = await browser.evaluate(() => {
    const dock = document.querySelector('[data-testid="composer-dock"]');
    const gear = document.querySelector("[data-pi-menu]");
    const send = Array.from(document.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "Send",
    );
    const dockStyle = dock === null ? null : getComputedStyle(dock);
    const gearStyle = gear === null ? null : getComputedStyle(gear);
    const gearBox = gear?.getBoundingClientRect();
    const sendBox = send?.getBoundingClientRect();
    return {
      radius: getComputedStyle(document.documentElement).getPropertyValue("--radius").trim(),
      background: getComputedStyle(document.documentElement)
        .getPropertyValue("--background")
        .trim(),
      surface: getComputedStyle(document.documentElement).getPropertyValue("--surface").trim(),
      page: getComputedStyle(document.body).backgroundColor,
      dockBackground: dockStyle?.backgroundColor ?? "",
      gearBackground: gearStyle?.backgroundColor ?? "",
      gearBorder: gearStyle?.borderTopWidth ?? "",
      gearWidth: gearBox?.width ?? 0,
      gearHeight: gearBox?.height ?? 0,
      gearRight: gearBox?.right ?? 0,
      sendWidth: sendBox?.width ?? 0,
      sendHeight: sendBox?.height ?? 0,
      sendRight: sendBox?.right ?? 0,
      buttonRadius: send === undefined ? "" : getComputedStyle(send).borderRadius,
    };
  });
  expect(solitude.radius).toBe("6px");
  expect(solitude.background.toLowerCase()).toBe("#101315");
  expect(solitude.surface.toLowerCase()).toBe("#0c0e10");
  expect(alphaOf(solitude.dockBackground)).toBeGreaterThan(0);
  expect(alphaOf(solitude.dockBackground)).toBeLessThan(1);
  expect(solitude.dockBackground).not.toBe(solitude.page);
  expect(alphaOf(solitude.gearBackground)).toBe(0);
  expect(solitude.gearBorder).toBe("0px");
  expect(solitude.gearWidth).toBeCloseTo(solitude.sendWidth, 0);
  expect(solitude.gearHeight).toBeCloseTo(solitude.sendHeight, 0);
  expect(solitude.gearRight).toBeCloseTo(solitude.sendRight, 0);
  expect(solitude.buttonRadius).toBe("6px");
  await expect.poll(() => shaderFollowsTheme(browser)).toBe(true);

  await screen.getByRole("button", "Settings").tap();
  await screen.getByRole("menuitem", { name: /^Theme/ }).tap();
  await screen.getByRole("menuitemradio", { name: "Vantablack" }).tap();

  const square = await browser.evaluate(() => {
    const send = Array.from(document.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "Send",
    );
    return {
      radius: getComputedStyle(document.documentElement).getPropertyValue("--radius").trim(),
      background: getComputedStyle(document.documentElement)
        .getPropertyValue("--background")
        .trim(),
      surface: getComputedStyle(document.documentElement).getPropertyValue("--surface").trim(),
      buttonRadius: send === undefined ? "" : getComputedStyle(send).borderRadius,
    };
  });
  expect(square.radius).toBe("0px");
  expect(square.background.toLowerCase()).toBe("#000000");
  expect(square.surface.toLowerCase()).toBe("#1a1a1a");
  expect(square.buttonRadius).toBe("0px");
  await expect.poll(() => shaderFollowsTheme(browser)).toBe(true);
  // The installed app's status and navigation bars follow one unscoped theme-color.
  const bars = await browser.evaluate(() =>
    [...document.querySelectorAll('meta[name="theme-color"]')].map((meta) => ({
      content: meta.getAttribute("content") ?? "",
      media: meta.getAttribute("media") ?? "",
    })),
  );
  expect(bars).toEqual([{ content: "#000000", media: "" }]);
  const scheme = await browser.evaluate(() =>
    [...document.querySelectorAll('meta[name="color-scheme"]')].map(
      (meta) => meta.getAttribute("content") ?? "",
    ),
  );
  expect(scheme).toEqual(["dark"]);
});

test("paints the pi-ui update note with the theme accent", async ({ app, browser, screen }) => {
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({
      json: {
        ...snapshot,
        conversationId: "version-update-e2e",
        messages: [
          ...messages.slice(0, 2),
          {
            id: "version-update",
            role: "system",
            text: "Updated pi-ui from 1.4.3 to 1.6.0. The agent has the changelog.",
            timestamp: "2026-01-01T00:00:03.000Z",
            order: 99,
          },
        ],
      },
    });
  });
  await browser.route("**/api/themes", async (route) => {
    await route.fulfill({
      json: {
        current: "vantablack",
        selected: "vantablack",
        themes: [
          {
            slug: "vantablack",
            name: "Vantablack",
            colors: {
              mode: "dark",
              background: "#000000",
              foreground: "#ffffff",
              surface: "#1a1a1a",
              muted: "#090909",
              mutedForeground: "#7a7a7a",
              border: "#1a1a1a",
              accent: "#8d8d8d",
              destructive: "#a4a4a4",
              selection: "#1a1a1a",
              palette: {
                red: "#a4a4a4",
                green: "#8d8d8d",
                yellow: "#b8b8b8",
                blue: "#9c9c9c",
                magenta: "#aaaaaa",
                cyan: "#b0b0b0",
                orange: "#c0c0c0",
                brown: "#7a7a7a",
              },
              radius: 0,
            },
          },
        ],
      },
    });
  });
  await app.open("/");
  await expect(
    screen.getByText("Updated pi-ui from 1.4.3 to 1.6.0. The agent has the changelog.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect
    .poll(() =>
      browser.evaluate(() => {
        const note = document.querySelector<HTMLElement>('[data-testid="version-update"]');
        return note === null
          ? null
          : {
              background: getComputedStyle(note).backgroundColor,
              accent: getComputedStyle(document.documentElement)
                .getPropertyValue("--accent")
                .trim(),
              warning: note.textContent?.includes("⚠") ?? false,
            };
      }),
    )
    .toEqual({ background: "rgb(141, 141, 141)", accent: "#8d8d8d", warning: false });
});

test("paints the app manifest with the active theme", async ({ app, browser, screen }) => {
  await app.open("/");
  await expect(screen.getByRole("button", "Settings")).toBeVisible();
  const painted = await browser.evaluate(async () => {
    const catalog = (await (await fetch("/api/themes", { cache: "no-store" })).json()) as {
      themes: Array<{ slug: string; colors: { background: string } }>;
    };
    const read = async () =>
      (await (await fetch("/manifest.webmanifest", { cache: "no-store" })).json()) as {
        theme_color?: string;
        background_color?: string;
        name?: string;
      };
    const plain =
      /^(#[0-9a-f]{3}(?:[0-9a-f]{3})?|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/i;
    const usable = catalog.themes.filter((theme) => plain.test(theme.colors.background));
    const results: Array<{ background: string; theme: string; back: string; name: string }> = [];
    for (const theme of usable.slice(0, 2)) {
      await fetch("/api/theme", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: theme.slug }),
      });
      const manifest = await read();
      results.push({
        background: theme.colors.background,
        theme: manifest.theme_color ?? "",
        back: manifest.background_color ?? "",
        name: manifest.name ?? "",
      });
    }
    const fallback = await read();
    return {
      results,
      name: fallback.name ?? "",
      theme: fallback.theme_color ?? "",
      back: fallback.background_color ?? "",
    };
  });
  // Without installed themes the stock manifest is served untouched, and its
  // defaults are dark so an installed app never bakes in a white system bar.
  expect(painted.name).toBe("pi");
  expect(painted.theme.length).toBeGreaterThan(0);
  expect(painted.back).not.toBe("#ffffff");
  for (const result of painted.results) {
    expect(result.theme).toBe(result.background);
    expect(result.back).toBe(result.background);
    expect(result.name).toBe("pi");
  }
});

test("keeps the manifest on the server URL when the theme changes", async ({
  app,
  browser,
  screen,
}) => {
  await browser.route("**/api/themes", async (route) => {
    await route.fulfill({
      json: {
        current: "pmbi",
        selected: "pmbi",
        themes: [
          {
            slug: "pmbi",
            name: "Pmbi",
            colors: {
              mode: "dark",
              background: "#101315",
              foreground: "#eeeeee",
              surface: "#202428",
              muted: "#0c0e10",
              mutedForeground: "#888888",
              border: "#343d41",
              accent: "#66ccff",
              destructive: "#c24040",
              selection: "#202428",
              palette: {
                red: "#c24040",
                green: "#57c785",
                yellow: "#e5c158",
                blue: "#66ccff",
                magenta: "#b978ff",
                cyan: "#43d4d0",
                orange: "#ff9558",
                brown: "#a98268",
              },
              radius: 0,
            },
          },
        ],
      },
    });
  });
  await app.open("/");
  await expect(screen.getByRole("button", "Settings")).toBeVisible();
  await expect
    .poll(() =>
      browser.evaluate(
        () => document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.href ?? "",
      ),
    )
    .toContain("?rev=");
  const manifest = await browser.evaluate(async () => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
    const href = link?.href ?? "";
    if (href === "") return null;
    const data = (await (await fetch(href, { cache: "no-store" })).json()) as {
      start_url?: string;
      scope?: string;
      icons?: Array<{ src?: string }>;
      share_target?: { action?: string };
    };
    return {
      href,
      blob: href.startsWith("blob:"),
      startUrl: data.start_url ?? "",
      scope: data.scope ?? "",
      icon: data.icons?.[0]?.src ?? "",
      action: data.share_target?.action ?? "",
    };
  });
  // A blob manifest makes Chrome ignore every relative install member.
  expect(manifest).not.toBeNull();
  expect(manifest?.blob).toBe(false);
  expect(new URL(manifest?.href ?? "").pathname).toBe("/manifest.webmanifest");
  expect(manifest?.startUrl).toBe("/");
  expect(manifest?.scope).toBe("/");
  expect(manifest?.icon).toBe("/icons/icon-192.png");
  expect(manifest?.action).toBe("/share");
});

test("embeds the saved theme in the first document", async ({ app, browser, screen }) => {
  await app.open("/");
  await expect(screen.getByRole("button", "Settings")).toBeVisible();
  const saved = await browser.evaluate(async () => {
    const catalog = (await (await fetch("/api/themes", { cache: "no-store" })).json()) as {
      themes: Array<{
        slug: string;
        colors: {
          background: string;
          surface: string;
          accent: string;
          radius: number;
          mode: string;
        };
      }>;
    };
    const theme = catalog.themes.find((item) => item.slug === "solitude") ?? catalog.themes[0];
    if (theme === undefined) {
      return {
        skipped: true,
        ok: false,
        slug: "",
        background: "",
        surface: "",
        accent: "",
        radius: "",
        mode: "",
        selected: "",
        tag: "",
        schemes: [] as string[],
      };
    }
    const response = await fetch("/api/theme", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: theme.slug }),
    });
    const html = await (await fetch(`/?document=${Date.now()}`, { cache: "reload" })).text();
    const listed = (await (await fetch("/api/themes", { cache: "no-store" })).json()) as {
      selected?: string | null;
    };
    const tag = html.match(/<html\b[^>]*>/)?.[0] ?? "";
    const schemes = [...html.matchAll(/<meta\b[^>]*\bname="color-scheme"[^>]*>/g)].map(
      (match) => match[0],
    );
    return {
      skipped: false,
      ok: response.ok,
      slug: theme.slug,
      background: theme.colors.background,
      surface: theme.colors.surface,
      accent: theme.colors.accent,
      radius: String(theme.colors.radius),
      mode: theme.colors.mode,
      selected: listed.selected ?? "",
      tag,
      schemes,
    };
  });
  if (saved.skipped) return;
  expect(saved.ok).toBe(true);
  expect(saved.selected).toBe(saved.slug);
  expect(saved.tag).toContain(`--background:${saved.background}`);
  expect(saved.tag).toContain(`--surface:${saved.surface}`);
  expect(saved.tag).toContain(`--accent:${saved.accent}`);
  expect(saved.tag).toContain(`--radius:${saved.radius}px`);
  expect(saved.tag).toContain(`color-scheme:${saved.mode}`);
  expect(saved.tag).toContain(`background-color:${saved.background}`);
  // One scheme for the UA's own surfaces, matching the theme rather than the phone.
  expect(saved.schemes).toEqual([`<meta name="color-scheme" content="${saved.mode}" />`]);
});

test("rebuilds the dither after the browser drops its WebGL context", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  await expect(screen.getByRole("button", "Settings")).toBeVisible();
  await expect
    .poll(() =>
      browser.evaluate(() => document.querySelector('[data-testid="shader-bg"] canvas') !== null),
    )
    .toBe(true);

  // What a phone does to a backgrounded installed app under GPU memory pressure.
  const dropped = await browser.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-testid="shader-bg"]');
    const canvas = host?.querySelector("canvas");
    const gl = canvas?.getContext("webgl2");
    const lose = gl?.getExtension("WEBGL_lose_context");
    if (!host || !canvas || !gl || !lose) return null;
    (window as unknown as { droppedCanvas?: HTMLCanvasElement }).droppedCanvas = canvas;
    lose.loseContext();
    return host.dataset.shaderGeneration ?? "";
  });
  if (dropped === null) return; // No WebGL in this browser: nothing to recover.
  expect(dropped).toBe("0");

  await expect
    .poll(() =>
      browser.evaluate(() => {
        const host = document.querySelector<HTMLElement>('[data-testid="shader-bg"]');
        const canvas = host?.querySelector("canvas") ?? null;
        const old = (window as unknown as { droppedCanvas?: HTMLCanvasElement }).droppedCanvas;
        const gl = canvas?.getContext("webgl2") ?? null;
        return {
          generation: host?.dataset.shaderGeneration ?? "",
          replaced: canvas !== null && canvas !== old,
          live: gl !== null && !gl.isContextLost(),
        };
      }),
    )
    .toEqual({ generation: "1", replaced: true, live: true });

  // While it recovers, the host shows the page color rather than a blank canvas.
  const paint = await browser.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-testid="shader-bg"]');
    const probe = document.createElement("span");
    probe.style.backgroundColor = host?.dataset.shaderColorBack ?? "";
    document.body.append(probe);
    const back = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { host: host === null ? "" : getComputedStyle(host).backgroundColor, back };
  });
  expect(paint.host).toBe(paint.back);
});
