import { type Browser, beforeEach, describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

const longThread = {
  conversationId: "chat-scroller-e2e",
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
async function openChat(
  app: { open: (path: string) => Promise<void> },
  browser: Browser,
  path = "/",
) {
  await browser.addInitScript(() => {
    if (!("serviceWorker" in navigator)) return;
    Object.defineProperty(navigator.serviceWorker, "register", {
      configurable: true,
      value: async () => undefined,
    });
  });
  await app.open(path);
}

async function openLongThread(app: { open: (path: string) => Promise<void> }, browser: Browser) {
  await browser.setViewport({ width: 390, height: 844 });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: longThread });
  });
  await openChat(app, browser);
}

/** Clears the previous member's routes and gives the shared app a desktop viewport. */
async function resetSharedChat(browser: Browser) {
  await browser.unrouteAll();
  await browser.setViewport({ width: 1280, height: 900 });
}

describe("chat message lifecycle against one shared app", { serial: true }, () => {
  beforeEach(async ({ browser }) => {
    await resetSharedChat(browser);
  });

  test("resets the composer to one line with the caret at the start after send", async ({
    app,
    browser,
    screen,
  }) => {
    await openChat(app, browser);
    const composer = screen.getByRole("textbox", "Message");
    const initial = await composer.boundingBox();
    expect(initial).not.toBeNull();

    await composer.fill("hello timeline");
    await screen.getByRole("button", "Send").tap();

    await expect(screen.getByText("hello timeline", { exact: true })).toBeVisible();
    await expect(screen.getByText("Echo: hello timeline", { exact: false })).toBeVisible({
      timeout: 15_000,
    });
    await expect(composer).toHaveValue("");

    const after = await composer.boundingBox();
    expect(after).not.toBeNull();
    expect(after?.height ?? 0).toBeCloseTo(initial?.height ?? 0, 0);
    expect(after?.height ?? 0).toBeLessThanOrEqual(38);

    const state = await browser.evaluate(() => {
      const element = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
      if (element === null) return null;
      return {
        height: element.getBoundingClientRect().height,
        overflowY: getComputedStyle(element).overflowY,
        selectionStart: element.selectionStart,
        selectionEnd: element.selectionEnd,
      };
    });
    expect(state).not.toBeNull();
    expect(state?.overflowY).toBe("hidden");
    expect(state?.selectionStart).toBe(0);
    expect(state?.selectionEnd).toBe(0);
  });

  test("resets a multi-line draft to one line after send", async ({ app, browser, screen }) => {
    await openChat(app, browser);
    const composer = screen.getByRole("textbox", "Message");
    const initial = await composer.boundingBox();
    expect(initial).not.toBeNull();

    await composer.fill("line one\nline two\nline three");
    const expanded = await composer.boundingBox();
    expect(expanded).not.toBeNull();
    expect(expanded?.height ?? 0).toBeGreaterThan(initial?.height ?? 0);

    await screen.getByRole("button", "Send").tap();
    await expect(composer).toHaveValue("");

    const state = await browser.evaluate(() => {
      const element = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
      if (element === null) return null;
      return {
        height: element.getBoundingClientRect().height,
        overflowY: getComputedStyle(element).overflowY,
        scrollTop: element.scrollTop,
        selectionStart: element.selectionStart,
        selectionEnd: element.selectionEnd,
      };
    });
    expect(state).not.toBeNull();
    expect(state?.height ?? 0).toBeLessThanOrEqual(38);
    expect(state?.overflowY).toBe("hidden");
    expect(state?.scrollTop).toBe(0);
    expect(state?.selectionStart).toBe(0);
    expect(state?.selectionEnd).toBe(0);
  });

  test("keeps the draft when a send is rejected", async ({ app, browser, screen }) => {
    await browser.route("**/api/message", async (route) => {
      await route.fulfill({ status: 409, body: "conflict" });
    });
    await openChat(app, browser);
    const composer = screen.getByRole("textbox", "Message");
    await composer.fill("keep this draft\nwith two lines");
    const before = await composer.boundingBox();
    expect(before).not.toBeNull();

    await screen.getByRole("button", "Send").tap();
    await expect(composer).toHaveValue("keep this draft\nwith two lines");
    await expect(browser.locator('[data-pending-send="true"]')).toHaveCount(0);

    const after = await composer.boundingBox();
    expect(after?.height ?? 0).toBeCloseTo(before?.height ?? 0, 0);
  });

  test("paints the pending bubble before the message request returns", async ({
    app,
    browser,
    screen,
  }) => {
    await openChat(app, browser);
    const composer = screen.getByRole("textbox", "Message");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    await browser.route("**/api/message", async (route) => {
      requests += 1;
      // Hold the request open: a client that waits for 202 cannot paint this bubble.
      await gate;
      await route.continue();
    });

    const text = `painted before 202 ${Date.now()}`;
    await composer.fill(text);
    try {
      await screen.getByRole("button", "Send").tap();
      const pending = browser.locator('[data-pending-send="true"]').filter({ hasText: text });
      // Poll instead of one short visibility probe: a busy runner can paint the
      // optimistic bubble a frame late without anything being wrong.
      await expect.poll(() => pending.isVisible(), { timeout: 10_000 }).toBe(true);
      expect(requests).toBe(1);
      // The gate is still closed, so the bubble above was painted before any response.
      await expect(pending).toBeVisible();
    } finally {
      release();
    }

    await expect(screen.getByText(`Echo: ${text}`, { exact: false })).toBeVisible({
      timeout: 15_000,
    });
    await expect(browser.locator('[data-pending-send="true"]')).toHaveCount(0);
    await expect(browser.locator('[data-role="user"]').filter({ hasText: text })).toHaveCount(1);
  });

  test("clears the composer while the pending bubble is still waiting for the server", async ({
    app,
    browser,
    screen,
  }) => {
    await openChat(app, browser);
    const composer = screen.getByRole("textbox", "Message");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await browser.route("**/api/message", async (route) => {
      // Hold the request until this test releases it, so the bubble stays pending
      // while the assertions below run.
      await gate;
      await route.continue();
    });

    const text = `cleared before response ${Date.now()}`;
    await composer.fill(text);
    try {
      await composer.press("Enter");
      const pending = browser.locator('[data-pending-send="true"]').filter({ hasText: text });
      // Poll instead of one short visibility probe: a busy runner can paint the
      // optimistic bubble a frame late without anything being wrong.
      await expect.poll(() => pending.isVisible(), { timeout: 10_000 }).toBe(true);
      await expect(composer).toHaveValue("");
      // The request is still gated, so the bubble above was painted before any response.
      await expect(pending).toBeVisible();
    } finally {
      release();
    }

    await expect(screen.getByText(`Echo: ${text}`, { exact: false })).toBeVisible({
      timeout: 15_000,
    });
    await expect(composer).toHaveValue("");
  });

  test("restores a rejected draft with the caret at the end", async ({ app, browser, screen }) => {
    await browser.route("**/api/message", async (route) => {
      await route.fulfill({ status: 500, body: "send failed" });
    });
    await openChat(app, browser);
    const composer = screen.getByRole("textbox", "Message");
    const text = `restore rejected draft ${Date.now()}`;
    await composer.fill(text);
    await composer.press("Enter");

    await expect(composer).toHaveValue(text);
    await expect(screen.getByTestId("composer-error")).toContainText("send failed");
    await expect(browser.locator('[data-pending-send="true"]')).toHaveCount(0);

    const state = await browser.evaluate(() => {
      const element = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
      if (element === null) return null;
      return {
        length: element.value.length,
        selectionStart: element.selectionStart,
        selectionEnd: element.selectionEnd,
        focused: document.activeElement === element,
      };
    });
    expect(state).not.toBeNull();
    expect(state?.selectionStart).toBe(text.length);
    expect(state?.selectionEnd).toBe(text.length);
    expect(state?.focused).toBe(true);
  });

  test("keeps a new draft when an earlier send fails", async ({ app, browser, screen }) => {
    await openChat(app, browser);
    const composer = screen.getByRole("textbox", "Message");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    await browser.route("**/api/message", async (route) => {
      requests += 1;
      if (requests === 1) {
        await gate;
        await route.fulfill({ status: 500, body: "first send failed" });
        return;
      }
      await route.continue();
    });

    const first = `fails while typing ${Date.now()}`;
    const second = `second draft survives ${Date.now()}`;
    await composer.fill(first);
    try {
      await composer.press("Enter");
      // A busy runner can take longer than one short visibility probe to paint the
      // optimistic bubble; poll visibility so load, not a slow frame, decides.
      const pending = browser.locator('[data-pending-send="true"]').filter({ hasText: first });
      await expect.poll(() => pending.isVisible(), { timeout: 10_000 }).toBe(true);
      await expect(composer).toHaveValue("");

      await composer.fill(second);
    } finally {
      release();
    }

    await expect(screen.getByTestId("composer-error")).toContainText("first send failed");
    await expect(composer).toHaveValue(second);
    await expect(browser.locator('[data-pending-send="true"]')).toHaveCount(0);
    await expect(screen.getByText(first, { exact: true })).toHaveCount(0);
  });
});

