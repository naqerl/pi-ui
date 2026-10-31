import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  clampZoom,
  type DiagramView,
  diagramDownloadName,
  fitScale,
  fitView,
  MAX_ZOOM,
  MIN_ZOOM,
  zoomAt,
} from "./diagram-viewer";

const TOOLBAR_BUTTON =
  "theme-radius min-h-8 border border-foreground/15 bg-background px-2.5 py-1 font-mono text-[11px] leading-4 text-foreground hover:bg-foreground/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground/40 disabled:opacity-40";

interface Point {
  x: number;
  y: number;
}

interface Drag {
  pointerId: number;
  start: Point;
  view: DiagramView;
  moved: boolean;
}

interface Pinch {
  distance: number;
  midpoint: Point;
  view: DiagramView;
}

interface DiagramViewerProps {
  id: string;
  revision: number;
  source: string;
  svg: string;
  onClose: () => void;
}

/** Pele writes width and height attributes; the viewBox keeps them exact for the transform. */
function svgSize(svg: string): { width: number; height: number } {
  try {
    const document = new DOMParser().parseFromString(svg, "image/svg+xml");
    const root = document.documentElement;
    if (root.tagName.toLowerCase() === "parsererror") return { width: 1, height: 1 };
    const box = root
      .getAttribute("viewBox")
      ?.trim()
      .split(/[\s,]+/)
      .map(Number);
    if (
      box !== undefined &&
      box.length === 4 &&
      box.every((value) => Number.isFinite(value)) &&
      box[2] > 0 &&
      box[3] > 0
    ) {
      return { width: box[2], height: box[3] };
    }
    const width = Number.parseFloat(root.getAttribute("width") ?? "");
    const height = Number.parseFloat(root.getAttribute("height") ?? "");
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
      return { width, height };
    }
  } catch {
    // A malformed SVG still gets a viewer; the drawing itself explains the parse failure.
  }
  return { width: 1, height: 1 };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

function SvgMarkup({ svg }: { svg: string }) {
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: pele escapes diagram text and filters links and styles.
    <div className="diagram-svg h-full w-full" dangerouslySetInnerHTML={{ __html: svg }} />
  );
}

/**
 * The full-screen drawing. It keeps the SVG (not a bitmap) so text stays crisp, and turns
 * pointer, wheel and double-tap input into a transform without touching the transcript.
 */
