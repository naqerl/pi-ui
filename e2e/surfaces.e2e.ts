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

async function openSeeded(app: { open: (path: string) => Promise<void> }, browser: Browser) {
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: snapshot });
  });
  await app.open("/");
}

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

async function waitForFrames(browser: Browser) {
  await browser.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return true;
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

test("paints the composer dock and latest button apart from the page", async ({
  app,
  browser,
  screen,
}) => {
  await openSeeded(app, browser);
  await expect(screen.getByText("Seed message 59", { exact: false })).toBeVisible();

  await browser.evaluate(() => {
    const main = document.querySelector("main");
    if (main !== null) main.scrollTop = 0;
    return true;
  });
  await expect(browser.locator("button").filter({ hasText: "↓ latest" })).toBeVisible();

  const styles = await browser.evaluate(() => {
    const read = (element: Element | null) => {
      if (element === null) return "";
      return getComputedStyle(element).backgroundColor;
    };
    const dock = document.querySelector('[data-testid="composer-dock"]');
    const latest = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("↓ latest"),
    );
    return {
      page: getComputedStyle(document.body).backgroundColor,
      dock: read(dock),
      latest: read(latest ?? null),
      assistant: read(
        Array.from(document.querySelectorAll("main div")).find(
          (element) =>
            element.className.includes("max-w-[85%]") &&
            element.textContent?.includes("Seed message 1"),
        ) ?? null,
      ),
    };
  });

  for (const surface of [styles.dock, styles.latest, styles.assistant]) {
    expect(surface).not.toBe("");
    expect(surface).not.toBe(styles.page);
  }
  expect(alphaOf(styles.dock)).toBeGreaterThan(0);
  expect(alphaOf(styles.dock)).toBeLessThan(1);
  expect(alphaOf(styles.latest)).toBe(1);
  expect(alphaOf(styles.assistant)).toBe(1);

  const glass = await browser.evaluate(async () => {
    const dock = document.querySelector<HTMLElement>('[data-testid="composer-dock"]');
    const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
    if (dock === null || field === null) return null;
    const transition = getComputedStyle(dock).transitionProperty;
    dock.style.transition = "none";
    field.blur();
    const idle = getComputedStyle(dock).backgroundColor;
    const idleBlur = getComputedStyle(dock).backdropFilter;
    field.focus();
    const focusedBackground = getComputedStyle(dock).backgroundColor;
    const focusedBlur = getComputedStyle(dock).backdropFilter;
    dock.style.transition = "";
    return {
      idleBlur,
      focusedBlur,
      idle,
      focused: focusedBackground,
      transition,
    };
  });
  expect(glass).not.toBeNull();
  expect(glass?.idleBlur ?? "").toContain("blur");
  expect(glass?.focusedBlur ?? "none").toBe("none");
  expect(glass?.transition ?? "").toContain("background-color");
  expect(alphaOf(glass?.idle ?? "")).toBeGreaterThan(0);
  expect(alphaOf(glass?.idle ?? "")).toBeLessThan(1);
  expect(alphaOf(glass?.focused ?? "")).toBe(1);

  const widths = await browser.evaluate(() => {
    const dock = document.querySelector('[data-testid="composer-dock"]');
    const footer = document.querySelector("textarea")?.closest("form")?.parentElement ?? null;
    const chromeRow = dock?.firstElementChild ?? null;
    const footerRow = document.querySelector("textarea")?.parentElement ?? null;
    if (dock === null || footer === null || chromeRow === null || footerRow === null) return null;
    const chromeStyle = getComputedStyle(chromeRow);
    const footerStyle = getComputedStyle(footerRow);
    return {
      dock: dock.getBoundingClientRect().width,
      chrome: chromeRow.getBoundingClientRect().width,
      composerRow: footerRow.getBoundingClientRect().width,
      chromePad: `${chromeStyle.paddingTop} ${chromeStyle.paddingLeft}`,
      footerPad: `${footerStyle.paddingTop} ${footerStyle.paddingLeft}`,
      fieldPadLeft: getComputedStyle(document.querySelector("textarea") ?? document.body)
        .paddingLeft,
    };
  });
  expect(widths).not.toBeNull();
  expect(Math.abs((widths?.chrome ?? 0) - (widths?.dock ?? 0))).toBeLessThanOrEqual(2);
  expect(Math.abs((widths?.composerRow ?? 0) - (widths?.dock ?? 0))).toBeLessThanOrEqual(2);
  expect(widths?.chromePad.split(" ")[0]).toBe(widths?.footerPad.split(" ")[0]);
  expect(Number.parseFloat(widths?.chromePad.split(" ")[1] ?? "")).toBeCloseTo(
    Number.parseFloat(widths?.footerPad.split(" ")[1] ?? "") +
      Number.parseFloat(widths?.fieldPadLeft ?? ""),
    0,
  );

  const input = await browser.evaluate(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
    if (textarea === null) return null;
    const style = getComputedStyle(textarea);
    const form = textarea.closest("form");
    const row = textarea.parentElement;
    return {
      background: style.backgroundColor,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      formBackground: form === null ? null : getComputedStyle(form).backgroundColor,
      rowBackground: row === null ? null : getComputedStyle(row).backgroundColor,
      color: style.color,
      border: style.borderTopColor,
    };
  });
  expect(input).not.toBeNull();
  expect(alphaOf(input?.background ?? "")).toBe(0);
  expect(alphaOf(input?.formBackground ?? "")).toBe(0);
  expect(alphaOf(input?.rowBackground ?? "")).toBe(0);
  expect(input?.background).not.toBe("rgb(0, 0, 0)");
  expect(input?.bodyBackground).not.toBe("rgba(0, 0, 0, 0)");
});

