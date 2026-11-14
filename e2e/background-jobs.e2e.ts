import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

type Job = {
  id: string;
  name: string;
  command?: string;
  status: string;
  startedAt: string;
};

type DelegateRun = {
  id: string;
  task: string;
  status: string;
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

const delegates = (browser: Browser) =>
  browser.evaluate(async () => {
    return (await (await fetch("/api/delegates", { cache: "no-store" })).json()) as DelegateRun[];
  });

/** The status row is the `working-status` element's parent; the counts must not grow it. */
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

const scrollPositions = (browser: Browser) =>
  browser.evaluate(() => {
    const body = document.querySelector<HTMLElement>('[data-testid="composer-body"]');
    const scroller = document.querySelector<HTMLElement>('[data-testid="chat-scroller"]');
    return { body: body?.scrollTop ?? -1, transcript: scroller?.scrollTop ?? -1 };
  });

const pagerPage = (browser: Browser) =>
  browser.evaluate(
    () => document.querySelector("[data-testid=pager]")?.getAttribute("data-page") ?? null,
  );

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

test("nothing running leaves no counts and keeps the status row at its resting height", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");
  await expect(screen.getByTestId("working-status")).toBeVisible();
  await settleDock(browser);

  const empty = await rowMetrics(browser);
  // The old strip is gone, and with no live work there is no count node at all.
  expect(empty.hasSlot).toBe(false);
  expect(empty.hasCounts).toBe(false);
  expect(await statusY(browser)).toBeCloseTo(empty.statusY, 2);
  const restingHeight = empty.rowHeight;
  expect(restingHeight).toBeGreaterThan(0);

  // A job that ends on its own leaves the row untouched as well.
  await sendText(browser, "JOBSTART sleep 3; echo bg-jobs-finished");
  await expect.poll(() => hasCounts(browser), { timeout: 15_000 }).toBe(true);
  await settleDock(browser);
  const running = await rowMetrics(browser);
  expect(running.hasSlot).toBe(false);
  expect(running.countsInsideStatus).toBe(true);
  expect(Math.abs(running.rowHeight - restingHeight)).toBeLessThan(0.5);

  await expect
    .poll(async () => (await jobs(browser)).some((job) => job.status === "running"), {
      timeout: 20_000,
    })
    .toBe(false);
  await expect.poll(() => hasCounts(browser), { timeout: 10_000 }).toBe(false);
  await settleDock(browser);
  const after = await rowMetrics(browser);
  expect(after.hasSlot).toBe(false);
  expect(after.hasCounts).toBe(false);
  expect(Math.abs(after.rowHeight - restingHeight)).toBeLessThan(0.5);
  expect(after.statusY).toBeCloseTo(empty.statusY, 0);
});

