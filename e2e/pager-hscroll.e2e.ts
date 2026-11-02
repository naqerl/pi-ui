import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const longLine = `const value = "${"x".repeat(480)}";`;

const snapshot = {
  conversationId: "pager-hscroll-e2e",
  messages: [
    {
      id: "wide-code",
      role: "assistant",
      text: `Here is a wide block:\n\n\`\`\`ts\n${longLine}\n\`\`\``,
      timestamp: new Date(Date.UTC(2026, 0, 1)).toISOString(),
      order: 1,
    },
  ],
  activity: [],
  run: "idle",
  queue: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
  context: { tokens: 0, window: null, percent: null },
};

test("lets a wide code block keep a horizontal touch gesture", async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: snapshot });
  });
  await app.open("/");
  await expect(screen.getByText("Here is a wide block:", { exact: false })).toBeVisible();

  const result = await browser.evaluate(async () => {
    const pager = document.querySelector("[data-testid=pager]");
    const pre = document.querySelector("main pre");
    const code = pre?.querySelector("code") ?? null;
    if (
      !(pager instanceof HTMLElement) ||
      !(pre instanceof HTMLElement) ||
      !(code instanceof HTMLElement)
    ) {
      return null;
    }
    const blockBox = pre.getBoundingClientRect();
    const y = blockBox.top + blockBox.height / 2;
    const startX = blockBox.right - 40;
    const endX = startX - 96;
    const pageBefore = pager.getAttribute("data-page");

    // Synthetic TouchEvents do not run the browser's default scrolling, so
    // mirror it here. A pager that calls preventDefault would suppress this,
    // exactly as the real browser would.
    let lastX = startX;
    const nativeScroll = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (touch === undefined || event.defaultPrevented) return;
      pre.scrollLeft += lastX - touch.clientX;
      lastX = touch.clientX;
    };
    pre.addEventListener("touchmove", nativeScroll, { passive: true });
    let prevented: boolean = false;
    const fireTouch = (type: string, x: number) => {
      const point = new Touch({ identifier: 3, target: code, clientX: x, clientY: y });
      const event = new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: type === "touchend" ? [] : [point],
        targetTouches: type === "touchend" ? [] : [point],
        changedTouches: [point],
      });
      code.dispatchEvent(event);
      prevented ||= event.defaultPrevented;
    };
    fireTouch("touchstart", startX);
    fireTouch("touchmove", startX - 48);
    fireTouch("touchmove", endX);
    fireTouch("touchend", endX);
    pre.removeEventListener("touchmove", nativeScroll);

    const firePointer = (type: string, x: number) => {
      pre.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 11,
          pointerType: "touch",
          isPrimary: true,
          clientX: x,
          clientY: y,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
        }),
      );
    };
    firePointer("pointerdown", startX);
    firePointer("pointermove", startX - 24);
    firePointer("pointermove", endX);
    firePointer("pointerup", endX);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    return {
      pageBefore,
      pageAfter: pager.getAttribute("data-page"),
      scrollLeft: pre.scrollLeft,
      maxScroll: pre.scrollWidth - pre.clientWidth,
      prevented,
    };
  });

  expect(result).not.toBeNull();
  expect(result?.pageBefore).toBe("chat");
  expect(result?.pageAfter).toBe("chat");
  expect(result?.maxScroll ?? 0).toBeGreaterThan(0);
  expect(result?.scrollLeft ?? 0).toBeGreaterThan(0);
  expect(result?.prevented).toBe(false);

  // At the right edge the pager still stays out for the rest of the gesture:
  // the chosen behaviour is "do nothing", not a hand-off.
  const edge = await browser.evaluate(async () => {
    const pager = document.querySelector("[data-testid=pager]");
    const pre = document.querySelector("main pre");
    if (!(pager instanceof HTMLElement) || !(pre instanceof HTMLElement)) return null;
    const blockBox = pre.getBoundingClientRect();
    const y = blockBox.top + blockBox.height / 2;
    const startX = blockBox.right - 40;
    pre.scrollLeft = pre.scrollWidth;
    const fire = (type: string, x: number) => {
      pre.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 12,
          pointerType: "touch",
          isPrimary: true,
          clientX: x,
          clientY: y,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
        }),
      );
    };
    fire("pointerdown", startX);
    fire("pointermove", startX - 24);
    fire("pointermove", startX - 96);
    fire("pointerup", startX - 96);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return pager.getAttribute("data-page");
  });
  expect(edge).toBe("chat");
});

