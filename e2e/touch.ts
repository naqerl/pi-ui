import type { Browser } from "@e2e-dev/web";

export type SwipeOptions = {
  /** CSS selector for the element whose box starts the gesture. */
  target: string;
  dx: number;
  dy?: number;
  /** Dispatch the pointer events a real touch also produces, to exercise the pager echo guard. */
  pointerEcho?: boolean;
  /** Horizontal scroller whose native pan this synthetic touch emulates. */
  horizontal?: string;
  /** Vertical scroller whose native pan this synthetic touch emulates. */
  vertical?: string;
  /** Start on the painted part of a clipped target instead of its raw box. */
  visible?: boolean;
};

export type SwipeResult = {
  pageBefore: string | null;
  page: string | null;
  prevented: boolean;
  horizontalBefore: number | null;
  horizontal: number | null;
  verticalBefore: number | null;
  vertical: number | null;
};

/**
 * Expose the touch capability a phone has. The web engine has no
 * context-level hasTouch option, so product code reads these instead.
 */
export async function enableTouch(browser: Browser) {
  await browser.addInitScript(() => {
    Object.defineProperty(navigator, "maxTouchPoints", { configurable: true, value: 5 });
    Object.defineProperty(window, "ontouchstart", { configurable: true, value: null });
  });
}

/**
 * Dispatch a synthetic touch gesture at a selector. Chromium does not run its
 * native pan for an untrusted event, so the named scrollers are advanced the
 * way the browser would when a handler did not preventDefault.
 */
export async function swipe(browser: Browser, options: SwipeOptions): Promise<SwipeResult | null> {
  return browser.evaluate(async (input) => {
    const pager = document.querySelector<HTMLElement>('[data-testid="pager"]');
    const target = document.querySelector<HTMLElement>(input.target);
    const horizontal =
      input.horizontal === undefined ? null : document.querySelector<HTMLElement>(input.horizontal);
    const vertical =
      input.vertical === undefined ? null : document.querySelector<HTMLElement>(input.vertical);
    if (target === null) return null;

    const box = target.getBoundingClientRect();
    const visibleLeft = Math.max(box.left, 0);
    const visibleRight = Math.min(box.right, window.innerWidth);
    const startX =
      input.visible === true
        ? visibleLeft + (visibleRight - visibleLeft) * 0.6
        : box.left + box.width * 0.6;
    const startY = box.top + Math.min(28, box.height / 2);
    const hit = input.visible === true ? document.elementFromPoint(startX, startY) : null;
    const touchTarget = hit instanceof Element && target.contains(hit) ? hit : target;
    const dx = input.dx;
    const dy = input.dy ?? 0;

    const touchAt = (x: number, y: number) =>
      new Touch({ identifier: 71, target: touchTarget, clientX: x, clientY: y });
    const fire = (type: string, x: number, y: number) => {
      const touch = touchAt(x, y);
      const event = new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        touches: type === "touchend" ? [] : [touch],
        targetTouches: type === "touchend" ? [] : [touch],
        changedTouches: [touch],
      });
      touchTarget.dispatchEvent(event);
      return event;
    };

    let lastX = startX;
    let lastY = startY;
    const nativePan = (event: TouchEvent) => {
      if (event.defaultPrevented) return;
      const touch = event.touches[0];
      if (touch === undefined) return;
      if (horizontal !== null) horizontal.scrollLeft += lastX - touch.clientX;
      if (vertical !== null) vertical.scrollTop += lastY - touch.clientY;
      lastX = touch.clientX;
      lastY = touch.clientY;
    };
    document.addEventListener("touchmove", nativePan, { passive: true });

    const horizontalBefore = horizontal?.scrollLeft ?? null;
    const verticalBefore = vertical?.scrollTop ?? null;
    const pageBefore = pager?.getAttribute("data-page") ?? null;
    let prevented = false;
    const send = (type: string, x: number, y: number) => {
      const event = fire(type, x, y);
      prevented ||= event.defaultPrevented;
    };

    send("touchstart", startX, startY);
    send("touchmove", startX + dx / 2, startY + dy / 2);
    send("touchmove", startX + dx, startY + dy);
    send("touchend", startX + dx, startY + dy);

    if (input.pointerEcho === true) {
      const sendPointer = (type: string, x: number, y: number) => {
        touchTarget.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: 72,
            pointerType: "touch",
            isPrimary: true,
            clientX: x,
            clientY: y,
            button: 0,
            buttons: type === "pointerup" ? 0 : 1,
          }),
        );
      };
      sendPointer("pointerdown", startX, startY);
      sendPointer("pointermove", startX + dx / 2, startY + dy / 2);
      sendPointer("pointermove", startX + dx, startY + dy);
      sendPointer("pointerup", startX + dx, startY + dy);
    }

    document.removeEventListener("touchmove", nativePan);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return {
      pageBefore,
      page: pager?.getAttribute("data-page") ?? null,
      prevented,
      horizontalBefore,
      horizontal: horizontal?.scrollLeft ?? null,
      verticalBefore,
      vertical: vertical?.scrollTop ?? null,
    };
  }, options);
}
