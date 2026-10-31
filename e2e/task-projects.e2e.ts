import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

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
  const composer = screen.getByRole("textbox", "New task");
  await expect(composer).toBeVisible();
  // No project pickers: @ in the title is the only way to set one.
  await expect(screen.getByTestId("composer-project")).toHaveCount(0);
  await expect(screen.getByTestId("task-project-filter")).toHaveCount(0);

  // An unknown name offers a new project; Enter accepts it, then Enter submits.
  await composer.tap();
  await browser.keyboard.type("Diff the maps @citydiff");
  const suggestions = screen.getByTestId("project-suggestions");
  await expect(screen.getByTestId("project-suggestion-citydiff")).toBeVisible();
  await browser.keyboard.press("Enter");
  await expect(suggestions).toHaveCount(0);
  await expect(composer).toHaveValue("Diff the maps @citydiff ");
  await browser.keyboard.press("Enter");
  await expect(screen.getByText("Diff the maps", { exact: true })).toBeVisible();
  await expect(composer).toHaveValue("");

  // Without @ a task has no project, whatever was used last.
  await composer.fill("Loose end");
  await screen.getByRole("button", "Add task").tap();
  await expect(screen.getByText("Loose end", { exact: true })).toBeVisible();

  // @ lists the known projects, filtered as you type.
  await composer.tap();
  await browser.keyboard.type("Fix the login @ci");
  await expect(suggestions).toBeVisible();
  await expect(screen.getByTestId("project-suggestion-citydiff")).toBeVisible();
  await browser.keyboard.press("Enter");
  await expect(composer).toHaveValue("Fix the login @citydiff ");
  await browser.keyboard.press("Enter");
  await expect(screen.getByText("Fix the login", { exact: true })).toBeVisible();

  // A tap accepts a suggestion too.
  await composer.tap();
  await browser.keyboard.type("Write the docs @zero");
  await screen.getByTestId("project-suggestion-zero").tap();
  await expect(composer).toHaveValue("Write the docs @zero ");
  await screen.getByRole("button", "Add task").tap();
  await expect(screen.getByText("Write the docs", { exact: true })).toBeVisible();

  // Escape closes the list and keeps the text.
  await composer.tap();
  await browser.keyboard.type("Draft @c");
  await expect(suggestions).toBeVisible();
  await browser.keyboard.press("Escape");
  await expect(suggestions).toHaveCount(0);
  await expect(composer).toHaveValue("Draft @c");
  await composer.fill("");

  const citydiff = screen.getByTestId("task-project-citydiff");
  await expect(citydiff).toBeVisible();
  await expect(citydiff).toContainText("citydiff");
  await expect(citydiff.getByText("Diff the maps", { exact: true })).toBeVisible();
  await expect(citydiff.getByText("Fix the login", { exact: true })).toBeVisible();
  await expect(
    screen.getByTestId("task-project-zero").getByText("Write the docs", { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByTestId("task-project-none").getByText("Loose end", { exact: true }),
  ).toBeVisible();
  const order = await browser.evaluate(() =>
    [...document.querySelectorAll("[data-testid^='task-project-']")]
      .map((item) => item.getAttribute("data-testid"))
      .filter((id) => id !== "task-project-line"),
  );
  expect(order).toEqual(["task-project-citydiff", "task-project-zero", "task-project-none"]);

  await removeTasks(browser, ["Diff the maps", "Loose end", "Fix the login", "Write the docs"]);
});

test("subtasks take their parent's project and the detail shows it as text", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 800 });
  await app.open("/?page=tasks");
  for (const [title, project] of [
    ["Ship the panel", "pi-ui"],
    ["Diff the tram routes", "citydiff"],
    ["Water the plants", null],
  ] as const) {
    const ok = await browser.evaluate(
      async ([taskTitle, taskProject]) => {
        const response = await fetch("/api/tasks", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: taskTitle, parentId: null, project: taskProject }),
        });
        return response.ok;
      },
      [title, project] as const,
    );
    expect(ok).toBe(true);
  }
  await app.open("/?page=tasks");
  await expect(screen.getByText("Water the plants", { exact: true })).toBeVisible();

  await screen.getByRole("button", { name: "Open Diff the tram routes" }).click();
  const line = screen.getByTestId("task-project-line");
  await expect(line).toContainText("citydiff");
  await expect(screen.getByTestId("task-project")).toHaveCount(0);

  await screen.getByRole("button", { name: "Subtask" }).click();
  await screen.getByRole("textbox", "New subtask").fill("Map the stops");
  await screen.getByRole("button", "Add task").click();
  await expect(
    screen.getByTestId("task-project-citydiff").getByText("Map the stops", { exact: true }),
  ).toBeVisible();
  await screen.getByRole("button", { name: "Open Map the stops" }).click();
  await expect(screen.getByTestId("task-project-line")).toContainText("citydiff");

  await screen.getByRole("button", { name: "Open Water the plants" }).click();
  await expect(screen.getByTestId("task-project-line")).toHaveCount(0);

  await removeTasks(browser, [
    "Map the stops",
    "Ship the panel",
    "Diff the tram routes",
    "Water the plants",
  ]);
});