test("counts stay on chat, align with the plus, and the sheet is a centred partial sheet", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");
  await expect(screen.getByTestId("working-status")).toBeVisible();
  await settleDock(browser);

  await sendText(browser, `JOBSTART sleep 60; echo ALIGN_${Date.now()}`);
  await expect.poll(() => hasCounts(browser), { timeout: 20_000 }).toBe(true);
  await expect(screen.getByTestId("bg-jobs-line-jobs")).toHaveText("1 job");
  await settleDock(browser);

  const alignment = () =>
    browser.evaluate(() => {
      const counts = document.querySelector<HTMLElement>('[data-testid="bg-jobs-line"]');
      const plus = document.querySelector<HTMLElement>('button[aria-label="Attach image"]');
      if (counts === null || plus === null) return null;
      const countsBox = counts.getBoundingClientRect();
      const plusBox = plus.getBoundingClientRect();
      return {
        delta: Math.abs(countsBox.left - plusBox.left),
        countsLeft: countsBox.left,
        plusLeft: plusBox.left,
      };
    });

  const phone = await alignment();
  expect(phone).not.toBeNull();
  expect(phone?.delta ?? 99).toBeLessThanOrEqual(1);

  await screen.getByTestId("bg-jobs-line-jobs").tap();
  await expect(screen.getByTestId("bg-jobs-sheet")).toBeVisible();
  const sheetLayout = await browser.evaluate(() => {
    const sheet = document.querySelector<HTMLElement>('[data-testid="bg-jobs-sheet"]');
    const title = sheet?.querySelector<HTMLElement>("h2");
    const duration = document.querySelector<HTMLElement>('[data-testid="bg-jobs-sheet-duration"]');
    if (sheet === null || title === undefined || title === null) return null;
    const sheetBox = sheet.getBoundingClientRect();
    const titleBox = title.getBoundingClientRect();
    return {
      height: sheetBox.height,
      viewport: window.innerHeight,
      titleDelta: Math.abs(
        titleBox.left + titleBox.width / 2 - (sheetBox.left + sheetBox.width / 2),
      ),
      duration: duration?.textContent ?? "",
    };
  });
  expect(sheetLayout).not.toBeNull();
  expect(sheetLayout?.height ?? 99_999).toBeLessThanOrEqual((sheetLayout?.viewport ?? 0) * 0.85);
  expect(sheetLayout?.titleDelta ?? 99).toBeLessThanOrEqual(1);
  expect(sheetLayout?.duration ?? "").toMatch(/^\d{2}:\d{2}$/);
  await screen.getByTestId("bg-jobs-sheet-close").tap();
  await expect
    .poll(() =>
      browser.evaluate(() => document.querySelector('[data-testid="bg-jobs-sheet"]') !== null),
    )
    .toBe(false);

  const switching = await browser.evaluate(async () => {
    const counts = document.querySelector<HTMLElement>('[data-testid="bg-jobs-line"]');
    const before =
      counts === null
        ? null
        : {
            transform: getComputedStyle(counts).transform,
            height: getComputedStyle(counts).height,
          };
    document.querySelector<HTMLElement>('[data-testid="page-dot-stats"]')?.click();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
    const mid =
      counts === null
        ? null
        : {
            transform: getComputedStyle(counts).transform,
            height: getComputedStyle(counts).height,
            connected: counts.isConnected,
          };
    return { before, mid };
  });
  expect(switching.before).not.toBeNull();
  expect(switching.mid).not.toBeNull();
  expect(switching.mid?.connected).toBe(true);
  expect(switching.mid?.transform).not.toBe(switching.before?.transform);
  expect(switching.mid?.height).toBe(switching.before?.height);
  await expect.poll(() => pagerPage(browser)).toBe("stats");
  await expect.poll(() => hasCounts(browser)).toBe(false);

  await screen.getByTestId("page-dot-tasks").tap();
  await expect.poll(() => pagerPage(browser)).toBe("tasks");
  await settleDock(browser);
  expect(await hasCounts(browser)).toBe(false);

  await screen.getByTestId("page-dot-chat").tap();
  await expect.poll(() => pagerPage(browser)).toBe("chat");
  await expect.poll(() => hasCounts(browser)).toBe(true);
  await settleDock(browser);

  await browser.setViewport({ width: 1280, height: 800 });
  await settleDock(browser);
  const desktop = await alignment();
  expect(desktop).not.toBeNull();
  expect(desktop?.delta ?? 99).toBeLessThanOrEqual(1);

  const running = (await jobs(browser)).find((job) => job.status === "running");
  if (running !== undefined) await cancelJob(browser, running.id);
  await expect.poll(() => hasCounts(browser), { timeout: 20_000 }).toBe(false);
});

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
  // Same row, same width budget: the count leads the working indicator.
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

