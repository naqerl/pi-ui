/** Zoom is relative to the fitted drawing: 0.5x shows it at half fit, 8x at eight times fit. */
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 8;
/** Breathing room between the drawing and the stage edges when it is fitted. */
export const VIEWER_PADDING = 24;

export interface DiagramView {
  /** Scale relative to fit. */
  zoom: number;
  /** Screen-space translation of the drawing's top-left corner. */
  x: number;
  y: number;
}

export interface FittedView extends DiagramView {
  /** The absolute scale at zoom 1, before the viewport transform. */
  scale: number;
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** The scale that fits `contentWidth` x `contentHeight` inside the stage with a small margin. */
export function fitScale(
  viewportWidth: number,
  viewportHeight: number,
  contentWidth: number,
  contentHeight: number,
  padding = VIEWER_PADDING,
): number {
  if (
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    !Number.isFinite(contentWidth) ||
    !Number.isFinite(contentHeight) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0 ||
    contentWidth <= 0 ||
    contentHeight <= 0
  ) {
    return 1;
  }
  const availableWidth = Math.max(1, viewportWidth - padding * 2);
  const availableHeight = Math.max(1, viewportHeight - padding * 2);
  const scale = Math.min(availableWidth / contentWidth, availableHeight / contentHeight);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** The centred, fit-to-screen view used when the viewer opens or the reader taps fit. */
export function fitView(
  viewportWidth: number,
  viewportHeight: number,
  contentWidth: number,
  contentHeight: number,
  padding = VIEWER_PADDING,
): FittedView {
  const scale = fitScale(viewportWidth, viewportHeight, contentWidth, contentHeight, padding);
  return {
    zoom: 1,
    scale,
    x: (viewportWidth - contentWidth * scale) / 2,
    y: (viewportHeight - contentHeight * scale) / 2,
  };
}

/** Zoom while keeping the content point under `(anchorX, anchorY)` in place. */
export function zoomAt(
  view: DiagramView,
  nextZoom: number,
  anchorX: number,
  anchorY: number,
): DiagramView {
  const current = clampZoom(view.zoom);
  const zoom = clampZoom(nextZoom);
  const ratio = zoom / current;
  return {
    zoom,
    x: anchorX - (anchorX - view.x) * ratio,
    y: anchorY - (anchorY - view.y) * ratio,
  };
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** The name the viewer uses when it downloads the drawing as a standalone SVG file. */
export function diagramDownloadName(id: string, title?: string): string {
  const safeId = slug(id) || "diagram";
  const label = title === undefined ? "" : slug(title);
  return label === "" ? `diagram-${safeId}.svg` : `${label}-${safeId}.svg`;
}