test("overlays the transcript with the blurred footer", async ({ app, browser, screen }) => {
  await openSeeded(app, browser);
  await expect(screen.getByText("Seed message 59", { exact: false })).toBeVisible();

  const geometry = await browser.evaluate(async () => {
    const frames = () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    const main = document.querySelector("main");
    const footer = document.querySelector<HTMLElement>('[data-testid="composer-dock"]');
    if (main === null || footer === null) return null;

    main.scrollTop = Math.floor((main.scrollHeight - main.clientHeight) / 2);
    await frames();

    const mainBox = main.getBoundingClientRect();
    const footerBox = footer.getBoundingClientRect();
    const style = getComputedStyle(footer);
    const bubbles = Array.from(main.querySelectorAll("div")).filter((element) =>
      element.className.includes("max-w-[85%]"),
    );

    let point: { x: number; y: number } | null = null;
    for (const bubble of bubbles) {
      const box = bubble.getBoundingClientRect();
      const top = Math.max(box.top, footerBox.top);
      const bottom = Math.min(box.bottom, footerBox.bottom);
      if (bottom - top > 8 && box.left + 8 < footerBox.right) {
        point = { x: box.left + 8, y: (top + bottom) / 2 };
        break;
      }
    }

    const hit = point === null ? null : document.elementFromPoint(point.x, point.y);
    footer.style.visibility = "hidden";
    const behind = point === null ? null : document.elementFromPoint(point.x, point.y);
    footer.style.visibility = "";
    const behindBubble = bubbles.find(
      (bubble) => behind !== null && (bubble === behind || bubble.contains(behind)),
    );

    main.scrollTop = main.scrollHeight;
    await frames();
    const lastBox = bubbles[bubbles.length - 1]?.getBoundingClientRect() ?? null;
    const footerAfter = footer.getBoundingClientRect();

    return {
      classes: footer.className,
      backdropFilter: style.backdropFilter || style.getPropertyValue("-webkit-backdrop-filter"),
      backgroundColor: style.backgroundColor,
      mainTop: mainBox.top,
      mainBottom: mainBox.bottom,
      mainLeft: mainBox.left,
      mainRight: mainBox.right,
      footerTop: footerBox.top,
      footerBottom: footerBox.bottom,
      footerLeft: footerBox.left,
      footerRight: footerBox.right,
      point: point !== null,
      hitInFooter: hit !== null && footer.contains(hit),
      behindInMessage: behindBubble !== undefined,
      lastTop: lastBox?.top ?? null,
      lastBottom: lastBox?.bottom ?? null,
      footerTopAtBottom: footerAfter.top,
      footerBottomAtBottom: footerAfter.bottom,
      columnLeft: main.lastElementChild?.getBoundingClientRect().left ?? null,
      columnRight: main.lastElementChild?.getBoundingClientRect().right ?? null,
      contentPaddingTop: getComputedStyle(main.lastElementChild ?? main).paddingTop,
      contentPaddingBottom: getComputedStyle(main.lastElementChild ?? main).paddingBottom,
      footerHeight: footerAfter.height,
      footerBorderTop: getComputedStyle(footer).borderTopWidth,
      footerBorderRight: getComputedStyle(footer).borderRightWidth,
    };
  });

  expect(geometry).not.toBeNull();
  expect(geometry?.footerTop ?? 0).toBeLessThan(geometry?.mainBottom ?? -1);
  expect(geometry?.footerBottom ?? 0).toBeGreaterThan(geometry?.mainTop ?? Number.MAX_VALUE);
  expect((geometry?.mainBottom ?? 0) - (geometry?.footerBottomAtBottom ?? 0)).toBeLessThanOrEqual(
    1,
  );
  expect(geometry?.footerLeft ?? 0).toBeGreaterThan((geometry?.mainLeft ?? 0) + 4);
  expect(geometry?.footerRight ?? 0).toBeLessThan((geometry?.mainRight ?? 0) - 4);
  expect(geometry?.footerLeft ?? 0).toBeLessThan((geometry?.columnLeft ?? 0) - 4);
  expect(geometry?.footerRight ?? 0).toBeGreaterThan((geometry?.columnRight ?? 0) + 4);
  expect((geometry?.footerLeft ?? 0) - (geometry?.mainLeft ?? 0)).toBeCloseTo(
    (geometry?.mainRight ?? 0) - (geometry?.footerRight ?? 0),
    0,
  );
  expect(geometry?.classes ?? "").toContain("float-footer");
  expect(geometry?.backdropFilter ?? "").toContain("blur");
  expect(alphaOf(geometry?.backgroundColor ?? "")).toBeGreaterThan(0);
  expect(alphaOf(geometry?.backgroundColor ?? "")).toBeLessThan(1);
  expect(geometry?.point).toBe(true);
  expect(geometry?.hitInFooter).toBe(true);
  expect(geometry?.behindInMessage).toBe(true);
  const endGap = 16;
  expect(geometry?.lastBottom ?? Number.MAX_VALUE).toBeLessThanOrEqual(
    (geometry?.footerTopAtBottom ?? -1) - endGap + 1,
  );
  expect(geometry?.lastTop ?? Number.MAX_VALUE).toBeLessThan(geometry?.footerTopAtBottom ?? -1);
  const padding = Number.parseFloat(geometry?.contentPaddingBottom ?? "");
  const clearance = (geometry?.mainBottom ?? 0) - (geometry?.footerTopAtBottom ?? 0);
  expect(padding).toBeCloseTo(clearance + endGap, 0);
  const paddingTop = Number.parseFloat(geometry?.contentPaddingTop ?? "");
  expect(paddingTop).toBeCloseTo(endGap, 0);
  expect(geometry?.footerBorderTop).toBe("1px");
  expect(geometry?.footerBorderRight).toBe("1px");
});

