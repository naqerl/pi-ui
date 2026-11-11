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
  await browser.emulateMedia({ reducedMotion: "no-preference" });
  await openSeeded(app, browser);
  await expect(screen.getByText("Seed message 59", { exact: false })).toBeVisible();

  await browser.evaluate(() => {
    const main = document.querySelector("main");
    if (main !== null) main.scrollTop = 0;
    return true;
  });
  await expect(browser.locator('[data-testid="latest-button"]')).toBeVisible();

  const styles = await browser.evaluate(() => {
    const read = (element: Element | null) => {
      if (element === null) return "";
      return getComputedStyle(element).backgroundColor;
    };
    const dock = document.querySelector('[data-testid="composer-dock"]');
    const latest = document.querySelector('[data-testid="latest-button"]');
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
    const chromeRow = dock?.querySelector(".ink-line") ?? null;
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

test("keeps the transcript viewport above the blurred footer", async ({ app, browser, screen }) => {
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
  expect(geometry?.mainBottom ?? Number.MAX_VALUE).toBeLessThanOrEqual(
    (geometry?.footerTop ?? -1) + 1,
  );
  expect(geometry?.footerBottom ?? 0).toBeGreaterThan(geometry?.footerTop ?? Number.MAX_VALUE);
  expect(geometry?.footerBottomAtBottom ?? 0).toBeGreaterThan(
    geometry?.footerTopAtBottom ?? Number.MAX_VALUE,
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
  const endGap = 16;
  expect(geometry?.lastBottom ?? Number.MAX_VALUE).toBeLessThanOrEqual(
    (geometry?.footerTopAtBottom ?? -1) - endGap + 1,
  );
  expect(geometry?.lastTop ?? Number.MAX_VALUE).toBeLessThan(geometry?.footerTopAtBottom ?? -1);
  const padding = Number.parseFloat(geometry?.contentPaddingBottom ?? "");
  const clearance = (geometry?.mainBottom ?? 0) - (geometry?.footerTopAtBottom ?? 0);
  expect(Math.abs(clearance)).toBeLessThanOrEqual(1);
  expect(padding).toBeCloseTo(endGap, 0);
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
  const latest = browser.locator('[data-testid="latest-button"]');
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