export function DiagramViewer({ id, revision, source, svg, onClose }: DiagramViewerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const contentSize = useMemo(() => svgSize(svg), [svg]);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<DiagramView>({ zoom: 1, x: 0, y: 0 });
  const [copied, setCopied] = useState(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const pointersRef = useRef(new Map<number, Point>());
  const dragRef = useRef<Drag | null>(null);
  const pinchRef = useRef<Pinch | null>(null);
  const lastTapRef = useRef<{ time: number; point: Point } | null>(null);
  const copyTimerRef = useRef<number | null>(null);

  const fitted = fitScale(viewport.width, viewport.height, contentSize.width, contentSize.height);

  const reset = useCallback(() => {
    const next = fitView(viewport.width, viewport.height, contentSize.width, contentSize.height);
    setView({ zoom: next.zoom, x: next.x, y: next.y });
  }, [contentSize.height, contentSize.width, viewport.height, viewport.width]);

  const localPoint = useCallback((event: { clientX: number; clientY: number }): Point => {
    const stage = stageRef.current;
    if (stage === null) return { x: event.clientX, y: event.clientY };
    const box = stage.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  }, []);

  const zoomFromToolbar = (factor: number) => {
    const stage = stageRef.current;
    const anchorX = (stage?.clientWidth ?? viewport.width) / 2;
    const anchorY = (stage?.clientHeight ?? viewport.height) / 2;
    setView((current) => zoomAt(current, current.zoom * factor, anchorX, anchorY));
  };

  const copySource = async () => {
    try {
      await navigator.clipboard.writeText(source);
      setCopied(true);
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
      copyTimerRef.current = window.setTimeout(() => {
        copyTimerRef.current = null;
        setCopied(false);
      }, 1200);
    } catch {
      setCopied(false);
    }
  };

  const downloadSvg = () => {
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = diagramDownloadName(id);
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    const bodyOverflow = document.body.style.overflow;
    const htmlOverflow = document.documentElement.style.overflow;
    // The transcript behind the viewer must not move while it is open.
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    if (dialog !== null && !dialog.open) dialog.showModal();
    return () => {
      dialog?.close();
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = htmlOverflow;
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    const measure = () => {
      setViewport({ width: stage.clientWidth, height: stage.clientHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  // Open on a fit; a rotation or a resized window also starts from a usable fit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the stage or drawing changes
  useEffect(() => {
    if (viewport.width === 0 || viewport.height === 0) return;
    reset();
  }, [contentSize.height, contentSize.width, viewport.height, viewport.width, reset]);

  useEffect(() => {
    const stage = stageRef.current;
    if (stage === null) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = localPoint(event);
      const factor = Math.exp(-event.deltaY * 0.0015);
      setView((current) => zoomAt(current, current.zoom * factor, point.x, point.y));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [localPoint]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const point = localPoint(event);
    pointersRef.current.set(event.pointerId, point);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer input (and some embedded browsers) cannot be captured.
    }
    if (pointersRef.current.size === 1) {
      dragRef.current = {
        pointerId: event.pointerId,
        start: point,
        view: viewRef.current,
        moved: false,
      };
      pinchRef.current = null;
    } else if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      if (a !== undefined && b !== undefined) {
        pinchRef.current = {
          distance: Math.max(1, distance(a, b)),
          midpoint: midpoint(a, b),
          view: viewRef.current,
        };
      }
      dragRef.current = null;
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    const point = localPoint(event);
    pointersRef.current.set(event.pointerId, point);

    const pinch = pinchRef.current;
    if (pinch !== null && pointersRef.current.size >= 2) {
      const [a, b] = [...pointersRef.current.values()];
      if (a === undefined || b === undefined) return;
      const nextMidpoint = midpoint(a, b);
      const zoom = clampZoom(pinch.view.zoom * (distance(a, b) / pinch.distance));
      const ratio = zoom / pinch.view.zoom;
      setView({
        zoom,
        x: nextMidpoint.x - (pinch.midpoint.x - pinch.view.x) * ratio,
        y: nextMidpoint.y - (pinch.midpoint.y - pinch.view.y) * ratio,
      });
      return;
    }

    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    const dx = point.x - drag.start.x;
    const dy = point.y - drag.start.y;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) drag.moved = true;
    setView({ ...drag.view, x: drag.view.x + dx, y: drag.view.y + dy });
  };

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const point = localPoint(event);
    pointersRef.current.delete(event.pointerId);
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // The pointer may already have been released by the browser.
    }

    if (pinchRef.current !== null) {
      pinchRef.current = null;
      const remaining = [...pointersRef.current.entries()][0];
      if (remaining !== undefined) {
        const [pointerId, remainingPoint] = remaining;
        dragRef.current = {
          pointerId,
          start: remainingPoint,
          view: viewRef.current,
          moved: true,
        };
      }
      return;
    }

    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (cancelled || event.pointerType !== "touch" || drag.moved) return;

    const now = Date.now();
    const last = lastTapRef.current;
    if (last !== null && now - last.time <= 300 && distance(point, last.point) <= 30) {
      lastTapRef.current = null;
      reset();
    } else {
      lastTapRef.current = { time: now, point };
    }
  };

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc is handled by the dialog's cancel event.
    <dialog
      ref={dialogRef}
      data-testid="diagram-viewer"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="m-auto h-[calc(100dvh-1.5rem)] w-[calc(100vw-1.5rem)] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border border-foreground/15 bg-surface p-0 text-foreground shadow-xl backdrop:bg-black/40 sm:h-[calc(100dvh-3rem)] sm:w-[calc(100vw-3rem)] sm:max-w-[calc(100vw-3rem)]"
    >
      <div className="flex h-full min-h-0 flex-col">
        <header className="ink-line flex shrink-0 flex-col gap-2 border-b px-3 py-2">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                diagram · rev {revision}
              </div>
              <h2 id={titleId} className="mt-0.5 text-sm font-medium">
                Diagram
              </h2>
            </div>
            <button
              type="button"
              data-testid="diagram-viewer-close"
              aria-label="Close"
              onClick={onClose}
              className="-mr-1 shrink-0 rounded-md px-2 py-1 font-mono text-sm text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
            >
              ✕
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              aria-label="Fit diagram"
              onClick={reset}
              className={TOOLBAR_BUTTON}
            >
              Fit
            </button>
            <button
              type="button"
              aria-label="Zoom in"
              onClick={() => zoomFromToolbar(1.25)}
              disabled={view.zoom >= MAX_ZOOM}
              className={TOOLBAR_BUTTON}
            >
              +
            </button>
            <button
              type="button"
              aria-label="Zoom out"
              onClick={() => zoomFromToolbar(0.8)}
              disabled={view.zoom <= MIN_ZOOM}
              className={TOOLBAR_BUTTON}
            >
              −
            </button>
            <button
              type="button"
              aria-label="Copy diagram source"
              onClick={() => {
                void copySource();
              }}
              className={TOOLBAR_BUTTON}
            >
              {copied ? "Copied" : "Copy"}
            </button>
            <button
              type="button"
              aria-label="Download SVG"
              onClick={downloadSvg}
              className={TOOLBAR_BUTTON}
            >
              SVG
            </button>
            <output
              aria-live="polite"
              className="theme-radius ml-auto border border-foreground/10 bg-background px-2 py-1 font-mono text-[11px] leading-4 tabular-nums text-muted-foreground"
            >
              {Math.round(view.zoom * 100)}%
            </output>
          </div>
        </header>
        <div
          ref={stageRef}
          data-testid="diagram-viewer-stage"
          role="application"
          aria-label="Diagram canvas"
          className="relative min-h-0 flex-1 cursor-grab touch-none select-none overflow-hidden bg-background active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={(event) => endPointer(event, false)}
          onPointerCancel={(event) => endPointer(event, true)}
          onDoubleClick={reset}
        >
          <div
            data-testid="diagram-viewer-surface"
            data-zoom={view.zoom.toFixed(3)}
            className="absolute top-0 left-0 origin-top-left will-change-transform"
            style={{
              width: contentSize.width,
              height: contentSize.height,
              transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${fitted * view.zoom})`,
            }}
          >
            <SvgMarkup svg={svg} />
          </div>
        </div>
        <p className="sr-only">
          Drag to pan, pinch or scroll to zoom, and double tap or press Fit to return to the whole
          drawing.
        </p>
      </div>
    </dialog>
  );
}
