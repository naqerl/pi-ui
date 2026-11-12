import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "@e2e-dev/web";
import { expect, type Screen } from "e2e";

const FIXTURE_TITLE =
  "Design a card-based task details view that stays readable on a 390px phone and does not waste the desktop composer column";

async function themeVantablack(
  app: { open: (url: string) => Promise<void> },
  browser: { evaluate: <T>(fn: () => T | Promise<T>) => Promise<T> },
  path: string,
) {
  await app.open(path);
  const themed = await browser.evaluate(async () => {
    const themeResponse = await fetch("/api/theme", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "audit-vantablack" }),
    });
    if (!themeResponse.ok) throw new Error(await themeResponse.text());
    return true;
  });
  expect(themed).toBe(true);
  await app.open(path);
  await expect
    .poll(() => browser.evaluate(() => document.documentElement.dataset.mode ?? ""))
    .toBe("dark");
}

async function openFixtureTask(screen: Pick<Screen, "getByTestId" | "getByRole">) {
  const detail = screen.getByTestId("task-detail");
  if ((await detail.count()) === 0) {
    await screen.getByRole("button", { name: `Open ${FIXTURE_TITLE}` }).tap();
  }
}

async function waitMs(browser: { evaluate: <T>(fn: () => T | Promise<T>) => Promise<T> }) {
  await browser.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(true), 280);
      }),
  );
}

async function dockBox(browser: { evaluate: <T>(fn: () => T | Promise<T>) => Promise<T> }) {
  return browser.evaluate(() => {
    const dock = document.querySelector<HTMLElement>('[data-testid="composer-dock"]');
    const shell = document.querySelector(".chat-shell");
    if (!(dock instanceof HTMLElement)) return null;
    const box = dock.getBoundingClientRect();
    const style = getComputedStyle(dock);
    return {
      left: Math.round(box.left),
      width: Math.round(box.width),
      position: style.position,
      transition: style.transition,
      dockAttr: shell?.getAttribute("data-tasks-dock") ?? null,
    };
  });
}

