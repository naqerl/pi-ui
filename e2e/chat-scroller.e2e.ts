import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

const longThread = {
  conversationId: "chat-scroller-composer-e2e",
  messages: Array.from({ length: 72 }, (_, index) => ({
    id: `thread-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    text: `Thread message ${index}: a transcript row whose layout must survive the composer animation.`,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
    order: index + 1,
  })),
  activity: [],
  run: "idle",
  queue: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
  context: { tokens: 0, window: null, percent: null },
};

/** The built app registers /sw.js, and a worker's requests bypass Playwright routes. */
async function openLongThread(
  app: { open: (path: string) => Promise<void> },
  browser: Browser,
  viewport: { width: number; height: number },
  hasTouch = false,
) {
  await browser.emulateMedia({ reducedMotion: "no-preference" });
  await browser.setViewport(viewport);
  await browser.addInitScript(() => {
    if (!("serviceWorker" in navigator)) return;
    Object.defineProperty(navigator.serviceWorker, "register", {
      configurable: true,
      value: async () => undefined,
    });
  });
  if (hasTouch) {
    // The web engine has no context-level hasTouch option; expose the capability the
    // phone case asks for so touch-only UI code sees a touch device.
    await browser.addInitScript(() => {
      Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 });
      Object.defineProperty(window, "ontouchstart", { configurable: true, value: null });
    });
  }
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: longThread });
  });
  await app.open("/");
}

interface ScrollerSnapshot {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  scrollerBottom: number;
  bodyHeight: number;
  bubbleTop: number;
  bubbleBottom: number;
  distance: number;
}

function readScroller(browser: Browser): Promise<ScrollerSnapshot | null> {
  return browser.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="chat-scroller"]');
    const body = document.querySelector<HTMLElement>('[data-testid="composer-body"]');
    const last = [...document.querySelectorAll<HTMLElement>("[data-role]")].at(-1);
    if (scroller === null || body === null || last === undefined) return null;
    const bubble = last.getBoundingClientRect();
    return {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      scrollerBottom: scroller.getBoundingClientRect().bottom,
      bodyHeight: body.getBoundingClientRect().height,
      bubbleTop: bubble.top,
      bubbleBottom: bubble.bottom,
      distance: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
    };
  });
}

async function pinToEnd(browser: Browser) {
  await browser.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="chat-scroller"]');
    if (scroller === null) return false;
    scroller.scrollTop = scroller.scrollHeight;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return true;
  });
  await expect
    .poll(async () => (await readScroller(browser))?.distance ?? 99)
    .toBeLessThanOrEqual(1);
}

for (const device of [
  { name: "desktop", width: 1280, height: 900, hasTouch: false },
  { name: "phone", width: 390, height: 844, hasTouch: true },
]) {
  test(`${device.name}: the composer resize moves the transcript and re-pins on expansion`, async ({
    app,
    browser,
    screen,
  }) => {
    await openLongThread(
      app,
      browser,
      { width: device.width, height: device.height },
      device.hasTouch,
    );
    await expect(screen.getByText("Thread message 71", { exact: false })).toBeVisible();
    await pinToEnd(browser);

    const before = await readScroller(browser);
    expect(before).not.toBeNull();

    await screen.getByRole("tab", "Stats").tap();
    await expect.poll(async () => (await readScroller(browser))?.bodyHeight ?? 99).toBe(0);
    const collapsed = await readScroller(browser);
    expect(collapsed).not.toBeNull();

    // Collapsing the composer grows the viewport by the body's height. The browser clamps
    // the old end offset, so the transcript travels down with the dock instead of the hook
    // pinning it to the new bottom edge.
    const viewportGrowth = (collapsed?.clientHeight ?? 0) - (before?.clientHeight ?? 0);
    expect(viewportGrowth).toBeGreaterThanOrEqual(40);
    expect((collapsed?.bubbleTop ?? 0) - (before?.bubbleTop ?? 0)).toBeGreaterThanOrEqual(40);
    expect(collapsed?.bubbleBottom ?? 0).toBeLessThanOrEqual((collapsed?.scrollerBottom ?? 0) + 1);

    await screen.getByRole("tab", "Chat").tap();
    await expect
      .poll(async () => (await readScroller(browser))?.bodyHeight ?? 0)
      .toBeGreaterThanOrEqual(40);
    await expect
      .poll(async () => (await readScroller(browser))?.distance ?? 99)
      .toBeLessThanOrEqual(8);
    const expanded = await readScroller(browser);
    expect(expanded).not.toBeNull();

    // Expanding the composer shrinks the viewport again: an attached reader is carried
    // back to the end so the last message is not left underneath the dock.
    expect(expanded?.distance ?? 99).toBeLessThanOrEqual(8);
    const bottomGap = (expanded?.scrollerBottom ?? 0) - (expanded?.bubbleBottom ?? 0);
    expect(bottomGap).toBeGreaterThanOrEqual(0);
    expect(bottomGap).toBeLessThanOrEqual(24);
    expect(Math.abs((expanded?.bubbleTop ?? 0) - (before?.bubbleTop ?? 0))).toBeLessThanOrEqual(2);

    // Content growth still owns the pin, so the reader stays attached after the switch.
    await browser.evaluate((label) => {
      const content = document.querySelector<HTMLElement>('[data-testid="chat-content"]');
      if (content === null) return false;
      const row = document.createElement("div");
      row.dataset.role = "assistant";
      row.dataset.testid = "appended-message";
      row.textContent = label;
      row.style.height = "80px";
      content.appendChild(row);
      return true;
    }, `Fresh message after composer ${device.name}`);
    await expect(
      screen.getByText(`Fresh message after composer ${device.name}`, { exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () => (await readScroller(browser))?.distance ?? 99)
      .toBeLessThanOrEqual(8);
  });
}

test("keeps an unattached reader's offset when the composer collapses", async ({
  app,
  browser,
  screen,
}) => {
  await openLongThread(app, browser, { width: 390, height: 844 }, true);
  await expect(screen.getByText("Thread message 71", { exact: false })).toBeVisible();
  await pinToEnd(browser);

  const before = await browser.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="chat-scroller"]');
    if (scroller === null) return null;
    scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - 300;
    scroller.dispatchEvent(new Event("scroll"));
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return {
      scrollTop: scroller.scrollTop,
      distance: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
    };
  });
  expect(before).not.toBeNull();
  expect(before?.distance ?? 0).toBeGreaterThan(250);

  await screen.getByRole("tab", "Stats").tap();
  await expect.poll(async () => (await readScroller(browser))?.bodyHeight ?? 99).toBe(0);
  const after = await readScroller(browser);
  expect(after).not.toBeNull();

  // A viewport resize must leave the reader where they were, not clamp them to the end.
  expect(Math.abs((after?.scrollTop ?? 0) - (before?.scrollTop ?? 0))).toBeLessThanOrEqual(1);
  expect(after?.distance ?? 0).toBeGreaterThan(250);
});