test("a subagent count opens the same sheet with its task and state", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");
  await expect(screen.getByTestId("working-status")).toBeVisible();
  await settleDock(browser);
  const empty = await rowMetrics(browser);
  const baseline = empty.statusY;

  const marker = `BG_JOBS_SUBAGENT_${Date.now()}`;
  await sendText(browser, `JOBSTART sleep 60; echo BG_JOBS_BOTH_${Date.now()}`);
  await expect(screen.getByTestId("bg-jobs-line-jobs")).toHaveText("1 job");
  await sendText(
    browser,
    `TOOLCALLS ${JSON.stringify([
      { name: "acp_delegate", arguments: { agent: "worker", task: `SLOW ${marker}` } },
    ])}`,
  );
  await expect
    .poll(async () => (await delegates(browser)).some((item) => item.task.includes(marker)), {
      timeout: 30_000,
    })
    .toBe(true);

  await expect.poll(() => hasCounts(browser), { timeout: 20_000 }).toBe(true);
  await expect(screen.getByTestId("bg-jobs-line-jobs")).toHaveText("1 job");
  await expect(screen.getByTestId("bg-jobs-line-subagents")).toHaveText("1 subagent");
  expect(await boxOf(browser, "bg-jobs-line-jobs")).not.toBeNull();

  await settleDock(browser);
  const withCounts = await rowMetrics(browser);
  expect(withCounts.hasSlot).toBe(false);
  expect(withCounts.countsInsideStatus).toBe(true);
  expect(Math.abs(withCounts.rowHeight - empty.rowHeight)).toBeLessThan(0.5);
  expect(await statusY(browser)).toBeCloseTo(baseline, 0);
  const gap = await baselineGap(browser);
  expect(gap).not.toBeNull();
  expect(gap ?? 99).toBeLessThan(2);

  await screen.getByTestId("bg-jobs-line-subagents").tap();
  await expect(screen.getByTestId("bg-jobs-sheet")).toBeVisible();
  await expect(screen.getByTestId("bg-jobs-sheet-list")).toBeVisible();
  const row = screen.getByTestId("bg-jobs-sheet-subagent");
  await expect(row).toBeVisible();
  await expect.poll(() => textOf(browser, "bg-jobs-sheet-subagent")).toContain(marker);

  const started = seconds(await textOf(browser, "bg-jobs-sheet-duration"));
  await expect
    .poll(async () => seconds(await textOf(browser, "bg-jobs-sheet-duration")), { timeout: 5_000 })
    .toBeGreaterThan(started);

  await row.tap();
  await expect(screen.getByTestId("activity-dialog")).toBeVisible();
  await expect(screen.getByTestId("activity-delegate")).toBeVisible();
  await expect.poll(() => textOf(browser, "activity-card")).toContain(marker);
  await expect.poll(() => textOf(browser, "activity-card")).toContain("Task");
  await expect.poll(() => textOf(browser, "activity-card")).toContain("Status");
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

  const active = (await delegates(browser)).find(
    (item) => item.task.includes(marker) && item.status === "running",
  );
  if (active !== undefined) {
    await sendText(
      browser,
      `TOOLCALLS ${JSON.stringify([
        { name: "acp_delegate_cancel", arguments: { runId: active.id } },
      ])}`,
    );
  }
  const runningJob = (await jobs(browser)).find((job) => job.status === "running");
  if (runningJob !== undefined) await cancelJob(browser, runningJob.id);
  await expect.poll(() => hasCounts(browser), { timeout: 30_000 }).toBe(false);
});

test("chat to stats and back leaves the composer body and transcript where they were", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");
  await expect(screen.getByTestId("working-status")).toBeVisible();
  await settleDock(browser);

  const marker = `BG_JOBS_SCROLL_${Date.now()}`;
  await sendText(browser, `JOBSTART sleep 60; echo ${marker}`);
  await expect.poll(() => hasCounts(browser), { timeout: 20_000 }).toBe(true);
  await settleDock(browser);

  // Park the transcript at its settled offset; the round trip must not change it.
  await browser.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="chat-scroller"]');
    if (scroller !== null) {
      scroller.scrollTop = scroller.scrollHeight;
      scroller.dispatchEvent(new Event("scroll"));
    }
    return true;
  });
  const before = await scrollPositions(browser);
  expect(before.body).toBeGreaterThanOrEqual(0);
  expect(before.transcript).toBeGreaterThanOrEqual(0);

  await screen.getByTestId("page-dot-stats").tap();
  await expect.poll(() => pagerPage(browser)).toBe("stats");
  await settleDock(browser);
  await screen.getByTestId("page-dot-chat").tap();
  await expect.poll(() => pagerPage(browser)).toBe("chat");
  await settleDock(browser);

  const after = await scrollPositions(browser);
  expect(after.body).toBe(before.body);
  expect(after.transcript).toBe(before.transcript);

  const running = (await jobs(browser)).find((job) => job.status === "running");
  if (running !== undefined) await cancelJob(browser, running.id);
  await expect.poll(() => hasCounts(browser), { timeout: 20_000 }).toBe(false);
});
