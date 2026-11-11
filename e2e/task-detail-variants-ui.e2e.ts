import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("captures five task-detail variants in vantablack", { timeout: 300_000 }, async ({
  app,
  browser,
  screen,
}) => {
  const theme = resolve(".e2e/home/.config/omarchy/themes/audit-vantablack");
  await mkdir(theme, { recursive: true });
  await copyFile(resolve("themes/omarchy/vantablack/colors.toml"), resolve(theme, "colors.toml"));

  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks&fixture=1&variant=1");
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
  await app.open("/?page=tasks&fixture=1&variant=1");
  await expect
    .poll(() => browser.evaluate(() => document.documentElement.dataset.mode ?? ""))
    .toBe("dark");

  for (const variant of [1, 2, 3, 4, 5]) {
    await app.open(`/?page=tasks&fixture=1&variant=${variant}`);
    const detail = screen.getByTestId("task-detail");
    if ((await detail.count()) === 0) {
      await screen
        .getByRole(
          "button",
          "Open Design a card-based task details view that stays readable on a 390px phone and does not waste the desktop composer column",
        )
        .tap();
    }
    await expect(detail).toBeVisible();
    await expect(screen.getByTestId("task-title")).toContainText("card-based task details");
    if (variant === 2) {
      await expect(screen.getByTestId("task-tab-plan")).toBeVisible();
      await expect(screen.getByTestId("task-tab-chat")).toBeVisible();
    } else {
      await expect(screen.getByTestId("task-agent-input")).toBeVisible();
    }
    await expect(screen.getByRole("textbox", "New task")).toHaveCount(0);
    const diagram = screen.getByTestId("markdown-diagram");
    if ((await diagram.count()) > 0) {
      await expect(diagram).toBeVisible({ timeout: 15_000 });
    }
    await expect
      .poll(async () => browser.evaluate(() => document.documentElement.dataset.mode ?? ""))
      .toBe("dark");
    await app.screenshot(`v${variant}-mobile`);
  }

  await browser.setViewport({ width: 1280, height: 800 });
  for (const variant of [1, 2, 3, 4, 5]) {
    await app.open(`/?page=tasks&fixture=1&variant=${variant}`);
    const detail = screen.getByTestId("task-detail");
    if ((await detail.count()) === 0) {
      await screen
        .getByRole(
          "button",
          "Open Design a card-based task details view that stays readable on a 390px phone and does not waste the desktop composer column",
        )
        .tap();
    }
    await expect(detail).toBeVisible();
    await expect(screen.getByTestId("task-title")).toContainText("card-based task details");
    await expect(screen.getByTestId("tasks-composer-slot")).toBeVisible();
    await expect(screen.getByRole("textbox", "New task")).toBeVisible();
    if (variant === 2) {
      await expect(screen.getByTestId("task-tab-chat")).toBeVisible();
    } else {
      await expect(screen.getByTestId("task-agent-input")).toBeVisible();
    }
    const diagram = screen.getByTestId("markdown-diagram");
    if ((await diagram.count()) > 0) {
      await expect(diagram).toBeVisible({ timeout: 15_000 });
    }
    await app.screenshot(`v${variant}-desktop`);
  }
});
