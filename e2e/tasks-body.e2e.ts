import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { removeTasks } from "./tasks-helpers.js";

test("sets, edits and clears a task body that renders as markdown", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 800 });
  await app.open("/?page=tasks");
  const rationale = "The rationale belongs to the proposer and must survive a body edit.";
  const id = await browser.evaluate(async (why) => {
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Body draft", rationale: why, propose: true }),
    });
    const ledger = (await response.json()) as { tasks: Array<{ id: string; title: string }> };
    const task = ledger.tasks.find((item) => item.title === "Body draft");
    if (task === undefined) return "";
    await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "open" }),
    });
    return task.id;
  }, rationale);
  await app.open("/?page=tasks");
  await screen.getByRole("button", { name: "Open Body draft" }).click();
  await screen.getByRole("button", { name: "Add body" }).click();
  const body = screen.getByRole("textbox", "Task body");
  await body.fill("# Route plan\n\nUse **tram 4**.");
  await body.press("Control+Enter");
  await expect(
    screen.getByTestId("task-body").getByRole("heading", { name: "Route plan" }),
  ).toBeVisible();
  await expect(screen.getByTestId("task-body").getByText("tram 4")).toBeVisible();
  await expect(screen.getByText(rationale)).toBeVisible();

  await app.open("/?page=tasks");
  await screen.getByRole("button", { name: "Open Body draft" }).click();
  await expect(
    screen.getByTestId("task-body").getByRole("heading", { name: "Route plan" }),
  ).toBeVisible();
  await screen.getByRole("button", { name: "Edit body" }).click();
  const edited = screen.getByRole("textbox", "Task body");
  await edited.fill("## Later plan\n\nWalk instead.");
  await edited.press("Control+Enter");
  await expect(
    screen.getByTestId("task-body").getByRole("heading", { name: "Later plan" }),
  ).toBeVisible();
  await expect(screen.getByText(rationale)).toBeVisible();

  await screen.getByRole("button", { name: "Edit body" }).click();
  const cleared = screen.getByRole("textbox", "Task body");
  await cleared.fill("");
  await cleared.press("Control+Enter");
  await expect(screen.getByTestId("task-body")).toHaveCount(0);
  await expect
    .poll(() =>
      browser.evaluate(async (taskId) => {
        const ledger = (await (await fetch("/api/tasks")).json()) as {
          tasks: Array<{ id: string; body?: string; rationale?: string }>;
        };
        const task = ledger.tasks.find((item) => item.id === taskId);
        return { body: task?.body ?? null, rationale: task?.rationale ?? null };
      }, id),
    )
    .toEqual({ body: null, rationale });

  await app.open("/?page=tasks");
  await screen.getByRole("button", { name: "Open Body draft" }).click();
  await expect(screen.getByTestId("task-body")).toHaveCount(0);
  await expect(screen.getByText(rationale)).toBeVisible();

  await removeTasks(browser, ["Body draft"]);
});
