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

/** One transcript run-info chip, plus the rows its activity dialog shows. */
export interface ActivitySurface {
  chips: Array<{ label: string; ariaLabel: string }>;
  rows: Array<{ name: string; summary: string }>;
  /** The first row's details after one disclosure click, then after the second. */
  expands: boolean;
  collapses: boolean;
}

/**
 * Read the activity surface a transcript renders: the run-info chips, the dialog
 * the newest chip opens, and whether its rows expand and collapse. Both the chat
 * page and the plan chat use this, so an equivalent turn is compared honestly.
 */
export function readActivitySurface(
  browser: Browser,
  scopeSelector: string,
): Promise<ActivitySurface | null> {
  return browser.evaluate(async (selector) => {
    const frames = () =>
      new Promise<boolean>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
      });
    const normalize = (text: string) =>
      text
        .replace(/\b\d+m \d+s\b/g, "<duration>")
        .replace(/\b\d+(?:\.\d+)?s\b/g, "<duration>")
        .replace(/\s+/g, " ")
        .trim();
    const scope = document.querySelector<HTMLElement>(selector);
    if (scope === null) return null;
    const chips = [...scope.querySelectorAll<HTMLElement>('[data-testid="run-info"]')].map(
      (chip) => ({
        label: normalize(
          chip.querySelector<HTMLElement>('[data-testid="run-info-summary"]')?.textContent ?? "",
        ),
        ariaLabel: normalize(chip.getAttribute("aria-label") ?? ""),
      }),
    );
    const trigger = scope.querySelectorAll<HTMLElement>('[data-testid="run-info"]');
    const newest = trigger[trigger.length - 1];
    if (newest === undefined) return { chips, rows: [], expands: false, collapses: false };
    newest.click();
    const deadline = performance.now() + 10_000;
    let dialog: HTMLElement | null = null;
    while (performance.now() < deadline) {
      dialog = document.querySelector<HTMLElement>('[data-testid="activity-dialog"]');
      if (dialog !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (dialog === null) return null;
    await frames();
    const rows = [...dialog.querySelectorAll<HTMLElement>('[data-testid="activity-row"]')].map(
      (row) => ({
        name: row.dataset.activityName ?? "",
        summary: normalize(row.textContent ?? ""),
      }),
    );
    const first = dialog.querySelector<HTMLElement>('[data-testid="activity-row"]');
    const details = () => dialog?.querySelectorAll("pre").length ?? 0;
    first?.click();
    await frames();
    const expands = details() > 0;
    first?.click();
    await frames();
    const collapses = details() === 0;
    dialog.querySelector<HTMLElement>('[data-testid="activity-dialog-close"]')?.click();
    const closeDeadline = performance.now() + 5_000;
    while (
      document.querySelector('[data-testid="activity-dialog"]') !== null &&
      performance.now() < closeDeadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await frames();
    return { chips, rows, expands, collapses };
  }, scopeSelector);
}
