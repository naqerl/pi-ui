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

const hasLine = (browser: Browser) =>
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

/** Let the 220 ms layout transition settle before measuring the dock. */
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

test("nothing running leaves no jobs line and keeps the status line where it was", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");
  await expect(screen.getByTestId("working-status")).toBeVisible();
  await settleDock(browser);

  const empty = await browser.evaluate(() => {
    const slot = document.querySelector<HTMLElement>(".bg-jobs-slot");
    const status = document.querySelector<HTMLElement>('[data-testid="working-status"]');
    const withSlot = status?.getBoundingClientRect().y ?? -1;
    const display = slot?.style.display ?? "";
    if (slot !== null) slot.style.display = "none";
    const withoutSlot = status?.getBoundingClientRect().y ?? -1;
    if (slot !== null) slot.style.display = display;
    return {
      slotHeight: slot?.getBoundingClientRect().height ?? -1,
      withSlot,
      withoutSlot,
      statusY: status?.getBoundingClientRect().y ?? -1,
    };
  });
  // The empty slot contributes exactly zero height: hiding it cannot move the status line.
  expect(empty.slotHeight).toBe(0);
  expect(empty.withSlot).toBeCloseTo(empty.withoutSlot, 2);
  const baseline = empty.withSlot;
  expect(await hasLine(browser)).toBe(false);

  // A job that ends on its own leaves the line absent again.
  await sendText(browser, "JOBSTART sleep 3; echo bg-jobs-finished");
  await expect.poll(() => hasLine(browser), { timeout: 15_000 }).toBe(true);
  await expect
    .poll(async () => (await jobs(browser)).some((job) => job.status === "running"), {
      timeout: 20_000,
    })
    .toBe(false);
  await expect.poll(() => hasLine(browser), { timeout: 10_000 }).toBe(false);
  await settleDock(browser);
  expect(await statusY(browser)).toBeCloseTo(baseline, 0);
});

test("a background job chip opens a live sheet and returns focus to the composer", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");
  await expect(screen.getByTestId("working-status")).toBeVisible();
  await settleDock(browser);
  const baseline = await statusY(browser);

  const marker = `BG_JOBS_${Date.now()}`;
  await sendText(browser, `JOBSTART sleep 60; echo ${marker}`);
  await expect.poll(() => hasLine(browser), { timeout: 20_000 }).toBe(true);
  await expect(screen.getByTestId("bg-jobs-line-jobs")).toHaveText("1 job");
  expect(await boxOf(browser, "bg-jobs-line-subagents")).toBeNull();

  await settleDock(browser);
  const line = await boxOf(browser, "bg-jobs-line");
  expect(line).not.toBeNull();
  if (line !== null) {
    expect(Math.abs((await statusY(browser)) - baseline)).toBeCloseTo(line.height, 0);
  }

  // The baseline paints the status/nav row at the top of the dock. The jobs row
  // extends the composer directly beneath it, so the documented order is
  // status -> jobs -> composer body.
  const order = await browser.evaluate(() => {
    const top = (id: string) =>
      document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.getBoundingClientRect().y ?? -1;
    return {
      status: top("working-status"),
      line: top("bg-jobs-line"),
      body: top("composer-body"),
    };
  });
  expect(order.status).toBeLessThan(order.line);
  expect(order.line).toBeLessThan(order.body);

  await screen.getByTestId("bg-jobs-line-jobs").tap();
  await expect(screen.getByTestId("bg-jobs-sheet")).toBeVisible();
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
  if (running !== undefined) {
    await sendText(
      browser,
      `TOOLCALLS ${JSON.stringify([{ name: "job_cancel", arguments: { id: running.id } }])}`,
    );
  }
  await expect.poll(() => hasLine(browser), { timeout: 20_000 }).toBe(false);
  await settleDock(browser);
  expect(await statusY(browser)).toBeCloseTo(baseline, 0);
});

test("a subagent chip opens the same sheet with its task and state", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");
  await expect(screen.getByTestId("working-status")).toBeVisible();
  await settleDock(browser);
  const baseline = await statusY(browser);

  const marker = `BG_JOBS_SUBAGENT_${Date.now()}`;
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

  await expect.poll(() => hasLine(browser), { timeout: 20_000 }).toBe(true);
  await expect(screen.getByTestId("bg-jobs-line-subagents")).toHaveText("1 subagent");
  expect(await boxOf(browser, "bg-jobs-line-jobs")).toBeNull();

  await settleDock(browser);
  const line = await boxOf(browser, "bg-jobs-line");
  expect(line).not.toBeNull();
  if (line !== null) {
    expect(Math.abs((await statusY(browser)) - baseline)).toBeCloseTo(line.height, 0);
  }

  await screen.getByTestId("bg-jobs-line-subagents").tap();
  await expect(screen.getByTestId("bg-jobs-sheet")).toBeVisible();
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
  await expect.poll(() => hasLine(browser), { timeout: 30_000 }).toBe(false);
});
