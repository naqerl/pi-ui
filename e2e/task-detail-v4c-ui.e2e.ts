import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "@e2e-dev/web";
import { expect, type Screen } from "e2e";
import { openTaskProject } from "./tasks-helpers";

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

test("captures v4c header, project dropdown, and merged dock in vantablack", {
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
  await expect(screen.getByTestId("task-header")).toBeVisible();
  await expect(screen.getByTestId("task-detail-back")).toHaveAttribute("aria-label", "Close");
  await expect(screen.getByTestId("task-header-project")).toBeVisible();
  await expect(screen.getByTestId("task-agent-input")).toBeVisible();
  await expect(screen.getByTestId("task-composer-slot")).toBeVisible();
  await expect(screen.getByTestId("tasks-composer-slot")).toHaveCount(0);
  await waitMs(browser);
  await app.screenshot("desktop-open");

  await browser.keyboard.press("Escape");
  await expect(screen.getByTestId("task-detail")).toHaveCount(0);
  await expect(screen.getByRole("textbox", "New task")).toBeVisible();
  await waitMs(browser);
  await app.screenshot("desktop-closed");

  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks&fixture=1");
  await expect
    .poll(() => browser.evaluate(() => document.documentElement.dataset.mode ?? ""))
    .toBe("dark");
  await openFixtureTask(screen);
  await expect(screen.getByTestId("task-detail")).toBeVisible();
  await expect(screen.getByTestId("task-header")).toBeVisible();
  await expect(screen.getByTestId("task-detail-back")).toHaveAttribute("aria-label", "Close");
  await expect(screen.getByTestId("task-tab-plan")).toHaveAttribute("aria-selected", "true");
  await expect(screen.getByRole("textbox", "New task")).toHaveCount(0);
  await waitMs(browser);
  await app.screenshot("mobile-plan");

  await openTaskProject(screen);
  await expect(screen.getByTestId("task-project-menu")).toBeVisible();
  await waitMs(browser);
  await app.screenshot("mobile-project-dropdown");
  await browser.keyboard.press("Escape");
  await expect(screen.getByTestId("task-project-menu")).toHaveCount(0);

  await screen.getByTestId("task-tab-chat").tap();
  await expect(screen.getByTestId("task-agent-chat")).toBeVisible();
  await expect(screen.getByTestId("task-agent-input")).toBeVisible();
  await waitMs(browser);
  await app.screenshot("mobile-chat");
});
