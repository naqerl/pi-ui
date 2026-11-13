import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { parseNotice } from "../src/shared/notices";
import { chevronMeasurement } from "./activity-helpers";

const at = (second: number) => new Date(Date.UTC(2026, 9, 30, 9, 0, second)).toISOString();

function jobText(id: string, duration: string, name: string): string {
  return [
    `[background job ${id} finished] ${id} exited 0 after ${duration}: ${name}`,
    `Command: npm run ${name}`,
    "Last output:",
    "```",
    "ok",
    "```",
  ].join("\n");
}

function message(id: string, text: string, order: number) {
  const notice = parseNotice(text);
  return {
    id,
    role: "user",
    text,
    timestamp: at(order),
    order,
    ...(notice === null ? {} : { notice }),
  };
}

const snapshot = {
  conversationId: "activity-chevron-e2e",
  messages: [
    message("job-a", jobText("j12", "1m 23s", "build"), 20_000),
    message("job-b", jobText("j13", "41.0s", "test"), 30_000),
  ],
  activity: [],
  run: "idle",
  queue: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
  context: { tokens: 0, window: null, percent: null },
};

const wrappedSnapshot = {
  ...snapshot,
  conversationId: "activity-chevron-wrapped-e2e",
  messages: [
    message(
      "job-long",
      jobText(
        "j14",
        "1m 23s",
        "build-with-a-summary-long-enough-to-wrap-onto-several-lines-on-a-phone",
      ),
      20_000,
    ),
  ],
};

const rowState = (browser: Parameters<typeof chevronMeasurement>[0], index: number) =>
  browser.evaluate(
    (rowIndex) =>
      document
        .querySelectorAll<HTMLElement>('[data-testid="activity-job"]')
        [rowIndex]?.closest("[data-state]")
        ?.getAttribute("data-state") ?? null,
    index,
  );

const openRow = (browser: Parameters<typeof chevronMeasurement>[0], index: number) =>
  browser.evaluate((rowIndex) => {
    document.querySelectorAll<HTMLElement>('[data-testid="activity-job"]')[rowIndex]?.click();
    return null;
  }, index);

test("the activity chevron sits on its summary's cap-height centre", async ({ app, browser }) => {
  await browser.setViewport({ width: 800, height: 844 });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: JSON.parse(JSON.stringify(snapshot)) });
  });
  await app.open("/activity");
  await expect
    .poll(
      () =>
        browser.evaluate(() => document.querySelectorAll('[data-testid="activity-job"]').length),
      { timeout: 10_000 },
    )
    .toBe(2);

  const collapsed = await chevronMeasurement(browser, "activity-job");
  expect(collapsed.wrapped).toBe(false);
  expect(Math.abs(collapsed.gap)).toBeLessThanOrEqual(0.5);
  await app.screenshot("activity-chevron-collapsed");

  await openRow(browser, 0);
  await expect.poll(() => rowState(browser, 0), { timeout: 5_000 }).toBe("open");
  const expanded = await chevronMeasurement(browser, "activity-job");
  expect(Math.abs(expanded.gap)).toBeLessThanOrEqual(0.5);
  expect(Math.abs(expanded.gap - collapsed.gap)).toBeLessThanOrEqual(0.5);
  // Opening the panel changes the card below the trigger, never the row itself.
  expect(expanded.rowHeight).toBe(collapsed.rowHeight);
  await app.screenshot("activity-chevron-expanded");

  // CSS zoom scales both the text metrics and the rect; a fixed translate must
  // stay on the optical centre there too.
  await browser.evaluate(() => {
    document.documentElement.style.zoom = "1.25";
    return null;
  });
  const zoomedExpanded = await chevronMeasurement(browser, "activity-job");
  expect(Math.abs(zoomedExpanded.gap)).toBeLessThanOrEqual(1);

  await openRow(browser, 0);
  await expect.poll(() => rowState(browser, 0), { timeout: 5_000 }).toBe("closed");
  const zoomedCollapsed = await chevronMeasurement(browser, "activity-job");
  expect(Math.abs(zoomedCollapsed.gap)).toBeLessThanOrEqual(1);
  expect(zoomedCollapsed.rowHeight).toBe(zoomedExpanded.rowHeight);
});

test("a wrapped activity summary keeps the chevron on its block centre", async ({
  app,
  browser,
}) => {
  await browser.setViewport({ width: 320, height: 844 });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: JSON.parse(JSON.stringify(wrappedSnapshot)) });
  });
  await app.open("/activity");
  await expect
    .poll(
      () =>
        browser.evaluate(() => document.querySelectorAll('[data-testid="activity-job"]').length),
      { timeout: 10_000 },
    )
    .toBe(1);

  const collapsed = await chevronMeasurement(browser, "activity-job");
  expect(collapsed.wrapped).toBe(true);
  expect(collapsed.targetCentreY).toBe(collapsed.textBlockCentreY);
  expect(Math.abs(collapsed.gap)).toBeLessThanOrEqual(0.5);

  await openRow(browser, 0);
  await expect.poll(() => rowState(browser, 0), { timeout: 5_000 }).toBe("open");
  const expanded = await chevronMeasurement(browser, "activity-job");
  expect(expanded.wrapped).toBe(true);
  expect(Math.abs(expanded.gap)).toBeLessThanOrEqual(0.5);
  expect(expanded.rowHeight).toBe(collapsed.rowHeight);
});
