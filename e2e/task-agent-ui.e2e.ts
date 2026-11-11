import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("captures the tasks page and embedded planning chat in vantablack", async ({
  app,
  browser,
  screen,
}) => {
  const theme = resolve(".e2e/home/.config/omarchy/themes/audit-vantablack");
  await mkdir(theme, { recursive: true });
  await copyFile(resolve("themes/omarchy/vantablack/colors.toml"), resolve(theme, "colors.toml"));
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks");
  const seeded = await browser.evaluate(async () => {
    const themeResponse = await fetch("/api/theme", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "audit-vantablack" }),
    });
    if (!themeResponse.ok) throw new Error(await themeResponse.text());
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Design the notification inbox",
        project: "pi-ui",
        body: [
          "Capture mentions in one place.",
          "",
          "```mermaid",
          "flowchart LR",
          "  Event --> Queue --> Inbox",
          "```",
        ].join("\n"),
      }),
    });
    if (!response.ok) throw new Error(await response.text());
    return true;
  });
  expect(seeded).toBe(true);
  await app.open("/?page=tasks");
  await expect
    .poll(() => browser.evaluate(() => document.documentElement.dataset.mode ?? ""))
    .toBe("dark");
  await expect(screen.getByRole("textbox", "New task")).toBeVisible();
  await expect(
    screen.getByTestId("task-list").getByText("Design the notification inbox"),
  ).toBeVisible();
  await app.screenshot("tasks-agent-mobile-list-vantablack");

  await screen.getByRole("button", { name: "Open Design the notification inbox" }).tap();
  await expect(screen.getByTestId("task-agent-chat")).toBeVisible();
  await expect(screen.getByTestId("markdown-diagram")).toBeVisible({ timeout: 15_000 });
  const input = screen.getByTestId("task-agent-input");
  await input.fill("Add a mute switch to the design.");
  await screen.getByTestId("task-agent-send").tap();
  await expect(
    screen.getByTestId("task-agent-transcript").getByText("Add a mute switch to the design."),
  ).toBeVisible();
  await expect(
    browser.locator('[data-testid="task-agent-chat"] [data-role="assistant"]'),
  ).toBeVisible({
    timeout: 30_000,
  });
  await app.screenshot("tasks-agent-mobile-detail-vantablack");

  await browser.setViewport({ width: 1280, height: 800 });
  await expect(screen.getByTestId("task-detail")).toBeVisible();
  await expect(screen.getByTestId("task-agent-chat")).toBeVisible();
  await app.screenshot("tasks-agent-desktop-split-vantablack");
});
