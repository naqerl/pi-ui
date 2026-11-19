import { render } from "pele";

export type DiagramRenderResult = { ok: true; svg: string } | { ok: false; message: string };

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
