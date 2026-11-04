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

test("jumps between pages with alt+1/2/3 and keeps alt+arrow paging", async ({
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

  const page = async () => {
    await browser.evaluate(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      return true;
    });
    return browser.evaluate(
      () => document.querySelector("[data-testid=pager]")?.getAttribute("data-page") ?? null,
    );
  };

  expect(await page()).toBe("chat");
  await browser.keyboard.press("Alt+1");
  expect(await page()).toBe("stats");
  await browser.keyboard.press("Alt+2");
  expect(await page()).toBe("chat");
  await browser.keyboard.press("Alt+3");
  expect(await page()).toBe("tasks");

  await browser.keyboard.press("Alt+ArrowLeft");
  expect(await page()).toBe("chat");
  await browser.keyboard.press("Alt+ArrowRight");
  expect(await page()).toBe("tasks");
});

test("ctrl+j returns to chat and focuses the end of the draft", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: snapshot });
  });
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  await composer.fill("a draft");
  await browser.keyboard.press("Alt+1");
  await browser.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return true;
  });
  expect(
    await browser.evaluate(
      () => document.querySelector("[data-testid=pager]")?.getAttribute("data-page") ?? null,
    ),
  ).toBe("stats");

  await browser.keyboard.press("Control+j");
  await browser.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return true;
  });
  const result = await browser.evaluate(() => {
    const pager = document.querySelector("[data-testid=pager]");
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
    return {
      page: pager?.getAttribute("data-page") ?? null,
      active: document.activeElement === textarea,
      value: textarea?.value ?? null,
      caret: textarea?.selectionStart ?? null,
      end: textarea?.value.length ?? null,
    };
  });
  expect(result.page).toBe("chat");
  expect(result.active).toBe(true);
  expect(result.value).toBe("a draft");
  expect(result.caret).toBe(result.end);

  // A plain digit is text for the composer, not a page shortcut.
  await browser.keyboard.type("1");
  await browser.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return true;
  });
  const typed = await browser.evaluate(() => {
    const pager = document.querySelector("[data-testid=pager]");
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
    return {
      page: pager?.getAttribute("data-page") ?? null,
      value: textarea?.value ?? null,
    };
  });
  expect(typed.page).toBe("chat");
  expect(typed.value).toBe("a draft1");
});

test("ctrl+j focuses the composer in place on the tasks page", async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: snapshot });
  });
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  await composer.fill("a draft");

  const waitFrames = async () => {
    await browser.evaluate(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      return true;
    });
  };
  const page = () =>
    browser.evaluate(
      () => document.querySelector("[data-testid=pager]")?.getAttribute("data-page") ?? null,
    );

  await browser.keyboard.press("Alt+3");
  await waitFrames();
  expect(await page()).toBe("tasks");

  await browser.keyboard.press("Control+j");
  await waitFrames();
  const tasks = await browser.evaluate(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>(
      '[data-testid="composer-body"] textarea',
    );
    return {
      page: document.querySelector("[data-testid=pager]")?.getAttribute("data-page") ?? null,
      active: document.activeElement === textarea,
      value: textarea?.value ?? null,
      caret: textarea?.selectionStart ?? null,
      end: textarea?.value.length ?? null,
    };
  });
  expect(tasks.page).toBe("tasks");
  expect(tasks.active).toBe(true);
  expect(tasks.value).toBe("a draft");
  expect(tasks.caret).toBe(tasks.end);

  // The stats page keeps the composer mounted but collapsed, so the shortcut
  // still has to page to chat before focusing it there.
  await browser.keyboard.press("Alt+1");
  await waitFrames();
  expect(await page()).toBe("stats");
  await browser.keyboard.press("Control+j");
  await waitFrames();
  const stats = await browser.evaluate(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
    return {
      page: document.querySelector("[data-testid=pager]")?.getAttribute("data-page") ?? null,
      active: document.activeElement === textarea,
      value: textarea?.value ?? null,
      caret: textarea?.selectionStart ?? null,
      end: textarea?.value.length ?? null,
    };
  });
  expect(stats.page).toBe("chat");
  expect(stats.active).toBe(true);
  expect(stats.value).toBe("a draft");
  expect(stats.caret).toBe(stats.end);
});

test("alt+1 uses the digit's physical key when the layout produces a symbol", async ({
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
  const prevented = await browser.evaluate(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
    if (textarea === null) return false;
    const event = new KeyboardEvent("keydown", {
      key: "¡",
      code: "Digit1",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(event);
    return event.defaultPrevented;
  });
  expect(prevented).toBe(true);
  await browser.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return true;
  });
  expect(
    await browser.evaluate(
      () => document.querySelector("[data-testid=pager]")?.getAttribute("data-page") ?? null,
    ),
  ).toBe("stats");
});
