import { type Browser, beforeEach, describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

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
