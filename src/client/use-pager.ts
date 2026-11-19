import {
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

interface Gesture {
  id: number;
  x: number;
  y: number;
  lastX: number;
  locked: "undecided" | "h" | "v" | "none";
  scroller: HTMLElement | null;
  surface: HTMLElement | null;
  width: number;
  page: number;
}

export interface ScrollBox {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
}

export type GestureOwner = "scroller" | "surface" | "pager";

export interface PagerOptions {
  nested?: boolean;
  keyboard?: boolean;
  yieldAtEdge?: boolean;
}

const SURFACE_SELECTOR = "[data-swipe-surface]";

export function swipeCanAttribute(page: number, count: number): string {
  const can: string[] = [];
  if (page > 0) can.push("prev");
  if (page < count - 1) can.push("next");
  return can.join(" ");
}

function isHorizontalScroller(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false;
  const hint = element.getAttribute("data-hscroll");
  if (hint === "false") return false;
  if (hint !== null) return true;
  const overflowX = getComputedStyle(element).overflowX;
  return (
    (overflowX === "auto" || overflowX === "scroll") &&
    element.scrollWidth > element.clientWidth + 2
  );
}

function horizontalScroller(target: EventTarget | null, root: HTMLElement): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  let node: Element | null = target;
  while (node !== null && node !== root) {
    if (isHorizontalScroller(node)) return node as HTMLElement;
    node = node.parentElement;
  }
  return null;
}

function nearestSurface(target: EventTarget | null, root: HTMLElement): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const surface = target.closest<HTMLElement>(SURFACE_SELECTOR);
  if (surface === null || surface === root || !root.contains(surface)) return null;
  return surface;
}

export function surfaceCanMove(surface: HTMLElement, direction: 1 | -1): boolean {
  const can = surface.getAttribute("data-swipe-can") ?? "";
  return can.split(" ").includes(direction === 1 ? "next" : "prev");
}

function scrollerBox(element: HTMLElement): ScrollBox & { hscroll: boolean } {
  return {
    scrollLeft: element.scrollLeft,
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    hscroll: element.getAttribute("data-hscroll") !== null,
  };
}

function surfaceState(surface: HTMLElement | null): { canPrev: boolean; canNext: boolean } | null {
  if (surface === null) return null;
  return { canPrev: surfaceCanMove(surface, -1), canNext: surfaceCanMove(surface, 1) };
}

function pageCanMove(page: number, count: number, direction: 1 | -1): boolean {
  return swipeCanAttribute(page, count)
    .split(" ")
    .includes(direction === 1 ? "next" : "prev");
}

export function scrollerCanPan(box: ScrollBox, hscroll: boolean, direction: 1 | -1): boolean {
  if (hscroll) return true;
  if (direction === 1) {
    return box.scrollLeft + box.clientWidth < box.scrollWidth - 1;
  }
  return box.scrollLeft > 0;
}

export function gestureOwner(input: {
  scroller: (ScrollBox & { hscroll: boolean }) | null;
  surface: { canPrev: boolean; canNext: boolean } | null;
  direction: 1 | -1;
}): GestureOwner {
  const scroller = input.scroller;
  if (scroller !== null && scrollerCanPan(scroller, scroller.hscroll, input.direction)) {
    return "scroller";
  }
  const surface = input.surface;
  if (surface !== null && (input.direction === 1 ? surface.canNext : surface.canPrev)) {
    return "surface";
  }
  return "pager";
}

function defersToScroller(element: HTMLElement, direction: 1 | -1): boolean {
  return scrollerCanPan(element, element.getAttribute("data-hscroll") !== null, direction);
}

function lockedByChild(node: HTMLElement): boolean {
  return node.querySelector("[data-pager-lock]") !== null;
}

