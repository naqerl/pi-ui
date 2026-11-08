import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("project order is stable with parked work, full labels wrap, and root counts agree", async ({
  app,
  browser,
  screen,
}) => {
  // The test HOME is isolated; install the vendored real palette, not a route mock.
  const theme = resolve(".e2e/home/.config/omarchy/themes/vantablack");
  await mkdir(theme, { recursive: true });
  await copyFile(resolve("themes/omarchy/vantablack/colors.toml"), resolve(theme, "colors.toml"));
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks");
  const seeded = await browser.evaluate(async () => {
    const themeResponse = await fetch("/api/theme", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "vantablack" }),
    });
    if (!themeResponse.ok) throw new Error(await themeResponse.text());
    const add = async (title: string, project: string | null, extra = {}) => {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, project, ...extra }),
      });
      if (!response.ok) throw new Error(await response.text());
      const ledger = await response.json();
      return ledger.tasks.find((task: { title: string }) => task.title === title).id as string;
    };
    const blocker = await add(
      "Review the complete deployment checklist before shipping the release",
      "zulu",
    );
    const release = await add("Publish the release", "zulu");
    await fetch(`/api/tasks/${release}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blockedBy: [blocker] }),
    });
    await add("Verify the release package", "zulu", { parentId: release });
    await add("Parked exploration", "alpha-with-a-very-long-name", { status: "backlog" });
    await add("Renew the domain", null);
    return true;
  });
  expect(seeded).toBe(true);
  await app.open("/?page=tasks");
  await expect
    .poll(() => browser.evaluate(() => document.documentElement.dataset.mode ?? ""))
    .toBe("dark");
  const order = () =>
    browser.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="task-project-"]')].map((node) =>
        node.getAttribute("data-testid"),
      ),
    );
  await expect
    .poll(order)
    .toEqual([
      "task-project-alpha-with-a-very-long-name",
      "task-project-zulu",
      "task-project-none",
    ]);
  const rootCount = await browser.evaluate(
    () =>
      document
        .querySelector('[data-testid="task-section-active"] > button')
        ?.textContent?.replace(/\s+/g, "") ?? "",
  );
  expect(rootCount).toBe("Open4");
  const zulu = screen.getByTestId("task-project-zulu");
  await expect(zulu).toContainText(
    "Blocked by Review the complete deployment checklist before shipping the release",
  );
  const wraps = await browser.evaluate(() => {
    const notes = [
      ...document.querySelectorAll<HTMLElement>('[data-testid="task-list"] span'),
    ].filter((node) => node.textContent?.startsWith("Blocked by "));
    return notes.some(
      (node) =>
        getComputedStyle(node).whiteSpace !== "nowrap" && node.scrollWidth <= node.clientWidth + 1,
    );
  });
  expect(wraps).toBe(true);
  await app.screenshot("tasks-audit-mobile-grouped-vantablack");
  await browser.setViewport({ width: 1280, height: 800 });
  await screen.getByRole("button", { name: "Open Publish the release", exact: true }).click();
  await expect(screen.getByTestId("task-detail")).toBeVisible();
  await app.screenshot("tasks-audit-desktop-split-vantablack");
});
