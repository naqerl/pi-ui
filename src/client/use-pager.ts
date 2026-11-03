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
  /** Last finger position. A cancelled touch can report clientX 0. */
  lastX: number;
  locked: "undecided" | "h" | "v" | "none";
  scroller: HTMLElement | null;
  width: number;
  page: number;
}

/**
 * A horizontal scroller is detected from behaviour, not from a class list. The
 * optional `data-hscroll` attribute is only a hint for custom scroll surfaces:
 * any value other than `false` marks one, while `false` opts an element out.
 */
function isHorizontalScroller(element: Element): boolean {
  if (!(element instanceof HTMLElement)) return false;
  const hint = element.getAttribute("data-hscroll");
  if (hint === "false") return false;
  if (hint !== null) return true;
  const overflowX = getComputedStyle(element).overflowX;
  return (
    (overflowX === "auto" || overflowX === "scroll") && element.scrollWidth > element.clientWidth
  );
}

/**
 * The nearest horizontally scrollable element between a gesture's origin and
 * the pager. The direction is decided on the first horizontal move, because
 * the same scroller may own one direction and not the other.
 */
function horizontalScroller(target: EventTarget | null, root: HTMLElement): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  let node: Element | null = target;
  while (node !== null && node !== root) {
    if (isHorizontalScroller(node)) return node as HTMLElement;
    node = node.parentElement;
  }
  return null;
}

/**
 * Whether the scroller owns a horizontal gesture. `direction` is 1 when the
 * finger moves left (the content scrolls right) and -1 when it moves right. A
 * scroller keeps the gesture while it can still move that way. At its right
 * edge it also keeps the rest of the gesture (no hand-off); at its left edge a
 * rightward gesture belongs to the pager because the scroller cannot consume
 * it. Custom pan surfaces marked with `data-hscroll` always keep the gesture.
 */
function defersToScroller(element: HTMLElement, direction: 1 | -1): boolean {
  if (element.getAttribute("data-hscroll") !== null) return true;
  if (direction === 1) return true;
  return element.scrollLeft > 0;
}

/** Stats, chat, and tasks share one horizontal pager. Touch swipes; a trackpad scrolls sideways. */
export function usePager(count: number, initial = 0) {
  const start = Math.max(0, Math.min(count - 1, initial));
  const [page, setPageState] = useState(start);
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const pageRef = useRef(start);
  const gesture = useRef<Gesture | null>(null);
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
    const onKey = (event: KeyboardEvent) => {
      // IME candidate keys are text, not shortcuts.
      if (event.isComposing) return;
      if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        setPage(pageRef.current + (event.key === "ArrowRight" ? 1 : -1));
        return;
      }
      // Use the physical digit so Alt+1 still pages when the layout makes the
      // character "¡" (macOS and latin-american layouts).
      const match = /^(?:Digit|Numpad)([1-9])$/.exec(event.code);
      const digit = match?.[1] ?? (/^[1-9]$/.test(event.key) ? event.key : null);
      if (digit === null) return;
      const index = Number(digit) - 1;
      if (index >= count) return;
      // preventDefault first: this key must never reach a focused composer.
      event.preventDefault();
      setPage(index);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [count, setPage]);

  useEffect(() => {
    const node = pagerRef.current;
    if (node === null) return;
    let startX = 0;
    let startY = 0;
    let mode: "undecided" | "h" | "v" = "undecided";
    let scroller: HTMLElement | null = null;
    let tracking = false;

    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        tracking = false;
        return;
      }
      const touch = event.touches[0];
      if (touch === undefined) return;
      // Resolve the target now, but decide on the first move whether it can
      // consume the gesture's direction.
      scroller = horizontalScroller(event.target, node);
      startX = touch.clientX;
      startY = touch.clientY;
      mode = "undecided";
      tracking = true;
    };
    // Rightward movement is the browser's back gesture. preventDefault keeps
    // that swipe on the pager so it can return from tasks to chat.
    const onMove = (event: TouchEvent) => {
      if (!tracking || event.touches.length !== 1) return;
      const touch = event.touches[0];
      if (touch === undefined) return;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (mode === "undecided") {
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        mode = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
      }
      if (mode !== "h" || !event.cancelable) return;
      if (scroller !== null) {
        if (defersToScroller(scroller, dx > 0 ? -1 : 1)) {
          // Leave preventDefault off so the element's native panning works.
          tracking = false;
          return;
        }
        // The pager has claimed this gesture, so keep claiming it even if the
        // finger reverses direction.
        scroller = null;
      }
      event.preventDefault();
    };

    node.addEventListener("touchstart", onStart, { capture: true, passive: true });
    node.addEventListener("touchmove", onMove, { capture: true, passive: false });
    return () => {
      node.removeEventListener("touchstart", onStart, { capture: true });
      node.removeEventListener("touchmove", onMove, { capture: true });
    };
  }, []);

  useEffect(() => {
    const node = pagerRef.current;
    if (node === null) return;
    let lockedUntil = 0;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) < 24) return;
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      // A horizontal trackpad gesture over a wide block scrolls the block
      // while it can still move that way. At the block's left edge a further
      // negative delta belongs to the pager.
      const scroller = horizontalScroller(event.target, node);
      if (scroller !== null && defersToScroller(scroller, event.deltaX > 0 ? 1 : -1)) return;
      event.preventDefault();
      const now = performance.now();
      if (now < lockedUntil) return;
      lockedUntil = now + 450;
      setPage(pageRef.current + (event.deltaX > 0 ? 1 : -1));
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [setPage]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch" || event.button !== 0) return;
    gesture.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      lastX: event.clientX,
      locked: "undecided",
      scroller: horizontalScroller(event.target, event.currentTarget),
      width: event.currentTarget.getBoundingClientRect().width,
      page: pageRef.current,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (current === null || event.pointerId !== current.id) return;
    current.lastX = event.clientX;
    const dx = current.lastX - current.x;
    const dy = event.clientY - current.y;
    if (current.locked === "undecided") {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        current.locked = "v";
        return;
      }
      if (current.scroller !== null && defersToScroller(current.scroller, dx > 0 ? -1 : 1)) {
        current.locked = "none";
        return;
      }
      current.locked = "h";
      setDragging(true);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Synthetic pointers in tests cannot be captured.
      }
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
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: finish,
      onClickCapture,
    },
  };
}