test("returns the composer to one line after sending over the overlay footer", async ({
  app,
  browser,
  screen,
}) => {
  await openSeeded(app, browser);
  const composer = screen.getByRole("textbox", "Message");
  const initial = await composer.boundingBox();
  expect(initial).not.toBeNull();

  await composer.fill("line one\nline two\nline three");
  const expanded = await composer.boundingBox();
  expect(expanded?.height ?? 0).toBeGreaterThan(initial?.height ?? 0);

  await screen.getByRole("button", "Send").tap();
  await expect(composer).toHaveValue("");

  const after = await composer.boundingBox();
  expect(after?.height ?? 0).toBeCloseTo(initial?.height ?? -1, 0);

  const state = await browser.evaluate(() => {
    const element = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
    const footer = document.querySelector<HTMLElement>('[data-testid="composer-dock"]');
    if (element === null) return null;
    if (footer !== null) footer.style.transition = "none";
    return {
      overflowY: getComputedStyle(element).overflowY,
      background: getComputedStyle(element).backgroundColor,
      footerBackground: footer === null ? null : getComputedStyle(footer).backgroundColor,
    };
  });
  expect(state).not.toBeNull();
  expect(state?.overflowY).toBe("hidden");
  expect(alphaOf(state?.background ?? "")).toBe(0);
  expect(alphaOf(state?.footerBackground ?? "")).toBe(1);
});

