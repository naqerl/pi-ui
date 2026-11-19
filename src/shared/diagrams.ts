import type { DiagramRef, MessagePart } from "./types.js";

export const DIAGRAM_FORMAT = "mermaid";

export const DIAGRAM_ID_PATTERN = /^[a-z2-7]{10}$/;

export interface DiagramDetails {
  id: string;
  revision: number;

  title?: string;
}

export function parseDiagramDetails(value: unknown): DiagramDetails | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.diagram !== "object" || record.diagram === null) return undefined;
  const ref = record.diagram as Record<string, unknown>;
  if (typeof ref.id !== "string" || !DIAGRAM_ID_PATTERN.test(ref.id)) return undefined;
  if (typeof ref.revision !== "number" || !Number.isSafeInteger(ref.revision) || ref.revision < 1) {
    return undefined;
  }
  const rawTitle = record.title;
  const title =
    typeof rawTitle === "string" && rawTitle.trim().length > 0
      ? rawTitle.trim().slice(0, 200)
      : undefined;
  return { id: ref.id, revision: ref.revision, ...(title === undefined ? {} : { title }) };
}

export function diagramPartFromDetails(
  value: unknown,
  currentRevision?: (id: string) => number | undefined,
): MessagePart | undefined {
  const details = parseDiagramDetails(value);
  if (details === undefined) return undefined;
  const diagram: DiagramRef = {
    id: details.id,
    revision: currentRevision?.(details.id) ?? details.revision,
  };
  return { kind: "diagram", diagram };
}
