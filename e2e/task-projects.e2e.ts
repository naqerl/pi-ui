import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { backToTaskList, createOpenTask, openNewTaskComposer, setPlanDraft } from "./tasks-helpers";

// The e2e server and its task store are shared by every test file: leave no projects behind.
async function removeTasks(browser: Browser, titles: readonly string[]) {
  const left = await browser.evaluate(async (names) => {
    const matching = async () =>
      (
        (await (await fetch("/api/tasks")).json()).tasks as Array<{ id: string; title: string }>
      ).filter((task) => names.includes(task.title));
    // Removing a parent removes its subtasks, so later deletes may find nothing.
    for (const task of await matching()) {
      await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
    }
    return (await matching()).length;
  }, titles);
  expect(left).toBe(0);
}

test("@ tags new tasks with a project and open work is grouped by project", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks");
  await expect(screen.getByRole("textbox", "New task")).toBeVisible();
  // This spec is about ordinary open work, not the default plan draft.
  await setPlanDraft(screen, false);
  const taskList = screen.getByTestId("task-list");
  // A just-added task can appear as both its optimistic row and the settled row
  // for a moment; wait for exactly one visible match instead of sampling both.
  const expectTaskTitle = async (title: string, scope = taskList) => {
    const matches = scope.getByText(title, { exact: true });
    await expect.poll(() => matches.count(), { timeout: 15_000 }).toBe(1);
    await expect(matches).toBeVisible();
  };
  // No project pickers: @ in the first message is the only way to set one at create time.
  await expect(screen.getByTestId("composer-project")).toHaveCount(0);
  await expect(screen.getByTestId("task-project-filter")).toHaveCount(0);

  // An unknown name offers a new project; Enter accepts it, then Enter submits.
  let composer = await openNewTaskComposer(screen);
  await composer.tap();
  await browser.keyboard.type("Diff the maps @citydiff");
  const suggestions = screen.getByTestId("project-suggestions");
  await expect(screen.getByTestId("project-suggestion-citydiff")).toBeVisible();
  await browser.keyboard.press("Enter");
  await expect(suggestions).toHaveCount(0);
  await expect(composer).toHaveValue("Diff the maps @citydiff ");
  await browser.keyboard.press("Enter");
  // A loaded runner can receive the create response before the detail paints.
  await expect(screen.getByTestId("task-title")).toContainText("Diff the maps", {
    timeout: 15_000,
  });
  await backToTaskList(screen);
  composer = await openNewTaskComposer(screen);
  await expect(composer).toHaveValue("");
  await expectTaskTitle("Diff the maps");

  // Without @ a task has no project, whatever was used last.
  await createOpenTask(screen, "Loose end");
  await backToTaskList(screen);
  await expectTaskTitle("Loose end");

  // @ lists the known projects, filtered as you type.
  composer = await openNewTaskComposer(screen);
  await composer.tap();
  await browser.keyboard.type("Fix the login @ci");
  await expect(suggestions).toBeVisible();
  await expect(screen.getByTestId("project-suggestion-citydiff")).toBeVisible();
  await browser.keyboard.press("Enter");
  await expect(composer).toHaveValue("Fix the login @citydiff ");
  await browser.keyboard.press("Enter");
  await expect(screen.getByTestId("task-title")).toContainText("Fix the login", {
    timeout: 15_000,
  });
  await backToTaskList(screen);
  await expectTaskTitle("Fix the login");

  // A tap accepts a suggestion too.
  composer = await openNewTaskComposer(screen);
  await composer.tap();
  await browser.keyboard.type("Write the docs @zero");
  await screen.getByTestId("project-suggestion-zero").tap();
  await expect(composer).toHaveValue("Write the docs @zero ");
  await screen.getByRole("button", "Add task").tap();
  await expect(screen.getByTestId("task-title")).toContainText("Write the docs", {
    timeout: 15_000,
  });
  await backToTaskList(screen);
  await expectTaskTitle("Write the docs");

  // Escape closes the list and keeps the text.
  composer = await openNewTaskComposer(screen);
  await composer.tap();
  await browser.keyboard.type("Draft @c");
  await expect(suggestions).toBeVisible();
  await browser.keyboard.press("Escape");
  await expect(suggestions).toHaveCount(0);
  await expect(composer).toHaveValue("Draft @c");
  await composer.fill("");
  await backToTaskList(screen);

  const citydiff = screen.getByTestId("task-project-citydiff");
  await expect(citydiff).toBeVisible();
  await expect(citydiff).toContainText("citydiff");
  await expectTaskTitle("Diff the maps", citydiff);
  await expectTaskTitle("Fix the login", citydiff);
  await expectTaskTitle("Write the docs", screen.getByTestId("task-project-zero"));
  await expectTaskTitle("Loose end", screen.getByTestId("task-project-none"));
  // The optimistic rows render before the server ledger lands; poll the group
  // order so the assertion sees the settled grouping rather than a transient.
  await expect
    .poll(
      () =>
        browser.evaluate(() =>
          [...document.querySelectorAll("[data-testid^='task-project-']")]
            .map((item) => item.getAttribute("data-testid"))
            .filter(
              (id) =>
                id !== "task-project-line" &&
                id !== "task-project-menu" &&
                id !== "task-project-input" &&
                id !== "task-project-clear",
            ),
        ),
      { timeout: 15_000 },
    )
    .toEqual(["task-project-citydiff", "task-project-zero", "task-project-none"]);

  await removeTasks(browser, ["Diff the maps", "Loose end", "Fix the login", "Write the docs"]);
});
