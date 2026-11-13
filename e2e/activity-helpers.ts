import type { Browser } from "@e2e-dev/web";

/** Distance between a row's vertical centre and its disclosure chevron's centre, in px. */
export function chevronCentreGap(browser: Browser, testId: string): Promise<number> {
  return browser.evaluate((id) => {
    const row = document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
    const chevron = row?.querySelector<SVGElement>('svg[data-icon="chevron"]');
    if (row === null || row === undefined || chevron === null || chevron === undefined) {
      return Number.NaN;
    }
    const rowBox = row.getBoundingClientRect();
    const chevronBox = chevron.getBoundingClientRect();
    return Math.abs(rowBox.top + rowBox.height / 2 - (chevronBox.top + chevronBox.height / 2));
  }, testId);
}
