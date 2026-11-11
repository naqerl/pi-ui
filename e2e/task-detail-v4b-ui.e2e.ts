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

test("captures v4b desktop dock and mobile title cards in vantablack", {
  timeout: 300_000,
}, async ({ app, browser, screen }) => {
  const theme = resolve(".e2e/home/.config/omarchy/themes/audit-vantablack");
  await mkdir(theme, { recursive: true });
  await copyFile(resolve("themes/omarchy/vantablack/colors.toml"), resolve(theme, "colors.toml"));

  await browser.setViewport({ width: 1280, height: 800 });
  await themeVantablack(app, browser, "/?page=tasks&fixture=1");
  await expect(screen.getByTestId("tasks-page")).toHaveAttribute("data-layout", "split");

  // Fixture auto-opens the plan task. Photograph the mid-width dock first.
  await openFixtureTask(screen);
  await expect(screen.getByTestId("task-detail")).toBeVisible();
  await expect(screen.getByTestId("task-agent-input")).toBeVisible();
  await expect(screen.getByTestId("tasks-composer-slot")).toBeVisible();
  await expect
    .poll(() =>
      browser.evaluate(
        () => document.querySelector(".chat-shell")?.getAttribute("data-tasks-dock") ?? "",
      ),
    )
    .toBe("mid");
  await waitMs(browser);
  await app.screenshot("desktop-open");

  await browser.keyboard.press("Escape");
  await expect(screen.getByTestId("task-detail")).toHaveCount(0);
  await expect
    .poll(() =>
      browser.evaluate(
        () => document.querySelector(".chat-shell")?.getAttribute("data-tasks-dock") ?? "",
      ),
    )
    .toBe("full");
  await waitMs(browser);
  await app.screenshot("desktop-closed");

  // Mid-transition frame: reopen and capture before the 240ms linear shrink finishes.
  await openFixtureTask(screen);
  await app.screenshot("desktop-shrink-mid");
  await expect
    .poll(() =>
      browser.evaluate(
        () => document.querySelector(".chat-shell")?.getAttribute("data-tasks-dock") ?? "",
      ),
    )
    .toBe("mid");
  await waitMs(browser);
  await app.screenshot("desktop-shrink-end");

  await browser.setViewport({ width: 390, height: 844 });
  for (const variant of [1, 2, 3, 4, 5] as const) {
    await app.open(`/?page=tasks&fixture=1&titlecard=${variant}`);
    await expect
      .poll(() => browser.evaluate(() => document.documentElement.dataset.mode ?? ""))
      .toBe("dark");
    await openFixtureTask(screen);
    await expect(screen.getByTestId("task-detail")).toBeVisible();
    await expect(screen.getByTestId("task-title")).toContainText("card-based task details");
    await expect(screen.getByTestId("task-tab-plan")).toBeVisible();
    await expect(screen.getByTestId("task-tab-chat")).toBeVisible();
    await expect(screen.getByTestId("task-tab-overview")).toHaveCount(0);
    await expect(screen.getByRole("textbox", "New task")).toHaveCount(0);
    const header = await browser.evaluate(() => {
      const title = document.querySelector("[data-testid=task-title]");
      const tabs = document.querySelector("[role=tablist]");
      const headerEl = title?.closest("header");
      if (headerEl === null || headerEl === undefined || tabs === null) return null;
      const top = headerEl.getBoundingClientRect().top;
      const bottom = Math.max(
        headerEl.getBoundingClientRect().bottom,
        tabs.getBoundingClientRect().bottom,
      );
      return { height: Math.round(bottom - top), variant: headerEl.getAttribute("data-titlecard") };
    });
    expect(header?.variant).toBe(String(variant));
    await app.screenshot(`titlecard-${variant}`);
  }

  await app.open("/?page=tasks&fixture=1");
  await openFixtureTask(screen);
  await screen.getByTestId("task-tab-chat").tap();
  await expect(screen.getByTestId("task-agent-input")).toBeVisible();
  await app.screenshot("mobile-chat");
});