test("lets a rightward swipe from a code block's left edge page back", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: snapshot });
  });
  await app.open("/");
  await expect(screen.getByText("Here is a wide block:", { exact: false })).toBeVisible();

  const result = await browser.evaluate(async () => {
    const pager = document.querySelector("[data-testid=pager]");
    const pre = document.querySelector("main pre");
    const code = pre?.querySelector("code") ?? null;
    if (
      !(pager instanceof HTMLElement) ||
      !(pre instanceof HTMLElement) ||
      !(code instanceof HTMLElement)
    ) {
      return null;
    }
    const blockBox = pre.getBoundingClientRect();
    const y = blockBox.top + blockBox.height / 2;
    const startX = blockBox.left + 40;
    const endX = startX + 96;
    pre.scrollLeft = 0;

    let lastX = startX;
    const nativeScroll = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (touch === undefined || event.defaultPrevented) return;
      pre.scrollLeft += lastX - touch.clientX;
      lastX = touch.clientX;
    };
    pre.addEventListener("touchmove", nativeScroll, { passive: true });
    let prevented: boolean = false;
    const fireTouch = (type: string, x: number) => {
      const point = new Touch({ identifier: 4, target: code, clientX: x, clientY: y });
      const event = new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        touches: type === "touchend" ? [] : [point],
        targetTouches: type === "touchend" ? [] : [point],
        changedTouches: [point],
      });
      code.dispatchEvent(event);
      prevented ||= event.defaultPrevented;
    };
    fireTouch("touchstart", startX);
    fireTouch("touchmove", startX + 48);
    fireTouch("touchmove", endX);
    fireTouch("touchend", endX);
    pre.removeEventListener("touchmove", nativeScroll);

    const firePointer = (type: string, x: number) => {
      pre.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 14,
          pointerType: "touch",
          isPrimary: true,
          clientX: x,
          clientY: y,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
        }),
      );
    };
    firePointer("pointerdown", startX);
    firePointer("pointermove", startX + 24);
    firePointer("pointermove", endX);
    firePointer("pointerup", endX);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

    return {
      page: pager.getAttribute("data-page"),
      scrollLeft: pre.scrollLeft,
      prevented: Boolean(prevented),
    };
  });

  expect(result?.page).toBe("stats");
  expect(result?.scrollLeft).toBe(0);
  expect(result?.prevented).toBe(true);
});

test("still pages when the same gesture starts over empty chat space", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: snapshot });
  });
  await app.open("/");
  await expect(screen.getByText("Here is a wide block:", { exact: false })).toBeVisible();

  const page = await browser.evaluate(async () => {
    const pager = document.querySelector("[data-testid=pager]");
    const pre = document.querySelector("main pre");
    if (!(pager instanceof HTMLElement) || !(pre instanceof HTMLElement)) return null;
    const box = pager.getBoundingClientRect();
    const blockBox = pre.getBoundingClientRect();
    const startX = box.left + box.width * 0.8;
    const endX = box.left + box.width * 0.2;
    const y = Math.max(box.top + 40, Math.min(box.bottom - 40, blockBox.bottom + 120));
    let target: EventTarget = pager;
    for (let probe = y; probe < box.bottom - 40; probe += 24) {
      const candidate = document.elementFromPoint(box.left + box.width * 0.5, probe);
      if (
        candidate instanceof HTMLElement &&
        pager.contains(candidate) &&
        candidate.closest("pre") === null
      ) {
        target = candidate;
        break;
      }
    }
    const fire = (type: string, x: number) => {
      target.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          composed: true,
          pointerId: 13,
          pointerType: "touch",
          isPrimary: true,
          clientX: x,
          clientY: y,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
        }),
      );
    };
    fire("pointerdown", startX);
    fire("pointermove", startX - 24);
    fire("pointermove", endX);
    fire("pointerup", endX);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return pager.getAttribute("data-page");
  });
  expect(page).toBe("tasks");
});

test("lets a horizontal wheel scroll the block but pages at its left edge", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: snapshot });
  });
  await app.open("/");
  await expect(screen.getByText("Here is a wide block:", { exact: false })).toBeVisible();

  const box = await browser.evaluate(() => {
    const pre = document.querySelector("main pre");
    if (!(pre instanceof HTMLElement)) return null;
    const rect = pre.getBoundingClientRect();
    return { x: rect.left + 40, y: rect.top + rect.height / 2 };
  });
  expect(box).not.toBeNull();
  if (box === null) return;

  await browser.mouse.move(box.x, box.y);
  await browser.mouse.wheel(120, 0);
  await browser.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return true;
  });

  const state = await browser.evaluate(() => {
    const pager = document.querySelector("[data-testid=pager]");
    const pre = document.querySelector("main pre");
    if (!(pager instanceof HTMLElement) || !(pre instanceof HTMLElement)) return null;
    return { page: pager.getAttribute("data-page"), scrollLeft: pre.scrollLeft };
  });
  expect(state?.page).toBe("chat");
  expect(state?.scrollLeft ?? 0).toBeGreaterThan(0);

  await browser.evaluate(() => {
    const pre = document.querySelector("main pre");
    if (pre instanceof HTMLElement) pre.scrollLeft = 0;
    return true;
  });
  await browser.mouse.wheel(-120, 0);
  await browser.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return true;
  });

  const back = await browser.evaluate(() => {
    const pager = document.querySelector("[data-testid=pager]");
    const pre = document.querySelector("main pre");
    if (!(pager instanceof HTMLElement) || !(pre instanceof HTMLElement)) return null;
    return { page: pager.getAttribute("data-page"), scrollLeft: pre.scrollLeft };
  });
  expect(back?.page).toBe("stats");
  expect(back?.scrollLeft).toBe(0);
});
