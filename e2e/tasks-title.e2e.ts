import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { removeTasks } from "./tasks-helpers.js";

test("edits a task title in the detail view and refuses an empty one", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 800 });
  await app.open("/?page=tasks");
  const id = await browser.evaluate(async () => {
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Draft title", parentId: null }),
    });
    const ledger = (await response.json()) as { tasks: Array<{ id: string; title: string }> };
    return ledger.tasks.find((task) => task.title === "Draft title")?.id ?? "";
  });
  await screen.getByRole("button", { name: "Open Draft title" }).click();
  await screen.getByRole("button", { name: "Edit title Draft title" }).click();
  const title = screen.getByRole("textbox", "Task title");
  await title.fill("Corrected title");
  await title.press("Enter");
  await expect(screen.getByRole("button", { name: "Edit title Corrected title" })).toBeVisible();
  await expect(screen.getByRole("button", { name: "Open Corrected title" })).toBeVisible();
  await expect
    .poll(() =>
      browser.evaluate(async (taskId) => {
        const ledger = (await (await fetch("/api/tasks")).json()) as {
          tasks: Array<{ id: string; title: string }>;
        };
        return ledger.tasks.find((task) => task.id === taskId)?.title ?? null;
      }, id),
    )
    .toBe("Corrected title");

  await app.open("/?page=tasks");
  await expect(screen.getByRole("button", { name: "Open Corrected title" })).toBeVisible();
  await screen.getByRole("button", { name: "Open Corrected title" }).click();
  await screen.getByRole("button", { name: "Edit title Corrected title" }).click();
  const again = screen.getByRole("textbox", "Task title");
  await again.fill("   ");
  await again.press("Enter");
  await expect(screen.getByText("Title must not be empty")).toBeVisible();
  await expect(screen.getByRole("button", { name: "Edit title Corrected title" })).toBeVisible();
  await expect
    .poll(() =>
      browser.evaluate(async (taskId) => {
        const ledger = (await (await fetch("/api/tasks")).json()) as {
          tasks: Array<{ id: string; title: string }>;
        };
        return ledger.tasks.find((task) => task.id === taskId)?.title ?? null;
      }, id),
    )
    .toBe("Corrected title");

  await removeTasks(browser, ["Corrected title"]);
});
