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
  await browser.route("**/api/state", async (route) => {
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

test("paints the header, composer bar and latest button apart from the page", async ({
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
    const textarea = document.querySelector('textarea[aria-label="Message"]');
    const latest = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("↓ latest"),
    );
    return {
      page: getComputedStyle(document.body).backgroundColor,
      header: read(document.querySelector("header")),
      composer: read(textarea?.closest("form")?.parentElement ?? null),
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

  for (const surface of [styles.header, styles.composer, styles.latest, styles.assistant]) {
    expect(surface).not.toBe("");
    expect(surface).not.toBe(styles.page);
  }
  expect(alphaOf(styles.header)).toBeGreaterThan(0);
  expect(alphaOf(styles.header)).toBeLessThan(1);
  expect(alphaOf(styles.composer)).toBeGreaterThan(0);
  expect(alphaOf(styles.composer)).toBeLessThan(1);
  expect(alphaOf(styles.latest)).toBe(1);
  expect(alphaOf(styles.assistant)).toBe(1);

  const glass = await browser.evaluate(async () => {
    const header = document.querySelector("header");
    const field = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
    const footer = field?.closest("form")?.parentElement ?? null;
    if (header === null || field === null || footer === null) return null;
    const transition = getComputedStyle(footer).transitionProperty;
    const headerBlur = getComputedStyle(header).backdropFilter;
    footer.style.transition = "none";
    field.blur();
    const idle = getComputedStyle(footer).backgroundColor;
    const idleBlur = getComputedStyle(footer).backdropFilter;
    field.focus();
    const focusedBackground = getComputedStyle(footer).backgroundColor;
    const footerBlur = getComputedStyle(footer).backdropFilter;
    footer.style.transition = "";
    return {
      headerBlur,
      idleBlur,
      footerBlur,
      idle,
      focused: focusedBackground,
      transition,
    };
  });
  expect(glass).not.toBeNull();
  expect(glass?.headerBlur ?? "").toContain("blur");
  expect(glass?.idleBlur ?? "").toContain("blur");
  expect(glass?.footerBlur ?? "none").toBe("none");
  expect(glass?.transition ?? "").toContain("background-color");
  expect(alphaOf(glass?.idle ?? "")).toBeGreaterThan(0);
  expect(alphaOf(glass?.idle ?? "")).toBeLessThan(1);
  expect(alphaOf(glass?.focused ?? "")).toBe(1);

  const widths = await browser.evaluate(() => {
    const header = document.querySelector("header");
    const footer = document.querySelector("textarea")?.closest("form")?.parentElement ?? null;
    const headerRow = header?.firstElementChild ?? null;
    const footerRow = document.querySelector("textarea")?.parentElement ?? null;
    if (header === null || footer === null || headerRow === null || footerRow === null) return null;
    const headerStyle = getComputedStyle(headerRow);
    const footerStyle = getComputedStyle(footerRow);
    return {
      header: header.getBoundingClientRect().width,
      footer: footer.getBoundingClientRect().width,
      headerPad: `${headerStyle.paddingTop} ${headerStyle.paddingLeft}`,
      footerPad: `${footerStyle.paddingTop} ${footerStyle.paddingLeft}`,
      fieldPadLeft: getComputedStyle(document.querySelector("textarea") ?? document.body)
        .paddingLeft,
    };
  });
  expect(widths).not.toBeNull();
  expect(widths?.header ?? 0).toBeCloseTo(widths?.footer ?? -1, 0);
  expect(widths?.headerPad.split(" ")[0]).toBe(widths?.footerPad.split(" ")[0]);
  expect(Number.parseFloat(widths?.headerPad.split(" ")[1] ?? "")).toBeCloseTo(
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
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
    const footer = textarea?.closest("form")?.parentElement ?? null;
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
      headerBottom: document.querySelector("header")?.getBoundingClientRect().bottom ?? null,
      footerHeight: footerAfter.height,
      headerBorderBottom: getComputedStyle(document.querySelector("header") ?? document.body)
        .borderBottomWidth,
      headerBorderLeft: getComputedStyle(document.querySelector("header") ?? document.body)
        .borderLeftWidth,
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
  const headerClearance = (geometry?.headerBottom ?? 0) - (geometry?.mainTop ?? 0);
  expect(paddingTop).toBeCloseTo(headerClearance + endGap, 0);
  expect(geometry?.headerBorderBottom).toBe("1px");
  expect(geometry?.headerBorderLeft).toBe("1px");
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
    const footer = element?.closest("form")?.parentElement ?? null;
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
  await browser.route("**/api/state", async (route) => {
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

test("scrolls message content under the sticky header", async ({ app, browser, screen }) => {
  await openSeeded(app, browser);
  await expect(screen.getByText("Seed message 59", { exact: false })).toBeVisible();

  const geometry = await browser.evaluate(async () => {
    const frames = () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
    const main = document.querySelector("main");
    const header = document.querySelector("header");
    if (main === null || header === null) return null;
    main.scrollTop = Math.floor((main.scrollHeight - main.clientHeight) / 2);
    await frames();

    const bubbles = Array.from(main.querySelectorAll("div")).filter((element) =>
      element.className.includes("max-w-[85%]"),
    );
    const headerNow = header.getBoundingClientRect();
    const wide =
      bubbles.find((element) => element.getBoundingClientRect().width > headerNow.width) ??
      bubbles[0];
    if (wide !== undefined) {
      main.scrollTop += wide.getBoundingClientRect().top - headerNow.top;
      await frames();
    }

    const mainBox = main.getBoundingClientRect();
    const headerBox = header.getBoundingClientRect();
    const behind = bubbles.find((element) => {
      const box = element.getBoundingClientRect();
      return (
        box.top < headerBox.bottom &&
        box.bottom > headerBox.top &&
        box.left < headerBox.right &&
        box.right > headerBox.left
      );
    });
    const hit = document.elementFromPoint(
      headerBox.left + 8,
      headerBox.top + Math.min(20, headerBox.height / 2),
    );
    return {
      mainTop: mainBox.top,
      mainLeft: mainBox.left,
      mainRight: mainBox.right,
      mainWidth: mainBox.width,
      headerTop: headerBox.top,
      headerLeft: headerBox.left,
      headerRight: headerBox.right,
      headerWidth: headerBox.width,
      columnLeft: main.firstElementChild?.getBoundingClientRect().left ?? 0,
      columnRight: main.firstElementChild?.getBoundingClientRect().right ?? 0,
      hitInsideHeader: hit !== null && header.contains(hit),
      behindText: behind?.textContent ?? "",
    };
  });

  expect(geometry).not.toBeNull();
  expect((geometry?.headerTop ?? 0) - (geometry?.mainTop ?? 0)).toBeLessThanOrEqual(1);
  expect(geometry?.headerLeft ?? 0).toBeGreaterThan((geometry?.mainLeft ?? 0) + 4);
  expect(geometry?.headerRight ?? 0).toBeLessThan((geometry?.mainRight ?? 0) - 4);
  expect(geometry?.headerLeft ?? 0).toBeLessThan((geometry?.columnLeft ?? 0) - 4);
  expect(geometry?.headerRight ?? 0).toBeGreaterThan((geometry?.columnRight ?? 0) + 4);
  expect((geometry?.headerLeft ?? 0) - (geometry?.mainLeft ?? 0)).toBeCloseTo(
    (geometry?.mainRight ?? 0) - (geometry?.headerRight ?? 0),
    0,
  );
  expect(geometry?.hitInsideHeader).toBe(true);
  expect(geometry?.behindText ?? "").toContain("Seed message");
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
      const bar = textarea?.closest("form")?.parentElement ?? null;
      const row = textarea?.parentElement ?? null;
      const button = row?.querySelector("button") ?? null;
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
    const labels = Array.from(row?.querySelectorAll("button") ?? []).map(
      (button) => button.getAttribute("aria-label") ?? "",
    );
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const button = row?.querySelector("button") ?? null;
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
  expect(stop?.barHeight ?? 0).toBeGreaterThan(send?.barHeight ?? 0);
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
  await expect(screen.getByRole("button", "pi")).toBeVisible();
  await expect
    .poll(() =>
      browser.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--radius").trim(),
      ),
    )
    .toBe("6px");

  const solitude = await browser.evaluate(() => {
    const header = document.querySelector("header");
    const send = Array.from(document.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "Send",
    );
    const headerStyle = header === null ? null : getComputedStyle(header);
    return {
      radius: getComputedStyle(document.documentElement).getPropertyValue("--radius").trim(),
      background: getComputedStyle(document.documentElement)
        .getPropertyValue("--background")
        .trim(),
      surface: getComputedStyle(document.documentElement).getPropertyValue("--surface").trim(),
      page: getComputedStyle(document.body).backgroundColor,
      headerBackground: headerStyle?.backgroundColor ?? "",
      buttonRadius: send === undefined ? "" : getComputedStyle(send).borderRadius,
    };
  });
  expect(solitude.radius).toBe("6px");
  expect(solitude.background.toLowerCase()).toBe("#101315");
  expect(solitude.surface.toLowerCase()).toBe("#0c0e10");
  expect(alphaOf(solitude.headerBackground)).toBeGreaterThan(0);
  expect(alphaOf(solitude.headerBackground)).toBeLessThan(1);
  expect(solitude.headerBackground).not.toBe(solitude.page);
  expect(solitude.buttonRadius).toBe("6px");
  await expect.poll(() => shaderFollowsTheme(browser)).toBe(true);

  await screen.getByRole("button", "pi").tap();
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
});

test("embeds the saved theme in the first document", async ({ app, browser, screen }) => {
  await app.open("/");
  await expect(screen.getByRole("button", "pi")).toBeVisible();
  const saved = await browser.evaluate(async () => {
    const catalog = (await (await fetch("/api/themes", { cache: "no-store" })).json()) as {
      themes: Array<{
        slug: string;
        colors: { background: string; surface: string; radius: number; mode: string };
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
        radius: "",
        mode: "",
        selected: "",
        tag: "",
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
    return {
      skipped: false,
      ok: response.ok,
      slug: theme.slug,
      background: theme.colors.background,
      surface: theme.colors.surface,
      radius: String(theme.colors.radius),
      mode: theme.colors.mode,
      selected: listed.selected ?? "",
      tag,
    };
  });
  if (saved.skipped) return;
  expect(saved.ok).toBe(true);
  expect(saved.selected).toBe(saved.slug);
  expect(saved.tag).toContain(`--background:${saved.background}`);
  expect(saved.tag).toContain(`--surface:${saved.surface}`);
  expect(saved.tag).toContain(`--radius:${saved.radius}px`);
  expect(saved.tag).toContain(`color-scheme:${saved.mode}`);
  expect(saved.tag).toContain(`background-color:${saved.background}`);
});
