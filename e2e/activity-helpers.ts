import type { Browser } from "@e2e-dev/web";

/** The vertical alignment of an activity row's disclosure against its summary text. */
export interface ChevronMeasurement {
  /** Screen-space centre of the chevron's ink, not its square SVG box. */
  chevronInkCentreY: number;
  /** Screen-space centre of the summary's first-line cap height. */
  textCapCentreY: number;
  /** Screen-space centre of the summary's whole line block. */
  textBlockCentreY: number;
  /** The centre the chevron should follow, chosen by the row's line and wrapping strategy. */
  targetCentreY: number;
  /** Positive when the chevron sits below the text's optical centre. */
  gap: number;
  /** Height of the row trigger; the expanded panel is outside it. */
  rowHeight: number;
  /** Whether the summary occupies more than one line at the current width. */
  wrapped: boolean;
}

export interface ChevronMeasureOptions {
  /** Defaults to the row's `<testid>-summary`, then its first flex-1 child. */
  summarySelector?: string;
  /** Wrapped rows follow their block centre by default; run-info follows its first line. */
  wrappedTarget?: "block" | "first-line";
}

/** Measure one activity row, `index`-th among rows with the same test id. */
export function chevronMeasurement(
  browser: Browser,
  testId: string,
  index = 0,
  options: ChevronMeasureOptions = {},
): Promise<ChevronMeasurement> {
  return browser.evaluate(
    ({ id, rowIndex, summarySelector, wrappedTarget }) => {
      const missing = () => ({
        chevronInkCentreY: Number.NaN,
        textCapCentreY: Number.NaN,
        textBlockCentreY: Number.NaN,
        targetCentreY: Number.NaN,
        gap: Number.NaN,
        rowHeight: Number.NaN,
        wrapped: false,
      });
      const rows = document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`);
      const row = rows[rowIndex];
      if (row === undefined) return missing();
      const chevron = row.querySelector<SVGElement>('svg[data-icon="chevron"]');
      const summary =
        (summarySelector === "" ? null : row.querySelector<HTMLElement>(summarySelector)) ??
        row.querySelector<HTMLElement>(`[data-testid="${id}-summary"]`) ??
        row.querySelector<HTMLElement>("span.flex-1");
      const glyph = chevron?.querySelector<SVGGraphicsElement>("path") ?? chevron;
      if (!chevron || !summary || !glyph) return missing();

      // The path rect is its ink bbox in screen space, after the span's 90°
      // rotate and any CSS zoom, so both disclosure states measure alike.
      const inkBox = glyph.getBoundingClientRect();
      const chevronInkCentreY = inkBox.top + inkBox.height / 2;

      const summaryBox = summary.getBoundingClientRect();
      const textBlockCentreY = summaryBox.top + summaryBox.height / 2;
      const style = getComputedStyle(summary);
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (context === null) return missing();
      context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const cap = context.measureText("H");
      const lineHeight = Number.parseFloat(style.lineHeight);
      // CSS zoom leaves computed font metrics in pre-zoom px while the rect is
      // scaled, so scale the metrics too before mixing them with screen space.
      const rootZoom = Number.parseFloat(getComputedStyle(document.documentElement).zoom);
      const zoom = Number.isFinite(rootZoom) && rootZoom > 0 ? rootZoom : 1;
      const fontAscent = cap.fontBoundingBoxAscent * zoom;
      const fontDescent = cap.fontBoundingBoxDescent * zoom;
      const usedLineHeight = (Number.isFinite(lineHeight) ? lineHeight : summaryBox.height) * zoom;
      // The summary's line-box height tells whether it wraps: one line follows
      // its cap-height centre, while a wrapped block follows its block centre.
      const wrapped = usedLineHeight > 0 && summaryBox.height > usedLineHeight * 1.5;
      const baselineY =
        summaryBox.top + (usedLineHeight - (fontAscent + fontDescent)) / 2 + fontAscent;
      const textCapCentreY = baselineY - (cap.actualBoundingBoxAscent * zoom) / 2;
      const targetCentreY =
        wrapped && wrappedTarget === "block" ? textBlockCentreY : textCapCentreY;
      return {
        chevronInkCentreY,
        textCapCentreY,
        textBlockCentreY,
        targetCentreY,
        gap: chevronInkCentreY - targetCentreY,
        rowHeight: row.getBoundingClientRect().height,
        wrapped,
      };
    },
    {
      id: testId,
      rowIndex: index,
      summarySelector: options.summarySelector ?? "",
      wrappedTarget: options.wrappedTarget ?? "block",
    },
  );
}

/** Absolute distance between a row's chevron ink and its text's optical centre, in px. */
export async function chevronCentreGap(
  browser: Browser,
  testId: string,
  index = 0,
): Promise<number> {
  const measured = await chevronMeasurement(browser, testId, index);
  return Math.abs(measured.gap);
}
