import { type Browser, test } from "@e2e-dev/web";
import { expect, type Screen } from "e2e";

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();

const fixture = {
  conversationId: "chat-page-switch-e2e",
  messages: Array.from({ length: 72 }, (_, index) => ({
    id: `thread-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    text: `Thread message ${index}: a transcript row whose reading position must survive a page switch.`,
    timestamp: at(index),
    order: index + 1,
  })),
  activity: [],
  run: "idle",
  queue: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
  context: { tokens: 0, window: null, percent: null },
  tasks: {
    // Far ahead of the live server so its stream cannot replace this ledger.
    revision: 1_000_000,
    tasks: [
      {
        id: "page-switch-open",
        title: "Live task",
        status: "open",
        parentId: null,
        blockedBy: [],
        createdAt: at(10),
      },
      {
        id: "page-switch-done",
        title: "Finished task",
        status: "done",
        parentId: null,
        blockedBy: [],
        createdAt: at(11),
        completedAt: new Date().toISOString(),
        completion: { evidence: "e2e/chat-page-switch.e2e.ts" },
      },
    ],
  },
};

interface Device {
  name: string;
  width: number;
  height: number;
  hasTouch: boolean;
}

const devices: Device[] = [
  { name: "desktop", width: 1280, height: 900, hasTouch: false },
  { name: "phone", width: 390, height: 844, hasTouch: true },
];

/** The built app registers /sw.js, and a worker's requests bypass Playwright routes. */
async function openThread(
  app: { open: (path: string) => Promise<void> },
  browser: Browser,
  screen: Screen,
  device: Device,
) {
  // The dock animation is part of the reported mechanism, so keep motion on.
  await browser.emulateMedia({ reducedMotion: "no-preference" });
  await browser.setViewport({ width: device.width, height: device.height });
  await browser.addInitScript(() => {
    if (!("serviceWorker" in navigator)) return;
    Object.defineProperty(navigator.serviceWorker, "register", {
      configurable: true,
      value: async () => undefined,
    });
  });
  if (device.hasTouch) {
    // The web engine has no context-level hasTouch option; expose the capability the
    // phone case asks for so touch-only UI code sees a touch device.
    await browser.addInitScript(() => {
      Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 });
      Object.defineProperty(window, "ontouchstart", { configurable: true, value: null });
    });
  }
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: JSON.parse(JSON.stringify(fixture)) });
  });
  await app.open("/");
  await expect(screen.getByText("Thread message 71", { exact: false })).toBeVisible();
}

interface ReadingPosition {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distance: number;
  lastTop: number;
  lastId: string | null;
  anchorId: string | null;
  anchorTop: number | null;
}

function readPosition(browser: Browser): Promise<ReadingPosition | null> {
  return browser.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="chat-scroller"]');
    if (scroller === null) return null;
    const scrollerTop = scroller.getBoundingClientRect().top;
    const rows = [
      ...document.querySelectorAll<HTMLElement>('[data-testid="chat-content"] [data-role]'),
    ];
    const last = rows.at(-1);
    let anchorId: string | null = null;
    let anchorTop: number | null = null;
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      if (rect.bottom <= scrollerTop + 1) continue;
      anchorId = row.dataset.messageId ?? null;
      anchorTop = rect.top - scrollerTop;
      break;
    }
    return {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      distance: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
      lastTop: last?.getBoundingClientRect().top ?? 0,
      lastId: last?.dataset.messageId ?? null,
      anchorId,
      anchorTop,
    };
  });
}

function describe(label: string, before: ReadingPosition | null, after: ReadingPosition | null) {
  return `${label}: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`;
}

/** Let the 220 ms dock transition finish before measuring the settled position. */
async function settleDock(browser: Browser) {
  await browser.evaluate(async () => {
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 360);
    });
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return true;
  });
}

async function pinToEnd(browser: Browser) {
  await browser.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="chat-scroller"]');
    if (scroller !== null) {
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event("scroll"));
    }
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return true;
  });
  await expect
    .poll(async () => (await readPosition(browser))?.distance ?? 99)
    .toBeLessThanOrEqual(1);
}

async function detach(browser: Browser, gap = 300) {
  await browser.evaluate(async (distance) => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="chat-scroller"]');
    if (scroller === null) return false;
    scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight - distance;
    scroller.dispatchEvent(new Event("scroll"));
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return true;
  }, gap);
  await expect
    .poll(async () => (await readPosition(browser))?.distance ?? 0)
    .toBeGreaterThanOrEqual(gap - 2);
}

/** Add rows below the reader while the chat is off-screen, as a streamed reply would. */
async function appendRowsBelow(browser: Browser, count: number) {
  await browser.evaluate((rows) => {
    const content = document.querySelector<HTMLElement>('[data-testid="chat-content"]');
    if (content === null) return false;
    for (let index = 0; index < rows; index += 1) {
      const row = document.createElement("div");
      row.dataset.role = "assistant";
      row.dataset.messageId = `landed-${index}`;
      row.textContent = `A message that landed while the chat was off-screen ${index}.`;
      row.style.height = "80px";
      content.append(row);
    }
    return true;
  }, count);
}

async function switchTo(browser: Browser, screen: Screen, id: string) {
  await screen.getByTestId(`page-dot-${id}`).tap();
  await expect(screen.getByTestId(`page-dot-${id}`)).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() =>
      browser.evaluate(
        () => document.querySelector("[data-testid=pager]")?.getAttribute("data-page") ?? null,
      ),
    )
    .toBe(id);
  await settleDock(browser);
}

async function roundTrip(browser: Browser, screen: Screen, target = "tasks") {
  await switchTo(browser, screen, target);
  await switchTo(browser, screen, "chat");
}

async function swipeTo(browser: Browser, direction: "left" | "right") {
  await browser.evaluate(async (side) => {
    const pager = document.querySelector<HTMLElement>('[data-testid="pager"]');
    if (pager === null) return false;
    const box = pager.getBoundingClientRect();
    const y = box.top + box.height / 2;
    const startX = box.left + box.width * (side === "left" ? 0.8 : 0.2);
    const endX = box.left + box.width * (side === "left" ? 0.2 : 0.8);
    const point = (x: number) =>
      new Touch({ identifier: 61, target: pager, clientX: x, clientY: y });
    const fire = (type: string, x: number) => {
      const touch = point(x);
      pager.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: type === "touchend" ? [] : [touch],
          targetTouches: type === "touchend" ? [] : [touch],
          changedTouches: [touch],
        }),
      );
    };
    fire("touchstart", startX);
    fire("touchmove", startX + (endX - startX) * 0.4);
    fire("touchmove", endX);
    fire("touchend", endX);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return true;
  }, direction);
  await expect
    .poll(() =>
      browser.evaluate(
        () => document.querySelector("[data-testid=pager]")?.getAttribute("data-page") ?? null,
      ),
    )
    .toBe(direction === "left" ? "tasks" : "chat");
  await settleDock(browser);
}

async function openTask(
  browser: Browser,
  screen: Pick<Screen, "getByTestId" | "getByRole">,
  title: string,
) {
  const back = screen.getByTestId("task-detail-back");
  if ((await back.count()) > 0 && (await back.isVisible())) await back.tap();
  await screen.getByRole("button", { name: `Open ${title}` }).tap();
  await expect(screen.getByTestId("task-detail")).toBeVisible();
  await settleDock(browser);
}

for (const device of devices) {
  test(`${device.name}: an attached reader returns to the end after Tasks`, async ({
    app,
    browser,
    screen,
  }) => {
    await openThread(app, browser, screen, device);
    await pinToEnd(browser);
    const before = await readPosition(browser);
    expect(before).not.toBeNull();

    await roundTrip(browser, screen);

    const after = await readPosition(browser);
    expect(after).not.toBeNull();
    expect(after?.distance ?? 99, describe("attached distance", before, after)).toBeLessThanOrEqual(
      1,
    );
    expect(
      Math.abs((after?.lastTop ?? 0) - (before?.lastTop ?? 0)),
      describe("attached last row", before, after),
    ).toBeLessThanOrEqual(1);
  });

  test(`${device.name}: a detached reader keeps the same row at the same offset`, async ({
    app,
    browser,
    screen,
  }) => {
    await openThread(app, browser, screen, device);
    await pinToEnd(browser);
    await detach(browser);
    const before = await readPosition(browser);
    expect(before).not.toBeNull();

    await roundTrip(browser, screen);

    const after = await readPosition(browser);
    expect(after).not.toBeNull();
    expect(
      Math.abs((after?.scrollTop ?? 0) - (before?.scrollTop ?? 0)),
      describe("detached scrollTop", before, after),
    ).toBeLessThanOrEqual(1);
    expect(after?.anchorId, describe("detached anchor id", before, after)).toBe(before?.anchorId);
    expect(
      Math.abs((after?.anchorTop ?? 0) - (before?.anchorTop ?? 0)),
      describe("detached anchor offset", before, after),
    ).toBeLessThanOrEqual(1);
  });

  test(`${device.name}: a dock resize off-screen does not move a detached reader`, async ({
    app,
    browser,
    screen,
  }) => {
    await openThread(app, browser, screen, device);
    await pinToEnd(browser);
    await detach(browser);
    const before = await readPosition(browser);

    // Opening a live task switches the dock to task-chat; a done task collapses it.
    await switchTo(browser, screen, "tasks");
    await openTask(browser, screen, "Live task");
    await switchTo(browser, screen, "chat");
    const afterLive = await readPosition(browser);
    expect(afterLive).not.toBeNull();
    expect(
      Math.abs((afterLive?.scrollTop ?? 0) - (before?.scrollTop ?? 0)),
      describe("task-chat dock scrollTop", before, afterLive),
    ).toBeLessThanOrEqual(1);
    expect(afterLive?.anchorId, describe("task-chat dock anchor", before, afterLive)).toBe(
      before?.anchorId,
    );
    expect(
      Math.abs((afterLive?.anchorTop ?? 0) - (before?.anchorTop ?? 0)),
      describe("task-chat dock offset", before, afterLive),
    ).toBeLessThanOrEqual(1);

    await switchTo(browser, screen, "tasks");
    await openTask(browser, screen, "Finished task");
    await switchTo(browser, screen, "chat");
    const afterDone = await readPosition(browser);
    expect(afterDone).not.toBeNull();
    expect(
      Math.abs((afterDone?.scrollTop ?? 0) - (before?.scrollTop ?? 0)),
      describe("collapsed dock scrollTop", before, afterDone),
    ).toBeLessThanOrEqual(1);
    expect(afterDone?.anchorId, describe("collapsed dock anchor", before, afterDone)).toBe(
      before?.anchorId,
    );
    expect(
      Math.abs((afterDone?.anchorTop ?? 0) - (before?.anchorTop ?? 0)),
      describe("collapsed dock offset", before, afterDone),
    ).toBeLessThanOrEqual(1);
  });

  test(`${device.name}: a near-bottom detached reader keeps its row through Stats`, async ({
    app,
    browser,
    screen,
  }) => {
    await openThread(app, browser, screen, device);
    await pinToEnd(browser);
    await detach(browser, 40);
    const before = await readPosition(browser);
    expect(before).not.toBeNull();

    await roundTrip(browser, screen, "stats");

    const after = await readPosition(browser);
    expect(after).not.toBeNull();
    expect(
      Math.abs((after?.scrollTop ?? 0) - (before?.scrollTop ?? 0)),
      describe("near-bottom stats scrollTop", before, after),
    ).toBeLessThanOrEqual(1);
    expect(after?.anchorId, describe("near-bottom stats anchor", before, after)).toBe(
      before?.anchorId,
    );
    expect(
      Math.abs((after?.anchorTop ?? 0) - (before?.anchorTop ?? 0)),
      describe("near-bottom stats offset", before, after),
    ).toBeLessThanOrEqual(1);
  });

  test(`${device.name}: a near-bottom detached reader keeps its row when the dock collapses`, async ({
    app,
    browser,
    screen,
  }) => {
    await openThread(app, browser, screen, device);
    await pinToEnd(browser);
    await detach(browser, 40);
    const before = await readPosition(browser);
    expect(before).not.toBeNull();

    await switchTo(browser, screen, "tasks");
    await openTask(browser, screen, "Finished task");
    await switchTo(browser, screen, "chat");

    const after = await readPosition(browser);
    expect(after).not.toBeNull();
    expect(
      Math.abs((after?.scrollTop ?? 0) - (before?.scrollTop ?? 0)),
      describe("near-bottom collapsed dock scrollTop", before, after),
    ).toBeLessThanOrEqual(1);
    expect(after?.anchorId, describe("near-bottom collapsed dock anchor", before, after)).toBe(
      before?.anchorId,
    );
    expect(
      Math.abs((after?.anchorTop ?? 0) - (before?.anchorTop ?? 0)),
      describe("near-bottom collapsed dock offset", before, after),
    ).toBeLessThanOrEqual(1);
  });

  test(`${device.name}: messages landing below do not move a detached reader`, async ({
    app,
    browser,
    screen,
  }) => {
    await openThread(app, browser, screen, device);
    await pinToEnd(browser);
    await detach(browser);
    const before = await readPosition(browser);
    expect(before).not.toBeNull();

    await switchTo(browser, screen, "tasks");
    await appendRowsBelow(browser, 5);
    await settleDock(browser);
    await switchTo(browser, screen, "chat");

    const after = await readPosition(browser);
    expect(after).not.toBeNull();
    expect(
      Math.abs((after?.scrollTop ?? 0) - (before?.scrollTop ?? 0)),
      describe("landed rows scrollTop", before, after),
    ).toBeLessThanOrEqual(1);
    expect(after?.anchorId, describe("landed rows anchor", before, after)).toBe(before?.anchorId);
    expect(
      Math.abs((after?.anchorTop ?? 0) - (before?.anchorTop ?? 0)),
      describe("landed rows offset", before, after),
    ).toBeLessThanOrEqual(1);
  });

  test(`${device.name}: three round trips do not drift`, async ({ app, browser, screen }) => {
    await openThread(app, browser, screen, device);
    await pinToEnd(browser);
    await detach(browser);
    const before = await readPosition(browser);

    for (let trip = 0; trip < 3; trip += 1) {
      await roundTrip(browser, screen);
      const after = await readPosition(browser);
      expect(after).not.toBeNull();
      expect(
        Math.abs((after?.scrollTop ?? 0) - (before?.scrollTop ?? 0)),
        describe(`round trip ${trip + 1}`, before, after),
      ).toBeLessThanOrEqual(1);
      expect(after?.anchorId, describe(`round trip ${trip + 1} anchor`, before, after)).toBe(
        before?.anchorId,
      );
    }
  });

  test(`${device.name}: a swipe away and back keeps the reading position`, async ({
    app,
    browser,
    screen,
  }) => {
    await openThread(app, browser, screen, device);
    await pinToEnd(browser);
    const before = await readPosition(browser);

    await swipeTo(browser, "left");
    await swipeTo(browser, "right");

    const after = await readPosition(browser);
    expect(after).not.toBeNull();
    expect(after?.distance ?? 99, describe("swipe distance", before, after)).toBeLessThanOrEqual(1);
    expect(
      Math.abs((after?.lastTop ?? 0) - (before?.lastTop ?? 0)),
      describe("swipe last row", before, after),
    ).toBeLessThanOrEqual(1);
  });
}