// This test patches `window.fetch` for the whole page to hold one response. An
// init script lives for the browser context, so sharing the app would keep
// holding every later send; it keeps its own context and boot.
test("keeps one user bubble when the server places a send before its response returns", async ({
  app,
  browser,
  screen,
}) => {
  // Hold the page's response only after the server has answered, so a snapshot can see the
  // placed entry while the optimistic bubble is still pending. Patching fetch keeps the
  // browser's shard cookie and let us release the response once the snapshot is checked.
  await browser.addInitScript(`
    (() => {
      const original = window.fetch.bind(window);
      let release = null;
      window.__releaseMessageResponse = () => {
        const resume = release;
        release = null;
        window.__messageResponseHeld = false;
        if (resume) resume();
      };
      window.fetch = async (...args) => {
        const response = await original(...args);
        if (String(args[0]).includes("/api/message")) {
          await new Promise((resolve) => {
            release = resolve;
            window.__messageResponseHeld = true;
          });
        }
        return response;
      };
    })();
  `);
  await openChat(app, browser);
  const composer = screen.getByRole("textbox", "Message");
  const text = `placed before response ${Date.now()}`;
  const users = browser.locator('[data-role="user"]').filter({ hasText: text });
  const pending = browser.locator('[data-pending-send="true"]').filter({ hasText: text });
  await composer.fill(text);
  try {
    await screen.getByRole("button", "Send").tap();
    const held = await browser.evaluate(async () => {
      const state = window as unknown as { __messageResponseHeld?: boolean };
      const deadline = performance.now() + 10_000;
      while (state.__messageResponseHeld !== true && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return state.__messageResponseHeld === true;
    });
    expect(held).toBe(true);

    const placed = await browser.evaluate(async (needle: string) => {
      const deadline = performance.now() + 10_000;
      while (performance.now() < deadline) {
        const response = await fetch("/api/state", { cache: "no-store" });
        if (response.ok) {
          const state = (await response.json()) as {
            messages?: { role?: string; text?: string }[];
          };
          if (
            state.messages?.some((message) => message.role === "user" && message.text === needle)
          ) {
            // Force the same snapshot path a tab focus or SSE reconnect uses.
            window.dispatchEvent(new Event("focus"));
            return true;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return false;
    }, text);
    expect(placed).toBe(true);
    // The HTTP response is still held; the snapshot must have retired the optimistic copy.
    await expect(pending).toHaveCount(0, { timeout: 3_000 });
    await expect(users).toHaveCount(1);
  } finally {
    await browser.evaluate(() => {
      (window as unknown as { __releaseMessageResponse?: () => void }).__releaseMessageResponse?.();
      return null;
    });
  }

  await expect(screen.getByText(`Echo: ${text}`, { exact: false })).toBeVisible({
    timeout: 15_000,
  });
  await expect(users).toHaveCount(1);
  await expect(pending).toHaveCount(0);
});

describe("chat layout and gestures against one shared app", { serial: true }, () => {
  beforeEach(async ({ browser }) => {
    await resetSharedChat(browser);
  });

  test("renders assistant markdown without unsafe HTML", async ({ app, browser, screen }) => {
    await openChat(app, browser);
    const composer = screen.getByRole("textbox", "Message");
    await composer.fill("MARKDOWN please");
    await screen.getByRole("button", "Send").tap();

    await expect(screen.getByRole("heading", { name: "Markdown heading", level: 1 })).toBeVisible({
      timeout: 15_000,
    });
    await expect(screen.getByText("bold", { exact: true })).toBeVisible();
    await expect(browser.locator("pre code").filter({ hasText: "const answer = 42;" })).toHaveCount(
      1,
    );
    const link = screen.getByRole("link", "Example");
    await expect(link).toHaveAttribute("href", "https://example.com/docs");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noreferrer noopener");
  });

  test("keeps the composer geometry stable across run start and stop", async ({
    app,
    browser,
    screen,
  }) => {
    await openChat(app, browser);
    const composer = screen.getByRole("textbox", "Message");
    const initial = await composer.boundingBox();
    expect(initial).not.toBeNull();

    await composer.fill("SLOW response please");
    await screen.getByRole("button", "Send").tap();
    await expect(screen.getByRole("button", "Stop")).toBeVisible();

    const running = await composer.boundingBox();
    expect(running).not.toBeNull();
    expect(running?.width ?? 0).toBeCloseTo(initial?.width ?? 0, 0);
    expect(running?.height ?? 0).toBeCloseTo(initial?.height ?? 0, 0);

    await composer.fill("draft while running");
    const typed = await composer.boundingBox();
    expect(typed?.width ?? 0).toBeCloseTo(initial?.width ?? 0, 0);
    await composer.fill("");

    const cleared = await composer.boundingBox();
    expect(cleared?.width ?? 0).toBeCloseTo(initial?.width ?? 0, 0);
    expect(cleared?.height ?? 0).toBeCloseTo(initial?.height ?? 0, 0);

    await screen.getByRole("button", "Stop").tap();
    await expect(screen.getByRole("button", "Send")).toBeVisible();

    const idle = await composer.boundingBox();
    expect(idle?.width ?? 0).toBeCloseTo(initial?.width ?? 0, 0);
    expect(idle?.height ?? 0).toBeCloseTo(initial?.height ?? 0, 0);
  });

  test("does not re-lay-out transcript content while the composer animates", async ({
    app,
    browser,
    screen,
  }) => {
    await browser.emulateMedia({ reducedMotion: "no-preference" });
    await openLongThread(app, browser);
    await expect(screen.getByText("Thread message 71", { exact: false })).toBeVisible();

    const result = await browser.evaluate(async () => {
      const scroller = document.querySelector<HTMLElement>('[data-testid="chat-scroller"]');
      const content = document.querySelector<HTMLElement>('[data-testid="chat-content"]');
      const stats = document.querySelector<HTMLElement>('[data-testid="page-dot-stats"]');
      if (scroller === null || content === null || stats === null) return null;
      scroller.scrollTop = scroller.scrollHeight;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      let contentResizes = 0;
      const observer = new ResizeObserver(() => {
        contentResizes += 1;
      });
      observer.observe(content);
      const contentHeight = content.getBoundingClientRect().height;
      const contentWidth = content.getBoundingClientRect().width;
      stats.click();
      await new Promise((resolve) => setTimeout(resolve, 340));
      observer.disconnect();
      return {
        contentResizes,
        contentHeight,
        afterHeight: content.getBoundingClientRect().height,
        contentWidth,
        afterWidth: content.getBoundingClientRect().width,
      };
    });

    expect(result).not.toBeNull();
    expect(result?.contentResizes ?? 99).toBeLessThanOrEqual(2);
    expect(Math.abs((result?.afterHeight ?? 0) - (result?.contentHeight ?? -1))).toBeLessThan(1);
    expect(Math.abs((result?.afterWidth ?? 0) - (result?.contentWidth ?? -1))).toBeLessThan(1);
  });

  test("pins the last bubble at the bottom while the composer animates and leaves it alone up-thread", async ({
    app,
    browser,
    screen,
  }) => {
    await browser.emulateMedia({ reducedMotion: "no-preference" });
    await openLongThread(app, browser);
    await expect(screen.getByText("Thread message 71", { exact: false })).toBeVisible();

    const pinned = await browser.evaluate(async () => {
      const scroller = document.querySelector<HTMLElement>('[data-testid="chat-scroller"]');
      const stats = document.querySelector<HTMLElement>('[data-testid="page-dot-stats"]');
      const bubbles = [...document.querySelectorAll<HTMLElement>("[data-role]")];
      const last = bubbles.at(-1);
      if (scroller === null || stats === null || last === undefined) return null;
      const nextFrame = () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      scroller.scrollTop = scroller.scrollHeight;
      await nextFrame();
      await nextFrame();

      const samples: number[] = [];
      let running = true;
      const tick = () => {
        const scrollerBox = scroller.getBoundingClientRect();
        const bubbleBox = last.getBoundingClientRect();
        // The transcript keeps its 16px end gap, so measure against that stop.
        samples.push(Math.abs(bubbleBox.bottom - (scrollerBox.bottom - 16)));
        if (running) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      const startedAt = performance.now();
      stats.click();
      await new Promise((resolve) => setTimeout(resolve, 340));
      running = false;
      await nextFrame();
      return {
        max: Math.max(...samples),
        samples: samples.length,
        elapsedMs: performance.now() - startedAt,
      };
    });

    expect(pinned).not.toBeNull();
    // A busy CI runner paints far fewer frames than 60 Hz over the same span, so
    // judge the sampling window by time and require only a handful of frames: the
    // pin assertion below is what actually encodes the behaviour.
    expect(pinned?.elapsedMs ?? 0).toBeGreaterThanOrEqual(330);
    expect(pinned?.samples ?? 0).toBeGreaterThanOrEqual(3);
    expect(pinned?.max ?? 99).toBeLessThanOrEqual(2);

    const detached = await browser.evaluate(async () => {
      const scroller = document.querySelector<HTMLElement>('[data-testid="chat-scroller"]');
      const chat = document.querySelector<HTMLElement>('[data-testid="page-dot-chat"]');
      const stats = document.querySelector<HTMLElement>('[data-testid="page-dot-stats"]');
      const bubbles = [...document.querySelectorAll<HTMLElement>("[data-role]")];
      const last = bubbles.at(-1);
      if (scroller === null || chat === null || stats === null || last === undefined) return null;
      const nextFrame = () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      chat.click();
      await new Promise((resolve) => setTimeout(resolve, 350));
      scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight - 200);
      scroller.dispatchEvent(new Event("scroll"));
      await nextFrame();
      await nextFrame();
      const before = last.getBoundingClientRect().top;
      stats.click();
      await new Promise((resolve) => setTimeout(resolve, 340));
      await nextFrame();
      return { before, after: last.getBoundingClientRect().top };
    });

    expect(detached).not.toBeNull();
    expect(Math.abs((detached?.after ?? 0) - (detached?.before ?? -1))).toBeLessThanOrEqual(2);
  });

  test("turns the pager from a horizontal swipe started inside the thread", async ({
    app,
    browser,
    screen,
  }) => {
    await openLongThread(app, browser);
    await expect(screen.getByText("Thread message 71", { exact: false })).toBeVisible();

    const result = await browser.evaluate(async () => {
      const pager = document.querySelector<HTMLElement>('[data-testid="pager"]');
      const scroller = document.querySelector<HTMLElement>('[data-testid="chat-scroller"]');
      const chat = document.querySelector<HTMLElement>('[data-testid="page-dot-chat"]');
      const bubbles = [...document.querySelectorAll<HTMLElement>("[data-role]")];
      const last = bubbles.at(-1);
      if (pager === null || scroller === null || chat === null || last === undefined) return null;
      chat.click();
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      const before = pager.getAttribute("data-page");
      scroller.scrollTop = scroller.scrollHeight;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const box = last.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const fire = (type: string, clientX: number) => {
        last.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: 21,
            pointerType: "touch",
            isPrimary: true,
            clientX,
            clientY: y,
            button: 0,
            buttons: type === "pointerup" ? 0 : 1,
          }),
        );
      };
      fire("pointerdown", x);
      fire("pointermove", x - 96);
      fire("pointerup", x - 96);
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      return {
        before,
        page: pager.getAttribute("data-page"),
        touchAction: getComputedStyle(scroller).touchAction,
      };
    });

    expect(result).not.toBeNull();
    expect(result?.before).toBe("chat");
    expect(result?.touchAction).toBe("pan-y");
    expect(result?.page).toBe("tasks");
  });

  test("paints the queued steer chip before the steer request returns", async ({
    app,
    browser,
    screen,
  }) => {
    // The pager member before this one mocked `**/api/state**`; a serial group
    // keeps that route, so shadow it with the real backend for this member.
    await browser.route("**/api/state**", async (route) => {
      await route.continue();
    });
    await openChat(app, browser);
    const composer = screen.getByRole("textbox", "Message");
    await composer.fill("SLOW response please");
    await screen.getByRole("button", "Send").tap();
    await expect(screen.getByRole("button", "Stop")).toBeVisible();

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    await browser.route("**/api/message", async (route) => {
      const body = JSON.parse(route.request.postData ?? "{}") as { mode?: string };
      if (body.mode !== "steer") {
        await route.continue();
        return;
      }
      requests += 1;
      await gate;
      await route.continue();
    });

    const text = `steer painted before response ${Date.now()}`;
    await composer.fill(text);
    try {
      await screen.getByRole("button", "Steer").tap();
      const pending = browser.locator('[data-pending-steer="true"]').filter({ hasText: text });
      // Poll instead of one short visibility probe: a busy runner can paint the
      // optimistic bubble a frame late without anything being wrong.
      await expect.poll(() => pending.isVisible(), { timeout: 10_000 }).toBe(true);
      expect(requests).toBe(1);
      // The gate is still closed, so the chip above was painted before the response.
      await expect(pending).toBeVisible();
    } finally {
      release();
    }
    await expect(composer).toHaveValue("");
    const stop = screen.getByRole("button", "Stop");
    if ((await stop.count()) > 0) await stop.tap();
  });
});

// This test samples animation frames against a 24 ms budget. It keeps its own
// fresh app: a warm shared context can paint before the lazy ShaderBackground
// mounts, and the sample would then include the shader's 30 fps cap.
test("keeps every frame inside the budget while the composer body animates", async ({
  app,
  browser,
  screen,
}) => {
  await browser.emulateMedia({ reducedMotion: "no-preference" });
  await openLongThread(app, browser);
  await expect(screen.getByText("Thread message 71", { exact: false })).toBeVisible();

  // Warm the stats chunk and settle on the collapsed composer so the sample measures
  // only the expansion, not the first mount of the stats page.
  await screen.getByRole("tab", "Stats").tap();
  await screen.getByRole("tab", "Chat").tap();
  await expect(screen.getByText("Thread message 71", { exact: false })).toBeVisible();
  await screen.getByRole("tab", "Stats").tap();
  await new Promise((resolve) => setTimeout(resolve, 450));

  const result = await browser.evaluate(async () => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="chat-scroller"]');
    const body = document.querySelector<HTMLElement>('[data-testid="composer-body"]');
    const chat = document.querySelector<HTMLElement>('[data-testid="page-dot-chat"]');
    if (scroller === null || body === null || chat === null) return null;
    const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    // The drifting shader is not part of this transition; its normal-motion paint
    // would otherwise cap the software-rendered bot at 30 fps. The background is
    // lazy, so wait for it instead of sampling one frame that may predate it.
    let shader = document.querySelector<HTMLElement>('[data-testid="shader-bg"]');
    const shaderDeadline = performance.now() + 5_000;
    while (shader === null && performance.now() < shaderDeadline) {
      await nextFrame();
      shader = document.querySelector<HTMLElement>('[data-testid="shader-bg"]');
    }
    if (shader !== null) shader.style.display = "none";
    scroller.scrollTop = scroller.scrollHeight;
    await nextFrame();
    await nextFrame();

    const frames: number[] = [];
    let running = true;
    let previous = 0;
    let first = true;
    const tick = (time: number) => {
      if (first) {
        first = false;
        previous = time;
      } else {
        frames.push(time - previous);
        previous = time;
      }
      if (running) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const start = body.getBoundingClientRect().height;
    chat.click();
    await new Promise((resolve) => setTimeout(resolve, 340));
    running = false;
    await nextFrame();
    return {
      frames,
      start,
      end: body.getBoundingClientRect().height,
      collapsed: body.getAttribute("data-collapsed"),
    };
  });

  expect(result).not.toBeNull();
  expect(result?.collapsed).toBe("false");
  expect(result?.end ?? 0).toBeGreaterThan((result?.start ?? 0) + 20);
  expect((result?.frames.length ?? 0) > 6).toBe(true);
  expect(Math.max(...(result?.frames ?? [0]))).toBeLessThanOrEqual(24);
});