test("keeps the interrupted-run warning visible outside the scroll container", async ({
  app,
  browser,
  screen,
}) => {
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: { ...snapshot, run: "interrupted" } });
  });
  await app.open("/");
  await expect(screen.getByText("Seed message 59", { exact: false })).toBeVisible();
  await expect(screen.getByRole("status")).toBeVisible();

  const geometry = await browser.evaluate(() => {
    const main = document.querySelector("main");
    const banner = document.querySelector('[role="status"]');
    if (main === null || banner === null) return null;
    const bannerBox = banner.getBoundingClientRect();
    return {
      insideMain: main.contains(banner),
      bannerTop: bannerBox.top,
      bannerBottom: bannerBox.bottom,
      mainTop: main.getBoundingClientRect().top,
      viewportHeight: window.innerHeight,
    };
  });

  expect(geometry).not.toBeNull();
  expect(geometry?.insideMain).toBe(false);
  expect(geometry?.bannerTop ?? -1).toBeGreaterThanOrEqual(0);
  expect(geometry?.bannerBottom ?? 0).toBeLessThanOrEqual(geometry?.viewportHeight ?? 0);
  expect(geometry?.bannerBottom ?? 0).toBeLessThanOrEqual(geometry?.mainTop ?? 0);
});

test("scrolls message content without a sticky header", async ({ app, browser, screen }) => {
  await openSeeded(app, browser);
  await expect(screen.getByText("Seed message 59", { exact: false })).toBeVisible();

  const geometry = await browser.evaluate(async () => {
    const frames = () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    const main = document.querySelector("main");
    const content = main?.firstElementChild;
    const dock = document.querySelector('[data-testid="composer-dock"]');
    if (main === null || content === null || content === undefined || dock === null) return null;
    main.scrollTop = Math.floor((main.scrollHeight - main.clientHeight) / 2);
    await frames();

    const mainBox = main.getBoundingClientRect();
    const dockBox = dock.getBoundingClientRect();
    const topHit = document.elementFromPoint(mainBox.left + 8, mainBox.top + 8);
    return {
      noHeader: document.querySelector("header") === null,
      scrollTop: main.scrollTop,
      mainTop: mainBox.top,
      mainLeft: mainBox.left,
      mainRight: mainBox.right,
      dockTop: dockBox.top,
      topPadding: getComputedStyle(content).paddingTop,
      topEdgeInsideMain: topHit !== null && main.contains(topHit),
    };
  });

  expect(geometry).not.toBeNull();
  expect(geometry?.noHeader).toBe(true);
  expect(geometry?.scrollTop ?? 0).toBeGreaterThan(0);
  expect(Number.parseFloat(geometry?.topPadding ?? "")).toBeCloseTo(16, 0);
  expect(geometry?.topEdgeInsideMain).toBe(true);
  expect(geometry?.dockTop ?? 0).toBeGreaterThan(geometry?.mainTop ?? Number.MAX_VALUE);
});

test("keeps the latest button still across an extra scroll event", async ({
  app,
  browser,
  screen,
}) => {
  await openSeeded(app, browser);
  await expect(screen.getByText("Seed message 59", { exact: false })).toBeVisible();

  await browser.evaluate(() => {
    const main = document.querySelector("main");
    if (main !== null) main.scrollTop = 0;
    return true;
  });
  const latest = browser.locator("button").filter({ hasText: "↓ latest" });
  await expect(latest).toBeVisible();
  const before = await latest.boundingBox();
  expect(before).not.toBeNull();

  await browser.evaluate(async () => {
    const main = document.querySelector("main");
    if (main !== null) main.scrollBy(0, 24);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return true;
  });
  const after = await latest.boundingBox();
  expect(after).not.toBeNull();
  expect(after?.x ?? 0).toBeCloseTo(before?.x ?? -1, 0);
  expect(after?.y ?? 0).toBeCloseTo(before?.y ?? -1, 0);
  expect(after?.width ?? 0).toBeCloseTo(before?.width ?? -1, 0);
  expect(after?.height ?? 0).toBeCloseTo(before?.height ?? -1, 0);
});

