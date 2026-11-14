import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

type Job = {
  id: string;
  name: string;
  command?: string;
  status: string;
  startedAt: string;
};
const hasCounts = (browser: Browser) =>
  browser.evaluate(() => document.querySelector('[data-testid="bg-jobs-line"]') !== null);

const statusY = (browser: Browser) =>
  browser.evaluate(
    () =>
      document.querySelector<HTMLElement>('[data-testid="working-status"]')?.getBoundingClientRect()
        .y ?? -1,
  );

const boxOf = (browser: Browser, testId: string) =>
  browser.evaluate((id) => {
    const box = document
      .querySelector<HTMLElement>(`[data-testid="${id}"]`)
      ?.getBoundingClientRect();
    return box === undefined ? null : { x: box.x, y: box.y, width: box.width, height: box.height };
  }, testId);

const textOf = (browser: Browser, testId: string) =>
  browser.evaluate(
    (id) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.textContent ?? "",
    testId,
  );

const jobs = (browser: Browser) =>
  browser.evaluate(async () => {
    return (await (await fetch("/api/jobs", { cache: "no-store" })).json()) as Job[];
  });

const rowMetrics = (browser: Browser) =>
  browser.evaluate(() => {
    const status = document.querySelector<HTMLElement>('[data-testid="working-status"]');
    const row = status?.parentElement;
    const counts = document.querySelector<HTMLElement>('[data-testid="bg-jobs-line"]');
    const box = (element: HTMLElement | null | undefined) =>
      element?.getBoundingClientRect() ?? null;
    const rowBox = box(row);
    const countBox = box(counts);
    return {
      statusY: box(status)?.y ?? -1,
      rowHeight: rowBox?.height ?? -1,
      rowTop: rowBox?.top ?? -1,
      rowBottom: rowBox?.bottom ?? -1,
      countTop: countBox?.top ?? -1,
      countBottom: countBox?.bottom ?? -1,
      countsInsideStatus: status !== null && counts !== null ? status.contains(counts) : false,
      hasSlot: document.querySelector(".bg-jobs-slot") !== null,
      hasCounts: counts !== null,
    };
  });

/**
 * The two texts share the row's baseline. Both use the same 11px/16px mono
 * metrics, so equal box bottoms mean equal baselines.
 */
const baselineGap = (browser: Browser) =>
  browser.evaluate(() => {
    // While a run is live the word is the indicator's `header-activity` span; when
    // the run is idle the same row paints the status word itself.
    const word =
      document.querySelector<HTMLElement>('[data-testid="header-activity"]') ??
      document.querySelector<HTMLElement>(
        '[data-testid="working-status"] > div > span:not([aria-hidden])',
      );
    const count =
      document.querySelector<HTMLElement>('[data-testid="bg-jobs-line-jobs"]') ??
      document.querySelector<HTMLElement>('[data-testid="bg-jobs-line-subagents"]');
    if (word === null || count === null) return null;
    // Range rects cover the glyphs, not the padded line box, so equal bottoms
    // mean equal text baselines regardless of the button's inline-block metrics.
    const textBottom = (element: HTMLElement) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect().bottom;
    };
    return Math.abs(textBottom(word) - textBottom(count));
  });

async function sendText(browser: Browser, text: string): Promise<void> {
  const status = await browser.evaluate(async (body) => {
    const response = await fetch("/api/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: body }),
    });
    return response.status;
  }, text);
  expect(status).toBe(202);
}

/** Let the 220 ms dock transition and the counts' 180 ms entry settle. */
async function settleDock(browser: Browser): Promise<void> {
  await browser.evaluate(async () => {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 360));
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return true;
  });
}

function seconds(value: string): number {
  return value
    .trim()
    .split(":")
    .map(Number)
    .reduce((total, part) => total * 60 + part, 0);
}

async function focusedComposer(browser: Browser): Promise<boolean> {
  return browser.evaluate(() => {
    const active = document.activeElement;
    return active instanceof HTMLTextAreaElement && active.getAttribute("aria-label") === "Message";
  });
}

async function cancelJob(browser: Browser, id: string): Promise<void> {
  await sendText(
    browser,
    `TOOLCALLS ${JSON.stringify([{ name: "job_cancel", arguments: { id } }])}`,
  );
}

