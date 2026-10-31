import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("tags new tasks with a project from the chip or an @ autocomplete and groups them", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks");
  const composer = screen.getByRole("textbox", "New task");
  const chip = screen.getByTestId("composer-project");
  await expect(composer).toBeVisible();
  await expect(chip).toHaveValue("");

  // A new project from the chip.
  await chip.selectOption({ value: "__new__" });
  const name = screen.getByTestId("composer-project-new");
  await name.fill("citydiff");
  await browser.keyboard.press("Enter");
  await expect(chip).toHaveValue("citydiff");
  await composer.fill("Diff the maps");
  await screen.getByRole("button", "Add task").tap();
  await expect(screen.getByText("Diff the maps", { exact: true })).toBeVisible();

  // The last project used stays the default; "No project" is one pick away.
  await expect(chip).toHaveValue("citydiff");
  await chip.selectOption({ value: "" });
  await composer.fill("Loose end");
  await screen.getByRole("button", "Add task").tap();
  await expect(screen.getByText("Loose end", { exact: true })).toBeVisible();

  // @ opens the known projects, filtered as you type; Enter accepts, not submits.
  await composer.tap();
  await browser.keyboard.type("Fix the login @ci");
  const suggestions = screen.getByTestId("project-suggestions");
  await expect(suggestions).toBeVisible();
  await expect(screen.getByTestId("project-suggestion-citydiff")).toBeVisible();
  await browser.keyboard.press("Enter");
  await expect(suggestions).toHaveCount(0);
  await expect(composer).toHaveValue("Fix the login @citydiff ");
  await expect(chip).toHaveValue("citydiff");
  await browser.keyboard.press("Enter");
  await expect(screen.getByText("Fix the login", { exact: true })).toBeVisible();
  await expect(composer).toHaveValue("");

  // An unknown name offers a new project; a tap accepts it.
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
      .filter((id) => id !== "task-project-filter"),
  );
  expect(order).toEqual(["task-project-citydiff", "task-project-zero", "task-project-none"]);

  // The detail edits the project with the same picker.
  await screen.getByRole("button", { name: "Open Loose end" }).tap();
  const detailProject = screen.getByTestId("task-project");
  await expect(detailProject).toHaveValue("");
  await detailProject.selectOption({ value: "zero" });
  await expect(detailProject).toHaveValue("zero");
});

test("the project filter narrows the list and sets the composer's default", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 800 });
  await app.open("/?page=tasks");
  for (const [title, project] of [
    ["Ship the panel", "pi-ui"],
    ["Diff the maps", "citydiff"],
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

  const filter = screen.getByTestId("task-project-filter");
  await filter.selectOption({ value: "project:pi-ui" });
  await expect(screen.getByText("Ship the panel", { exact: true })).toBeVisible();
  await expect(screen.getByText("Diff the maps", { exact: true })).toHaveCount(0);
  await expect(screen.getByTestId("task-project-pi-ui")).toHaveCount(0);
  await expect(screen.getByTestId("composer-project")).toHaveValue("pi-ui");

  await screen.getByRole("textbox", "New task").fill("Tighten the spacing");
  await screen.getByRole("button", "Add task").tap();
  await expect(screen.getByText("Tighten the spacing", { exact: true })).toBeVisible();

  await filter.selectOption({ value: "none" });
  await expect(screen.getByText("Water the plants", { exact: true })).toBeVisible();
  await expect(screen.getByText("Ship the panel", { exact: true })).toHaveCount(0);
  await expect(screen.getByTestId("composer-project")).toHaveValue("");

  await filter.selectOption({ value: "all" });
  await expect(
    screen.getByTestId("task-project-pi-ui").getByText("Tighten the spacing", { exact: true }),
  ).toBeVisible();
});
