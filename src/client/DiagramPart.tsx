import { lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { DIAGRAM_FORMAT } from "../shared/diagrams";
import type { DiagramRef } from "../shared/types";
import { DiagramViewer } from "./DiagramViewer";

const DiagramSvg = lazy(() => import("./lazy-diagram").then((m) => ({ default: m.DiagramSvg })));

interface DiagramFile {
  id: string;
  format: string;
  source: string;

  svg?: string;
  createdAt: string;
  updatedAt: string;
  revision: number;
}

type Load =
  | { status: "loading" }
  | { status: "ready"; diagram: DiagramFile }
  | { status: "error"; message: string };

function Card({ id, revision, children }: { id: string; revision: number; children: ReactNode }) {
  return (
    <figure
      data-testid="diagram"
      data-diagram-id={id}
      data-revision={revision}
      className="theme-radius my-md w-full min-w-0 overflow-hidden border border-border/70 bg-background"
    >
      <div className="flex items-center justify-between gap-lg border-b border-border/60 px-lg py-sm font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>diagram</span>
        <span>rev {revision}</span>
      </div>
      {children}
    </figure>
  );
}

function RawFallback({ diagram }: { diagram: DiagramFile }) {
  return (
    <div data-testid="diagram-raw" className="space-y-sm p-lg">
      <p className="font-mono text-[11px] leading-4 text-muted-foreground">
        format “{diagram.format}” is not supported here; showing the source
      </p>
      <pre className="overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-4 text-foreground [overflow-wrap:anywhere]">
        {diagram.source}
      </pre>
    </div>
  );
}

const DRAWING_CLASS = "max-h-[260px] overflow-hidden sm:max-h-[420px]";

export function DiagramPart({ id, revision }: DiagramRef) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [renderedSvg, setRenderedSvg] = useState<string | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ status: "loading" });
    setRenderedSvg(null);
    fetch(`/api/diagrams/${encodeURIComponent(id)}?rev=${revision}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(
            response.status === 404
              ? "This diagram no longer exists."
              : `Could not load the diagram (${response.status}).`,
          );
        }
        return (await response.json()) as DiagramFile;
      })
      .then((diagram) => {
        if (!controller.signal.aborted) setLoad({ status: "ready", diagram });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLoad({
          status: "error",
          message:
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "Could not load the diagram.",
        });
      });
    return () => controller.abort();
  }, [id, revision]);

  const ready = load.status === "ready" ? load.diagram : null;
  const supported = ready !== null && (ready.format === DIAGRAM_FORMAT || ready.svg !== undefined);
  const svg = ready?.svg ?? renderedSvg ?? null;
  const canOpen = ready !== null && supported && svg !== null;
  const drawing = ready !== null && supported && (
    <Suspense
      fallback={
        <p className="font-mono text-[11px] leading-5 text-muted-foreground" role="status">
          Drawing…
        </p>
      }
    >
      <DiagramSvg source={ready.source} svg={ready.svg} onSvg={setRenderedSvg} />
    </Suspense>
  );

  return (
    <>
      <Card id={id} revision={revision}>
        {load.status === "loading" && (
          <p className="p-lg font-mono text-[11px] leading-5 text-muted-foreground" role="status">
            Drawing…
          </p>
        )}
        {load.status === "error" && (
          <p
            role="alert"
            data-testid="diagram-error"
            className="theme-radius m-lg border border-destructive/60 bg-background px-lg py-md font-mono text-[11px] leading-4 text-destructive"
          >
            {load.message}
          </p>
        )}
        {ready !== null &&
          (supported ? (
            canOpen ? (
              <button
                type="button"
                data-testid="diagram-open"
                aria-label="Open diagram full screen"
                aria-haspopup="dialog"
                onClick={() => setViewerOpen(true)}
                className="block w-full min-w-0 overflow-hidden bg-background p-lg text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-foreground/40"
              >
                <div className={DRAWING_CLASS}>{drawing}</div>
              </button>
            ) : (
              <div className="p-lg">
                <div className={DRAWING_CLASS}>{drawing}</div>
              </div>
            )
          ) : (
            <RawFallback diagram={ready} />
          ))}
      </Card>
      {viewerOpen && canOpen && ready !== null && svg !== null && (
        <DiagramViewer
          id={ready.id}
          revision={ready.revision}
          source={ready.source}
          svg={svg}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </>
  );
}