test("captures v4e unsunk dock, header row, and full-width mobile cards in vantablack", {
  timeout: 300_000,
}, async ({ app, browser, screen }) => {
  const theme = resolve(".e2e/home/.config/omarchy/themes/audit-vantablack");
  await mkdir(theme, { recursive: true });
  await copyFile(resolve("themes/omarchy/vantablack/colors.toml"), resolve(theme, "colors.toml"));

  await browser.setViewport({ width: 1280, height: 800 });
  await themeVantablack(app, browser, "/?page=tasks&fixture=1");
  await expect(screen.getByTestId("tasks-page")).toHaveAttribute("data-layout", "split");
  await openFixtureTask(screen);
  await expect(screen.getByTestId("task-detail")).toBeVisible();
  await expect(screen.getByTestId("task-times")).toContainText("Created");
  await expect(screen.getByTestId("task-created-by")).toHaveCount(0);
  await expect(screen.getByTestId("task-blockers-card")).toBeVisible();
  await expect(screen.getByTestId("task-subtasks-card")).toBeVisible();
  await expect(screen.getByTestId("task-plan-card")).toBeVisible();
  await expect(screen.getByTestId("task-plan-card").getByText("Plan", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    screen.getByTestId("task-subtasks-card").getByText("Done", { exact: true }),
  ).toHaveCount(0);
  const headerOrder = await browser.evaluate(() => {
    const meta = document.querySelector("[data-testid=task-header-meta]");
    const title = document.querySelector("[data-testid=task-title]");
    const times = document.querySelector("[data-testid=task-times]");
    if (
      !(meta instanceof HTMLElement) ||
      !(title instanceof HTMLElement) ||
      !(times instanceof HTMLElement)
    ) {
      return null;
    }
    return {
      titleAfterMeta: !!(meta.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING),
      timesAfterTitle: !!(title.compareDocumentPosition(times) & Node.DOCUMENT_POSITION_FOLLOWING),
    };
  });
  expect(headerOrder).toEqual({ titleAfterMeta: true, timesAfterTitle: true });
  await expect(screen.getByTestId("task-agent-input")).toBeVisible();
  await expect(screen.getByRole("textbox", "New task")).toHaveCount(0);
  const openDock = await dockBox(browser);
  expect(openDock?.dockAttr).toBeNull();
  expect(openDock?.position).not.toBe("absolute");
  expect(openDock?.transition ?? "").not.toMatch(/left|width/);
  await waitMs(browser);
  await app.screenshot("desktop-open");

  await screen.getByTestId("task-detail-back").tap();
  await expect(screen.getByTestId("task-detail")).toHaveCount(0);
  await expect(screen.getByRole("textbox", "New task")).toBeVisible();
  const closedDock = await dockBox(browser);
  expect(closedDock).toEqual(openDock);
  await waitMs(browser);
  await app.screenshot("desktop-closed");

  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks&fixture=1");
  await expect
    .poll(() => browser.evaluate(() => document.documentElement.dataset.mode ?? ""))
    .toBe("dark");
  await openFixtureTask(screen);
  await expect(screen.getByTestId("task-detail")).toBeVisible();
  await expect(screen.getByTestId("task-tab-plan")).toHaveAttribute("aria-selected", "true");
  await expect(screen.getByTestId("task-blockers-card")).toBeVisible();
  await expect(screen.getByTestId("task-subtasks-card")).toBeVisible();
  await expect(screen.getByTestId("task-agent-input")).toBeVisible();
  const mobileChrome = await browser.evaluate(() => {
    const detail = document.querySelector<HTMLElement>("[data-testid=task-detail]");
    const header = document.querySelector<HTMLElement>("[data-testid=task-header]");
    const blockers = document.querySelector<HTMLElement>("[data-testid=task-blockers-card]");
    const subtasks = document.querySelector<HTMLElement>("[data-testid=task-subtasks-card]");
    const plan = document.querySelector<HTMLElement>("[data-testid=task-plan-card]");
    const tabs = document.querySelector<HTMLElement>("[role=tablist]");
    if (
      detail === null ||
      header === null ||
      blockers === null ||
      subtasks === null ||
      plan === null ||
      tabs === null
    ) {
      return null;
    }
    const detailBox = detail.getBoundingClientRect();
    const headerBox = header.getBoundingClientRect();
    const tabsBox = tabs.getBoundingClientRect();
    const widths = [header, blockers, subtasks, plan].map((node) =>
      Math.round(node.getBoundingClientRect().width),
    );
    return {
      widths,
      sameWidth: widths.every((width) => width === widths[0]),
      tabsFlushLeft: Math.abs(tabsBox.left - headerBox.left) <= 1,
      tabsFlushRight: Math.abs(tabsBox.right - headerBox.right) <= 1,
      tabsFlushBottom: Math.abs(tabsBox.bottom - headerBox.bottom) <= 1,
      gutter: Math.round(headerBox.left - detailBox.left),
      gap: Math.round(blockers.getBoundingClientRect().top - headerBox.bottom),
    };
  });
  expect(mobileChrome?.sameWidth).toBe(true);
  expect(mobileChrome?.tabsFlushLeft).toBe(true);
  expect(mobileChrome?.tabsFlushRight).toBe(true);
  expect(mobileChrome?.tabsFlushBottom).toBe(true);
  expect(mobileChrome?.gutter).toBe(mobileChrome?.gap);
  await waitMs(browser);
  await app.screenshot("mobile-plan");

  await screen.getByTestId("task-tab-chat").tap();
  await expect(screen.getByTestId("task-tab-chat")).toHaveAttribute("aria-selected", "true");
  await expect(screen.getByTestId("task-agent-chat")).toBeVisible();
  await waitMs(browser);
  await app.screenshot("mobile-chat");
});
