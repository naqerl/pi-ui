import type { Browser } from "@e2e-dev/web";
import { expect, type Locator, type Screen } from "e2e";

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

type TaskScreen = Pick<Screen, "getByTestId" | "getByRole">;

/** Focus the tasks-page composer, going back to the list first on mobile. */
export async function openNewTaskComposer(screen: TaskScreen): Promise<Locator> {
  await backToTaskList(screen);
  const input = screen.getByRole("textbox", "New task");
  await expect(input).toBeVisible();
  return input;
}

/** Create an open task from the text composer and wait until its detail is open. */
export async function createOpenTask(
  screen: TaskScreen,
  title: string,
  options?: { project?: string },
) {
  const input = await openNewTaskComposer(screen);
  const text = options?.project === undefined ? title : `@${options.project} ${title}`;
  await input.fill(text);
  await screen.getByRole("button", "Add task").tap();
  const expected = title.split("\n")[0] ?? title;
  await expect(screen.getByTestId("task-title")).toContainText(expected);
}

/** Close a mobile task detail so the list is visible again. No-op on the desktop split. */
export async function backToTaskList(screen: TaskScreen) {
  const back = screen.getByTestId("task-detail-back");
  if ((await back.count()) === 0) return;
  if (await back.isVisible()) await back.tap();
}

/** Task-agent chat routes must not be fulfilled as a task ledger. */
export function isTaskChatUrl(url: string): boolean {
  try {
    return /\/api\/tasks\/[^/]+\/chat(?:\/|$)/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}
