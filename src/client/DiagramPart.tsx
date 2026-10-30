import { lazy, type ReactNode, Suspense, useEffect, useState } from "react";
import { DIAGRAM_FORMAT } from "../shared/diagrams";
import type { DiagramRef } from "../shared/types";

const DiagramSvg = lazy(() => import("./lazy-diagram").then((m) => ({ default: m.DiagramSvg })));

/** The JSON `GET /api/diagrams/<id>` returns. The source is never part of the transcript. */
interface DiagramFile {
  id: string;
  format: string;
  source: string;
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
      className="theme-radius my-1.5 w-full min-w-0 overflow-hidden border border-border/70 bg-background"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-2 py-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>diagram</span>
        <span>rev {revision}</span>
      </div>
      <div className="max-h-[60vh] overflow-auto p-2">{children}</div>
    </figure>
  );
}

/** A format this bundle cannot draw is shown as its source, never as a blank card. */
function RawFallback({ diagram }: { diagram: DiagramFile }) {
  return (
    <div data-testid="diagram-raw" className="space-y-1">
      <p className="font-mono text-[11px] leading-4 text-muted-foreground">
        format “{diagram.format}” is not supported here; showing the source
      </p>
      <pre className="overflow-auto whitespace-pre-wrap font-mono text-[11px] leading-4 text-foreground [overflow-wrap:anywhere]">
        {diagram.source}
      </pre>
    </div>
  );
}

/**
 * One diagram part of a message. It stores only `{id, revision}`; the source is fetched here, so
 * a replace changes the revision and redraws the same message without touching the transcript.
 */
export function DiagramPart({ id, revision }: DiagramRef) {
  const [load, setLoad] = useState<Load>({ status: "loading" });

  useEffect(() => {
    const controller = new AbortController();
    setLoad({ status: "loading" });
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

  return (
    <Card id={id} revision={revision}>
      {load.status === "loading" && (
        <p className="font-mono text-[11px] leading-5 text-muted-foreground" role="status">
          Drawing…
        </p>
      )}
      {load.status === "error" && (
        <p
          role="alert"
          data-testid="diagram-error"
          className="theme-radius border border-destructive/60 bg-background px-2 py-1.5 font-mono text-[11px] leading-4 text-destructive"
        >
          {load.message}
        </p>
      )}
      {load.status === "ready" &&
        (load.diagram.format === DIAGRAM_FORMAT ? (
          <Suspense
            fallback={
              <p className="font-mono text-[11px] leading-5 text-muted-foreground" role="status">
                Drawing…
              </p>
            }
          >
            <DiagramSvg source={load.diagram.source} />
          </Suspense>
        ) : (
          <RawFallback diagram={load.diagram} />
        ))}
    </Card>
  );
}
