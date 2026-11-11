import type { Browser } from "@e2e-dev/web";
import { expect, type Locator } from "e2e";

/** Deletes the named tasks and proves the shared ledger no longer has them. */
export async function removeTasks(browser: Browser, titles: readonly string[]) {
  const left = await browser.evaluate(async (names) => {
    const matching = async () =>
      (
        (await (await fetch("/api/tasks")).json()).tasks as Array<{ id: string; title: string }>
      ).filter((task) => names.includes(task.title));
    for (const task of await matching()) {
      await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
    }
    return (await matching()).length;
  }, titles);
  expect(left).toBe(0);
}

type TaskScreen = { getByTestId: (id: string) => Locator };

/** Open a fresh untitled task and return its planning-chat input. */
export async function openNewTaskComposer(screen: TaskScreen): Promise<Locator> {
  await screen.getByTestId("new-task-button").tap();
  // Wait until the new blank task is selected; otherwise a previous
  // detail's composer can swallow the first message.
  await expect(screen.getByTestId("task-title")).toHaveText("New task");
  const input = screen.getByTestId("task-agent-input");
  await expect(input).toBeVisible();
  return input;
}

/** Create an open task from the plus button and first message in the embedded chat. */
export async function createOpenTask(
  screen: TaskScreen,
  title: string,
  options?: { project?: string },
) {
  const input = await openNewTaskComposer(screen);
  const text = options?.project === undefined ? title : `@${options.project} ${title}`;
  await input.fill(text);
  await screen.getByTestId("task-agent-send").tap();
  const expected = title.split("\n")[0] ?? title;
  await expect(screen.getByTestId("task-title")).toContainText(expected);
}

/** Close a mobile task detail so the list is visible again. No-op on the desktop split. */
export async function backToTaskList(screen: TaskScreen) {
  const back = screen.getByTestId("task-detail-back");
  if ((await back.count()) === 0) return;
  if (await back.isVisible()) await back.tap();
}
