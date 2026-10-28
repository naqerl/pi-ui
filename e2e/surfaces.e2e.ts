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
  const rgb = color.match(/^rgba?\(([^)]+)\)$/);
  if (rgb === null) return Number.NaN;
  const parts = rgb[1].split(/[,\s/]+/).filter(Boolean);
  return parts.length === 4 ? Number(parts[3]) : 1;
}

test("renders the header, composer bar and latest button as translucent blur", async ({
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
      if (element === null) return null;
      const style = getComputedStyle(element);
      return {
        backdropFilter: style.backdropFilter || style.getPropertyValue("-webkit-backdrop-filter"),
        backgroundColor: style.backgroundColor,
      };
    };
    const textarea = document.querySelector('textarea[aria-label="Message"]');
    const latest = Array.from(document.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("↓ latest"),
    );
    return {
      header: read(document.querySelector("header")),
      composer: read(textarea?.closest("form")?.parentElement ?? null),
      latest: read(latest ?? null),
    };
  });

  for (const surface of [styles.header, styles.composer, styles.latest]) {
    expect(surface).not.toBeNull();
    expect(surface?.backdropFilter ?? "").toContain("blur");
    expect(alphaOf(surface?.backgroundColor ?? "")).toBeGreaterThan(0);
    expect(alphaOf(surface?.backgroundColor ?? "")).toBeLessThan(1);
  }

  const input = await browser.evaluate(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
    if (textarea === null) return null;
    const style = getComputedStyle(textarea);
    return {
      background: style.backgroundColor,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      color: style.color,
      border: style.borderTopColor,
    };
  });
  expect(input).not.toBeNull();
  expect(input?.background).toBe(input?.bodyBackground);
  expect(input?.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(input?.background).not.toBe("rgb(0, 0, 0)");
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
    const main = document.querySelector("main");
    const header = document.querySelector("header");
    if (main === null || header === null) return null;
    main.scrollTop = Math.floor((main.scrollHeight - main.clientHeight) / 2);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    const mainBox = main.getBoundingClientRect();
    const headerBox = header.getBoundingClientRect();
    const bubbles = Array.from(main.querySelectorAll("div")).filter((element) =>
      element.className.includes("max-w-[85%]"),
    );
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
      headerTop: headerBox.top,
      hitInsideHeader: hit !== null && header.contains(hit),
      behindText: behind?.textContent ?? null,
    };
  });

  expect(geometry).not.toBeNull();
  expect(geometry?.headerTop ?? 0).toBeCloseTo(geometry?.mainTop ?? -1, 0);
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
      (button) => button.textContent ?? "",
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

  expect(queue.labels.some((label) => label.includes("Queue"))).toBe(true);
  for (const state of [send, stop, steer]) {
    expect(state).not.toBeNull();
    expect(state?.height ?? 0).toBeCloseTo(send?.height ?? -1, 0);
    expect(state?.right ?? 0).toBeCloseTo(state?.rowRight ?? -1, 0);
    expect(state?.right ?? 0).toBeCloseTo(send?.right ?? -1, 0);
    expect(state?.textareaRight ?? 0).toBeCloseTo(send?.textareaRight ?? -1, 0);
    expect(state?.barHeight ?? 0).toBeCloseTo(send?.barHeight ?? -1, 0);
  }
  expect(queue.height ?? 0).toBeCloseTo(send?.height ?? -1, 0);
  expect(queue.right ?? 0).toBeCloseTo(queue.rowRight ?? -1, 0);

  await composer.fill("");
  await screen.getByRole("button", "Stop").tap();
});