test("uses one action-button height and a stable composer bar height", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");

  const measure = async () =>
    await browser.evaluate(() => {
      const textarea = document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message"]',
      );
      const bar = document.querySelector('[data-testid="composer-dock"]');
      const row = textarea?.parentElement ?? null;
      // The action button sits last in the row, after the attach button.
      const button = [...(row?.querySelectorAll("button") ?? [])].at(-1) ?? null;
      if (textarea === null || bar === null || row === null || button === null) return null;
      const buttonBox = button.getBoundingClientRect();
      const textareaBox = textarea.getBoundingClientRect();
      const rowBox = row.getBoundingClientRect();
      const paddingRight = Number.parseFloat(getComputedStyle(row).paddingRight) || 0;
      return {
        height: buttonBox.height,
        right: buttonBox.right,
        rowRight: rowBox.right - paddingRight,
        textareaRight: textareaBox.right,
        barHeight: bar.getBoundingClientRect().height,
      };
    });

  const send = await measure();
  expect(send).not.toBeNull();

  await composer.fill("SLOW response please");
  await screen.getByRole("button", "Send").tap();
  await expect(screen.getByRole("button", "Stop")).toBeVisible();
  await expect(screen.getByTestId("working-status")).toHaveAttribute("data-open", "true");
  await browser.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return true;
  });
  const stop = await measure();

  await composer.fill("typed while running");
  await expect(screen.getByRole("button", "Steer")).toBeVisible();
  const steer = await measure();

  const steerBox = await screen.getByRole("button", "Steer").boundingBox();
  expect(steerBox).not.toBeNull();
  await browser.mouse.move(
    (steerBox?.x ?? 0) + (steerBox?.width ?? 0) / 2,
    (steerBox?.y ?? 0) + (steerBox?.height ?? 0) / 2,
  );
  await browser.mouse.down();
  await waitForFrames(browser);
  const queue = await browser.evaluate(async () => {
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
    const row = textarea?.parentElement ?? null;
    const labels = Array.from(row?.querySelectorAll("button") ?? [])
      .map((button) => button.getAttribute("aria-label") ?? "")
      .filter((label) => label !== "Attach image");
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const button = [...(row?.querySelectorAll("button") ?? [])].at(-1) ?? null;
    const rowBox = row?.getBoundingClientRect() ?? null;
    const paddingRight =
      row === null ? 0 : Number.parseFloat(getComputedStyle(row).paddingRight) || 0;
    return {
      labels,
      height: button?.getBoundingClientRect().height ?? null,
      right: button?.getBoundingClientRect().right ?? null,
      rowRight: rowBox === null ? null : rowBox.right - paddingRight,
      textareaRight: textarea?.getBoundingClientRect().right ?? null,
    };
  });
  await browser.mouse.up();

  expect(queue.labels).toEqual(["Steer"]);
  expect(queue.labels.some((label) => label.includes("Queue"))).toBe(false);
  for (const state of [send, stop, steer]) {
    expect(state).not.toBeNull();
    expect(state?.height ?? 0).toBeCloseTo(send?.height ?? -1, 0);
    expect(state?.right ?? 0).toBeCloseTo(state?.rowRight ?? -1, 0);
    expect(state?.right ?? 0).toBeCloseTo(send?.right ?? -1, 0);
    expect(state?.textareaRight ?? 0).toBeCloseTo(send?.textareaRight ?? -1, 0);
  }
  expect(stop?.barHeight ?? 0).toBeCloseTo(send?.barHeight ?? -1, 0);
  expect(steer?.barHeight ?? 0).toBeCloseTo(stop?.barHeight ?? -1, 0);
  expect(queue.height ?? 0).toBeCloseTo(send?.height ?? -1, 0);
  expect(queue.right ?? 0).toBeCloseTo(queue.rowRight ?? -1, 0);

  await composer.fill("");
  await screen.getByRole("button", "Stop").tap();
});

test("follows the theme color and corner radius on the chrome", async ({
  app,
  browser,
  screen,
}) => {
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
    return {
      radius: getComputedStyle(document.documentElement).getPropertyValue("--radius").trim(),
      background: getComputedStyle(document.documentElement)
        .getPropertyValue("--background")
        .trim(),
      surface: getComputedStyle(document.documentElement).getPropertyValue("--surface").trim(),
      page: getComputedStyle(document.body).backgroundColor,
      dockBackground: dockStyle?.backgroundColor ?? "",
      gearBackground: gearStyle?.backgroundColor ?? "",
      buttonRadius: send === undefined ? "" : getComputedStyle(send).borderRadius,
    };
  });
  expect(solitude.radius).toBe("6px");
  expect(solitude.background.toLowerCase()).toBe("#101315");
  expect(solitude.surface.toLowerCase()).toBe("#0c0e10");
  expect(alphaOf(solitude.dockBackground)).toBeGreaterThan(0);
  expect(alphaOf(solitude.dockBackground)).toBeLessThan(1);
  expect(solitude.dockBackground).not.toBe(solitude.page);
  expect(alphaOf(solitude.gearBackground)).toBe(1);
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
