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
  locked: "undecided" | "h" | "v";
  width: number;
  page: number;
}

/** Chat and tasks share one horizontal pager. Touch swipes; a trackpad scrolls sideways. */
export function usePager(count: number) {
  const [page, setPageState] = useState(0);
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [fine, setFine] = useState(false);
  const pageRef = useRef(0);
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
    const query = window.matchMedia("(hover: hover) and (pointer: fine)");
    const apply = () => setFine(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

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
      locked: "undecided",
      width: event.currentTarget.getBoundingClientRect().width,
      page: pageRef.current,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (current === null || event.pointerId !== current.id) return;
    const dx = event.clientX - current.x;
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
    const dx = event.clientX - current.x;
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
    fine,
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
