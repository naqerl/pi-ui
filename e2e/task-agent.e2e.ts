import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createOpenTask, openTaskChatTab } from "./tasks-helpers";

test("the plus button creates a task and opens its planning chat", { timeout: 180_000 }, async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks");
  await expect(screen.getByRole("textbox", "New task")).toBeVisible();
  await expect(screen.getByRole("textbox", "Message")).toHaveCount(0);

  const title = `Design the inbox ${Date.now()}`;
  await createOpenTask(screen, title, { project: "pi-ui" });
  await expect(screen.getByTestId("task-detail")).toBeVisible();
  await expect(screen.getByTestId("task-title")).toContainText(title);
  await expect(screen.getByTestId("task-header-project")).toHaveText("@pi-ui");
  await openTaskChatTab(screen);
  await expect(screen.getByTestId("task-agent-chat")).toBeVisible();
  await expect(
    screen.getByTestId("task-agent-transcript").getByText(title, { exact: true }),
  ).toBeVisible();

  const reply = browser.locator('[data-testid="task-agent-chat"] [data-role="assistant"]');
  await expect(reply).toBeVisible({ timeout: 30_000 });
  await expect(reply).toContainText("Echo:");

  const stored = await browser.evaluate(async (taskTitle) => {
    const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
      tasks: Array<{ title: string; project?: string }>;
    };
    const task = ledger.tasks.find((item) => item.title === taskTitle);
    return { project: task?.project ?? null, title: task?.title ?? null };
  }, title);
  expect(stored).toEqual({ project: "pi-ui", title });
});
