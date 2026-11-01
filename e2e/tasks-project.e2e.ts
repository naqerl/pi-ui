import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { removeTasks } from "./tasks-helpers.js";

test("sets an existing or new project and clears it to No project", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 800 });
  await app.open("/?page=tasks");
  const created = await browser.evaluate(async () => {
    const post = async (body: unknown) => {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return ((await response.json()) as { tasks: Array<{ id: string; title: string }> }).tasks;
    };
    await post({ title: "Project anchor", parentId: null, project: "alpha" });
    const tasks = await post({ title: "Project target", parentId: null });
    return tasks.find((task) => task.title === "Project target")?.id ?? "";
  });
  await app.open("/?page=tasks");
  await screen.getByRole("button", { name: "Open Project target" }).click();
  const project = screen.getByRole("textbox", "Task project");
  await expect(project).toHaveValue("");
  await project.fill("alpha");
  await project.press("Enter");
  await expect(
    screen.getByTestId("task-project-alpha").getByText("Project target", { exact: true }),
  ).toBeVisible();

  await project.fill("beta");
  await project.press("Enter");
  await expect(
    screen.getByTestId("task-project-beta").getByText("Project target", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      browser.evaluate(async (taskId) => {
        const ledger = (await (await fetch("/api/tasks")).json()) as {
          tasks: Array<{ id: string; project?: string }>;
        };
        return ledger.tasks.find((task) => task.id === taskId)?.project ?? null;
      }, created),
    )
    .toBe("beta");

  await app.open("/?page=tasks");
  await screen.getByRole("button", { name: "Open Project target" }).click();
  await expect(screen.getByRole("textbox", "Task project")).toHaveValue("beta");
  const cleared = screen.getByRole("textbox", "Task project");
  await cleared.fill("");
  await cleared.press("Enter");
  await expect(
    screen.getByTestId("task-project-none").getByText("Project target", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      browser.evaluate(async (taskId) => {
        const ledger = (await (await fetch("/api/tasks")).json()) as {
          tasks: Array<{ id: string; project?: string }>;
        };
        return ledger.tasks.find((task) => task.id === taskId)?.project ?? null;
      }, created),
    )
    .toBeNull();

  await removeTasks(browser, ["Project target", "Project anchor"]);
});

test("PATCH rejects a non-string, overlong or empty field with a 400", async ({ app, browser }) => {
  await app.open("/");
  const result = await browser.evaluate(async () => {
    const create = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Validation target", parentId: null }),
    });
    const ledger = (await create.json()) as { tasks: Array<{ id: string; title: string }> };
    const id = ledger.tasks.find((task) => task.title === "Validation target")?.id ?? "";
    const patch = async (body: unknown) => {
      const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, text: await response.text() };
    };
    const notString = await patch({ body: 42 });
    const tooLong = await patch({ body: "x".repeat(20_001) });
    const emptyTitle = await patch({ title: "   " });
    const blankBody = await patch({ body: "   " });
    await fetch(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
    return { notString, tooLong, emptyTitle, blankBody };
  });
  expect(result?.notString.status).toBe(400);
  expect(result?.notString.text).toContain("body");
  expect(result?.tooLong.status).toBe(400);
  expect(result?.tooLong.text).toContain("body");
  expect(result?.emptyTitle.status).toBe(400);
  expect(result?.emptyTitle.text).toContain("title");
  expect(result?.blankBody.status).toBe(200);
});
