import type { Browser } from "@e2e-dev/web";
import { expect, type Locator, type Screen } from "e2e";

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

export async function setPlanDraft(screen: TaskScreen, on: boolean): Promise<void> {
  const toggle = screen.getByTestId("plan-task-toggle");
  if ((await toggle.count()) === 0) return;
  const pressed = (await toggle.getAttribute("aria-pressed")) === "true";
  if (pressed !== on) await toggle.tap();
}

export async function openNewTaskComposer(screen: TaskScreen): Promise<Locator> {
  await backToTaskList(screen);
  const input = screen.getByRole("textbox", "New task");
  await expect(input).toBeVisible();
  return input;
}

export async function createOpenTask(
  screen: TaskScreen,
  title: string,
  options?: { project?: string },
) {
  const input = await openNewTaskComposer(screen);
  await setPlanDraft(screen, false);
  const text = options?.project === undefined ? title : `@${options.project} ${title}`;
  await input.fill(text);
  await screen.getByRole("button", "Add task").tap();
  const expected = title.split("\n")[0] ?? title;
  await expectDetailTitle(screen, expected);
}

export async function backToTaskList(screen: TaskScreen) {
  const back = screen.getByTestId("task-detail-back");
  if ((await back.count()) === 0) return;
  if (await back.isVisible()) await back.tap();
}

export function isTaskChatUrl(url: string): boolean {
  try {
    return /\/api\/tasks\/[^/]+\/chat(?:\/|$)/.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export async function openTaskActions(screen: TaskScreen) {
  const content = screen.getByTestId("task-detail-menu-content");
  if ((await content.count()) > 0 && (await content.isVisible())) return;
  const menu = screen.getByTestId("task-detail-menu");
  await expect(menu).toBeVisible();
  await menu.tap();
  await expect(content).toBeVisible();
}

export async function chooseTaskAction(screen: TaskScreen, testId: string) {
  await openTaskActions(screen);
  await screen.getByTestId(testId).tap();
}

export async function isDesktopDetail(screen: TaskScreen): Promise<boolean> {
  const detail = screen.getByTestId("task-detail");
  if ((await detail.count()) === 0) return false;
  return (await detail.getAttribute("data-layout")) === "desktop";
}

export async function expectDetailTitle(screen: TaskScreen, expected: string) {
  await expect(screen.getByTestId("task-detail")).toBeVisible();
  if (await isDesktopDetail(screen)) {
    await expect(screen.getByTestId("task-details-bar")).toContainText("Task details");
    await expect(screen.getByRole("button", { name: `Open ${expected}` })).toBeVisible();
  } else {
    await expect(screen.getByTestId("task-title")).toContainText(expected);
  }
}

export async function beginRenameTask(screen: TaskScreen) {
  const title = screen.getByTestId("task-title");
  if ((await title.count()) > 0 && (await title.isVisible())) {
    await title.click();
  } else {
    await openTaskActions(screen);
    await screen.getByTestId("task-detail-rename").tap();
  }
  await expect(screen.getByTestId("task-title-input")).toBeVisible();
}

export async function openTaskProject(screen: TaskScreen) {
  const input = screen.getByTestId("task-project-input");
  if ((await input.count()) === 0 || !(await input.isVisible())) {
    const trigger = screen.getByTestId("task-header-project");
    if ((await trigger.count()) > 0 && (await trigger.isVisible())) {
      await trigger.tap();
    } else {
      await openTaskActions(screen);
      await screen.getByTestId("task-change-project").tap();
    }
  }
  await expect(input).toBeVisible();
  return input;
}

export async function expectTaskProject(screen: TaskScreen, name: string) {
  const label = name.length === 0 ? "No project" : `@${name}`;
  const trigger = screen.getByTestId("task-header-project");
  if ((await trigger.count()) > 0 && (await trigger.isVisible())) {
    await expect(trigger).toHaveText(label);
    return;
  }
  const input = await openTaskProject(screen);
  await expect(input).toHaveValue(name);
}

export async function openTaskChatTab(screen: TaskScreen) {
  const tab = screen.getByTestId("task-tab-chat");
  if ((await tab.count()) === 0) return;
  if (await tab.isVisible()) await tab.tap();
}

export async function openTaskPlanTab(screen: TaskScreen) {
  const tab = screen.getByTestId("task-tab-plan");
  if ((await tab.count()) === 0) return;
  if (await tab.isVisible()) await tab.tap();
}
