import { useEffect, useMemo } from "react";
import { type DiagramRenderResult, renderDiagram, renderSvgMarkup } from "./diagram-render";

function DiagramError({ message, source }: { message: string; source: string }) {
  return (
    <div
      role="alert"
      data-testid="diagram-error"
      className="theme-radius border border-destructive/60 bg-background px-lg py-md font-mono text-[11px] leading-4 text-destructive"
    >
      <p className="whitespace-pre-wrap [overflow-wrap:anywhere]">{message}</p>
      <pre className="mt-md max-h-40 overflow-auto whitespace-pre-wrap border-t border-destructive/30 pt-md text-muted-foreground [overflow-wrap:anywhere]">
        {source}
      </pre>
    </div>
  );
}

export function DiagramSvg({
  source,
  svg,
  onSvg,
}: {
  source: string;
  svg?: string;
  onSvg?: (svg: string) => void;
}) {
  const result = useMemo<DiagramRenderResult>(() => {
    if (svg !== undefined && svg.trim().length > 0) return { ok: true, svg };
    return renderDiagram(source);
  }, [source, svg]);
  useEffect(() => {
    if (result.ok) onSvg?.(result.svg);
  }, [onSvg, result]);
  const markup = useMemo(() => (result.ok ? renderSvgMarkup(result.svg) : null), [result]);
  if (!result.ok) return <DiagramError message={result.message} source={source} />;
  return <div className="diagram-svg">{markup}</div>;
}

export function MarkdownDiagram({ source }: { source: string }) {
  return (
    <div
      data-testid="markdown-diagram"
      className="theme-radius overflow-hidden border border-border bg-background p-lg"
    >
      <DiagramSvg source={source} />
    </div>
  );
}