export function usePager(count: number, initial = 0, options: PagerOptions = {}) {
  const { nested = false, keyboard = true, yieldAtEdge = false } = options;
  const yieldsAtEdge = nested || yieldAtEdge;
  const start = Math.max(0, Math.min(count - 1, initial));
  const [page, setPageState] = useState(start);
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const pageRef = useRef(start);
  const gesture = useRef<Gesture | null>(null);
  const ignorePointerUntil = useRef(0);
  const suppressClick = useRef(false);
  const pagerRef = useRef<HTMLDivElement>(null);

  const setPage = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(count - 1, next));
      pageRef.current = clamped;
      setPageState(clamped);
      setDragX(0);
      setDragging(false);
    },
    [count],
  );

  useEffect(() => {
    if (!keyboard) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        setPage(pageRef.current + (event.key === "ArrowRight" ? 1 : -1));
        return;
      }
      const match = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
      const digit = match?.[1] ?? (/^[1-9]$/.test(event.key) ? event.key : null);
      if (digit === null) return;
      const index = Number(digit) - 1;
      if (index >= count) return;
      event.preventDefault();
      setPage(index);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [count, setPage, keyboard]);

  useEffect(() => {
    const node = pagerRef.current;
    if (node === null) return;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let width = 1;
    let startPage = 0;
    let mode: "undecided" | "h" | "v" = "undecided";
    let scroller: HTMLElement | null = null;
    let surface: HTMLElement | null = null;
    let claimed: "pager" | null = null;
    let tracking = false;

    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        tracking = false;
        return;
      }
      const touch = event.touches[0];
      if (touch === undefined) return;
      gesture.current = null;
      setDragging(false);
      setDragX(0);
      if (lockedByChild(node)) {
        tracking = false;
        return;
      }
      scroller = horizontalScroller(event.target, node);
      surface = nearestSurface(event.target, node);
      startX = touch.clientX;
      startY = touch.clientY;
      lastX = touch.clientX;
      width = node.getBoundingClientRect().width || 1;
      startPage = pageRef.current;
      mode = "undecided";
      claimed = null;
      tracking = true;
    };
    const onMove = (event: TouchEvent) => {
      if (!tracking || event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (touch === undefined) return;
      if (lockedByChild(node)) {
        if (event.cancelable) event.preventDefault();
        tracking = false;
        setDragging(false);
        setDragX(0);
        return;
      }
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      lastX = touch.clientX;
      if (mode === "undecided") {
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        mode = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
      }
      if (mode !== "h") return;
      if (claimed === null) {
        const direction: 1 | -1 = dx > 0 ? -1 : 1;
        const owner = gestureOwner({
          scroller: scroller === null ? null : scrollerBox(scroller),
          surface: surfaceState(surface),
          direction,
        });
        if (owner === "scroller") {
          tracking = false;
          return;
        }
        if (owner === "surface") {
          tracking = false;
          setDragging(false);
          setDragX(0);
          return;
        }
        if (yieldsAtEdge && !pageCanMove(startPage, count, direction)) {
          tracking = false;
          setDragging(false);
          setDragX(0);
          return;
        }
        claimed = "pager";
      }
      if (!event.cancelable) {
        tracking = false;
        setDragging(false);
        setDragX(0);
        return;
      }
      event.preventDefault();
      let next = dx;
      const atStart = startPage === 0 && next > 0;
      const atEnd = startPage === count - 1 && next < 0;
      if (atStart || atEnd) next *= 0.35;
      setDragging(true);
      setDragX(next);
    };
    const onEnd = () => {
      ignorePointerUntil.current = performance.now() + 250;
      if (!tracking) {
        setDragging(false);
        setDragX(0);
        return;
      }
      tracking = false;
      if (mode !== "h") {
        setDragging(false);
        setDragX(0);
        return;
      }
      const dx = lastX - startX;
      const threshold = Math.min(72, width * 0.18);
      let next = startPage;
      if (dx <= -threshold) next += 1;
      else if (dx >= threshold) next -= 1;
      setPage(next);
    };
    const onCancel = () => {
      ignorePointerUntil.current = performance.now() + 250;
      tracking = false;
      setPage(pageRef.current);
    };

    node.addEventListener("touchstart", onStart, { capture: true, passive: true });
    node.addEventListener("touchmove", onMove, { capture: true, passive: false });
    node.addEventListener("touchend", onEnd, { capture: true });
    node.addEventListener("touchcancel", onCancel, { capture: true });
    return () => {
      node.removeEventListener("touchstart", onStart, { capture: true });
      node.removeEventListener("touchmove", onMove, { capture: true });
      node.removeEventListener("touchend", onEnd, { capture: true });
      node.removeEventListener("touchcancel", onCancel, { capture: true });
    };
  }, [count, setPage, yieldsAtEdge]);

  useEffect(() => {
    const node = pagerRef.current;
    if (node === null) return;
    let lockedUntil = 0;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) < 24) return;
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      const direction: 1 | -1 = event.deltaX > 0 ? 1 : -1;
      const scroller = horizontalScroller(event.target, node);
      if (scroller !== null && defersToScroller(scroller, direction)) return;
      const surface = nearestSurface(event.target, node);
      if (surface !== null && surfaceCanMove(surface, direction)) return;
      if (yieldsAtEdge && !pageCanMove(pageRef.current, count, direction)) return;
      event.preventDefault();
      const now = performance.now();
      if (now < lockedUntil) return;
      lockedUntil = now + 450;
      setPage(pageRef.current + (event.deltaX > 0 ? 1 : -1));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [setPage, count, yieldsAtEdge]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch" || event.button !== 0) return;
    if (performance.now() < ignorePointerUntil.current) return;
    if (lockedByChild(event.currentTarget)) return;
    gesture.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      lastX: event.clientX,
      locked: "undecided",
      scroller: horizontalScroller(event.target, event.currentTarget),
      surface: nearestSurface(event.target, event.currentTarget),
      width: event.currentTarget.getBoundingClientRect().width,
      page: pageRef.current,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (current === null || event.pointerId !== current.id) return;
    if (lockedByChild(event.currentTarget)) {
      gesture.current = null;
      setDragging(false);
      setDragX(0);
      return;
    }
    current.lastX = event.clientX;
    const dx = current.lastX - current.x;
    const dy = event.clientY - current.y;
    if (current.locked === "undecided") {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        current.locked = "v";
        return;
      }
      const direction: 1 | -1 = dx > 0 ? -1 : 1;
      const owner = gestureOwner({
        scroller: current.scroller === null ? null : scrollerBox(current.scroller),
        surface: surfaceState(current.surface),
        direction,
      });
      if (owner !== "pager") {
        current.locked = "none";
        return;
      }
      if (yieldsAtEdge && !pageCanMove(current.page, count, direction)) {
        current.locked = "none";
        return;
      }
      current.locked = "h";
      setDragging(true);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {}
    }
    if (current.locked !== "h") return;
    let next = dx;
    const atStart = current.page === 0 && next > 0;
    const atEnd = current.page === count - 1 && next < 0;
    if (atStart || atEnd) next *= 0.35;
    setDragX(next);
  };

  const finish = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (current === null || event.pointerId !== current.id) return;
    gesture.current = null;
    if (lockedByChild(event.currentTarget)) {
      setDragging(false);
      setDragX(0);
      return;
    }
    if (current.locked !== "h") {
      setDragging(false);
      setDragX(0);
      return;
    }
    const dx = current.lastX - current.x;
    if (Math.abs(dx) > 8) suppressClick.current = true;
    const threshold = Math.min(72, current.width * 0.18);
    let next = current.page;
    if (dx <= -threshold) next += 1;
    else if (dx >= threshold) next -= 1;
    setPage(next);
  };

  const onClickCapture = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  return {
    page,
    setPage,
    dragging,
    dragX,
    pagerRef,
    pagerProps: {
      ref: pagerRef,
      ...(nested
        ? { "data-swipe-surface": "", "data-swipe-can": swipeCanAttribute(page, count) }
        : {}),
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: finish,
      onClickCapture,
    },
  };
}
