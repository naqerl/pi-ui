import { useMemo } from "react";
import { renderDiagram } from "./diagram-render";

/** A failed or invalid drawing stays a card in the message, with the parser's message. */
function DiagramError({ message, source }: { message: string; source: string }) {
  return (
    <div
      role="alert"
      data-testid="diagram-error"
      className="theme-radius border border-destructive/60 bg-background px-2 py-1.5 font-mono text-[11px] leading-4 text-destructive"
    >
      <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{message}</p>
      <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap border-t border-destructive/30 pt-1.5 text-muted-foreground [overflow-wrap:anywhere]">
        {source}
      </pre>
    </div>
  );
}

/** The drawing itself. Kept in its own chunk because the renderer is the largest part. */
export function DiagramSvg({ source }: { source: string }) {
  const result = useMemo(() => renderDiagram(source), [source]);
  if (!result.ok) return <DiagramError message={result.message} source={source} />;
  return (
    // biome-ignore lint/security/noDangerouslySetInnerHtml: Pele escapes diagram text and filters links and styles.
    <div className="diagram-svg" dangerouslySetInnerHTML={{ __html: result.svg }} />
  );
}
