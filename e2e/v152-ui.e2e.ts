import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "@e2e-dev/web";
import { expect, type Screen } from "e2e";

const FIXTURE_TITLE =
  "Design a card-based task details view that stays readable on a 390px phone and does not waste the desktop composer column";
// Written under the run's own workspace: CI checks out into a path that is not
// `/workspace`, and an absolute path there fails with EACCES in 18 ms.
const ASSET_DIR = process.env.PI_UI_ASSET_DIR ?? resolve(".e2e/assets/v152");

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
  await screen.getByRole("button", { name: `Open ${FIXTURE_TITLE}` }).tap();
  await expect(screen.getByTestId("task-detail")).toBeVisible();
}

async function waitMs(browser: { evaluate: <T>(fn: () => T | Promise<T>) => Promise<T> }) {
  await browser.evaluate(
    () => new Promise<void>((resolve) => window.setTimeout(() => resolve(), 400)),
  );
}

test("captures v152 empty states, desktop task bar, and stats separators in vantablack", {
  timeout: 300_000,
}, async ({ app, browser, screen }) => {
  const theme = resolve(".e2e/home/.config/omarchy/themes/audit-vantablack");
  await mkdir(theme, { recursive: true });
  await copyFile(resolve("themes/omarchy/vantablack/colors.toml"), resolve(theme, "colors.toml"));
  await mkdir(ASSET_DIR, { recursive: true });

  const shot = async (name: string) => {
    await waitMs(browser);
    const relative = await app.screenshot(name);
    expect(typeof relative).toBe("string");
  };

  await browser.setViewport({ width: 1280, height: 800 });
  await themeVantablack(app, browser, "/?page=chat");
  await expect(screen.getByText("Send a message to start.", { exact: true })).toBeVisible();
  await shot("chat-empty-desktop");

  await screen.getByTestId("page-dot-tasks").click();
  await expect(screen.getByTestId("tasks-page")).toHaveAttribute("data-layout", "split");
  await expect(
    screen.getByText("Select a task to see its details.", { exact: true }),
  ).toBeVisible();
  await shot("tasks-empty-desktop");

  await screen.getByTestId("page-dot-stats").click();
  await expect(screen.getByTestId("stats-page")).toBeVisible();
  await expect(screen.getByTestId("dashboard-section").first()).toBeVisible();
  await expect(screen.getByTestId("section-title").first()).toBeVisible();
  await shot("stats-page");

  await app.open("/?page=tasks&fixture=1");
  await expect
    .poll(() => browser.evaluate(() => document.documentElement.dataset.mode ?? ""))
    .toBe("dark");
  await openFixtureTask(screen);
  await expect(screen.getByTestId("task-details-bar")).toContainText("Task details");
  await expect(screen.getByTestId("task-detail-menu")).toBeVisible();
  await expect(screen.getByTestId("task-detail-back")).toBeVisible();
  await expect(screen.getByTestId("task-title")).toHaveCount(0);
  await shot("desktop-open");

  await browser.setViewport({ width: 390, height: 844 });
  await themeVantablack(app, browser, "/?page=chat");
  await expect(screen.getByText("Send a message to start.", { exact: true })).toBeVisible();
  await shot("chat-empty-mobile");

  await screen.getByTestId("page-dot-tasks").click();
  await expect(screen.getByText("No tasks yet.", { exact: true })).toBeVisible();
  await shot("tasks-empty-mobile");
});
