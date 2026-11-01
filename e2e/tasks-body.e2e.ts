import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

import { removeTasks } from "./tasks-helpers.js";

async function blur(browser: Browser) {
  await browser.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    return true;
  });
}

test("sets, edits and clears a task body in place that renders as markdown", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 800 });
  let patches = 0;
  await browser.route("**/api/tasks/**", async (route) => {
    if (route.request.method === "PATCH") patches += 1;
    await route.continue();
  });
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
  await expect(screen.getByTestId("task-body-edit")).toHaveCount(0);
  await expect(screen.getByRole("button", { name: "Add body" })).toHaveCount(0);
  await expect(screen.getByRole("button", { name: "Edit body" })).toHaveCount(0);

  await screen.getByTestId("task-body-section").click();
  const body = screen.getByRole("textbox", "Task body");
  await body.fill("# Route plan\n\nUse **tram 4**.\n\nKeep this line.\nAnd this one.");
  const sizing = await browser.evaluate(() => {
    const field = document.querySelector<HTMLTextAreaElement>('[data-testid="task-body-input"]');
    if (field === null) return null;
    return { scrolls: field.scrollHeight > field.clientHeight + 1 };
  });
  expect(sizing).toEqual({ scrolls: false });
  await blur(browser);
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
  await screen.getByTestId("task-body").click();
  const edited = screen.getByRole("textbox", "Task body");
  await edited.fill(
    "# Route plan\n\nUse **tram 4**.\n\nKeep this line.\nAnd this one.\n\nAdded **paragraph**.",
  );
  await blur(browser);
  await expect(
    screen.getByTestId("task-body").getByRole("heading", { name: "Route plan" }),
  ).toBeVisible();
  await expect(
    screen.getByTestId("task-body").getByText("paragraph", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByText(rationale)).toBeVisible();

  await screen.getByTestId("task-body").click();
  const escaped = screen.getByRole("textbox", "Task body");
  await escaped.fill("# Not saved");
  const beforeEscape = patches;
  await escaped.press("Escape");
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(patches).toBe(beforeEscape);
  await expect(
    screen.getByTestId("task-body").getByText("paragraph", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByTestId("task-body").getByText("Not saved")).toHaveCount(0);

  await screen.getByTestId("task-body").click();
  const cleared = screen.getByRole("textbox", "Task body");
  await cleared.fill("");
  await screen.getByTestId("task-project-input").click();
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
  await expect(screen.getByText("Write markdown…")).toBeVisible();
  await expect(screen.getByText(rationale)).toBeVisible();

  await removeTasks(browser, ["Body draft"]);
});
