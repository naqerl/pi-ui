import { render } from "pele";

/** What the card shows for one source: the drawing, or the parser's own explanation. */
export type DiagramRenderResult = { ok: true; svg: string } | { ok: false; message: string };

/**
 * Renders Mermaid source with Pele, which is bundled, so a drawing needs no network. A parse or
 * layout failure is returned instead of thrown, so one bad diagram cannot crash the transcript.
 */
export function renderDiagram(source: string): DiagramRenderResult {
  try {
    const { svg } = render(source);
    return { ok: true, svg };
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim().length > 0
        ? error.message
        : "The diagram could not be rendered.";
    return { ok: false, message };
  }
}
