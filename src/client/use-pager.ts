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
  locked: "undecided" | "h" | "v";
  width: number;
  page: number;
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
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (!event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      event.preventDefault();
      setPage(pageRef.current + (event.key === "ArrowRight" ? 1 : -1));
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [setPage]);

  useEffect(() => {
    const node = pagerRef.current;
    if (node === null) return;
    let startX = 0;
    let startY = 0;
    let mode: "undecided" | "h" | "v" = "undecided";
    let tracking = false;

    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        tracking = false;
        return;
      }
      const touch = event.touches[0];
      if (touch === undefined) return;
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
      if (mode === "h" && event.cancelable) event.preventDefault();
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