test("a background job count opens a live sheet and returns focus to the composer", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");
  await expect(screen.getByTestId("working-status")).toBeVisible();
  await settleDock(browser);
  const empty = await rowMetrics(browser);
  expect(empty.hasSlot).toBe(false);
  const baseline = empty.statusY;

  const marker = `BG_JOBS_${Date.now()}`;
  await sendText(browser, `JOBSTART sleep 60; echo ${marker}`);
  await expect.poll(() => hasCounts(browser), { timeout: 20_000 }).toBe(true);
  await expect(screen.getByTestId("bg-jobs-line-jobs")).toHaveText("1 job");
  expect(await boxOf(browser, "bg-jobs-line-subagents")).toBeNull();

  await settleDock(browser);
  const withCounts = await rowMetrics(browser);
  // Same row, same width budget: the count rides after the working indicator.
  expect(withCounts.hasSlot).toBe(false);
  expect(withCounts.countsInsideStatus).toBe(true);
  expect(withCounts.countBottom).toBeGreaterThan(withCounts.rowTop);
  expect(withCounts.countTop).toBeLessThan(withCounts.rowBottom);
  // The row does not grow when the counts arrive, so the composer cannot move.
  expect(Math.abs(withCounts.rowHeight - empty.rowHeight)).toBeLessThan(0.5);
  expect(await statusY(browser)).toBeCloseTo(baseline, 0);
  const gap = await baselineGap(browser);
  expect(gap).not.toBeNull();
  expect(gap ?? 99).toBeLessThan(2);

  // The same baseline holds when the live working indicator paints the row.
  await sendText(browser, "SLOW keep working");
  await expect(screen.getByTestId("header-activity")).toBeVisible();
  await settleDock(browser);
  const workingGap = await baselineGap(browser);
  expect(workingGap).not.toBeNull();
  expect(workingGap ?? 99).toBeLessThan(2);
  await screen.getByRole("button", "Stop").tap();
  await expect(screen.getByTestId("working-status")).toHaveAttribute("data-open", "false");
  await settleDock(browser);

  // The status row still sits directly above the composer body, with no strip between.
  const order = await browser.evaluate(() => {
    const top = (id: string) =>
      document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.getBoundingClientRect().y ?? -1;
    return { status: top("working-status"), body: top("composer-body") };
  });
  expect(order.status).toBeLessThan(order.body);

  await screen.getByTestId("bg-jobs-line-jobs").tap();
  await expect(screen.getByTestId("bg-jobs-sheet")).toBeVisible();
  await expect(screen.getByTestId("bg-jobs-sheet-list")).toBeVisible();
  const row = screen.getByTestId("bg-jobs-sheet-job");
  await expect(row).toBeVisible();
  await expect.poll(() => textOf(browser, "bg-jobs-sheet-job")).toContain("sleep 60");

  const started = seconds(await textOf(browser, "bg-jobs-sheet-duration"));
  await expect
    .poll(async () => seconds(await textOf(browser, "bg-jobs-sheet-duration")), { timeout: 5_000 })
    .toBeGreaterThan(started);

  await row.tap();
  await expect(screen.getByTestId("activity-dialog")).toBeVisible();
  await expect(screen.getByTestId("activity-job")).toBeVisible();
  await expect.poll(() => textOf(browser, "activity-card")).toContain("Command");
  await expect.poll(() => textOf(browser, "activity-card")).toContain("sleep 60");
  await expect.poll(() => textOf(browser, "activity-card")).toContain("running");
  await expect
    .poll(() =>
      browser.evaluate(() => document.querySelector('[data-testid="bg-jobs-sheet"]') !== null),
    )
    .toBe(false);

  await screen.getByTestId("activity-dialog-close").tap();
  await expect
    .poll(() =>
      browser.evaluate(() => document.querySelector('[data-testid="activity-dialog"]') !== null),
    )
    .toBe(false);
  await expect.poll(() => focusedComposer(browser)).toBe(true);

  const running = (await jobs(browser)).find((job) => job.status === "running");
  expect(running).toBeDefined();
  if (running !== undefined) await cancelJob(browser, running.id);
  await expect.poll(() => hasCounts(browser), { timeout: 20_000 }).toBe(false);
  await settleDock(browser);
  const after = await rowMetrics(browser);
  expect(Math.abs(after.rowHeight - empty.rowHeight)).toBeLessThan(0.5);
  expect(await statusY(browser)).toBeCloseTo(baseline, 0);
});
