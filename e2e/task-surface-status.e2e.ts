import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createOpenTask } from "./tasks-helpers";

async function planIsLive(browser: Browser, taskId: string): Promise<boolean> {
  return browser.evaluate(async (id) => {
    const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
      planning?: string[];
      tasks: Array<{ id: string; planning?: boolean }>;
    };
    return (
      (ledger.planning ?? []).includes(id) &&
      ledger.tasks.find((task) => task.id === id)?.planning === true
    );
  }, taskId);
}

test("the tasks composer status belongs to the open task, not the app", {
  timeout: 180_000,
}, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks");

  // The list has no status slot of its own: with one chat core the word belongs to a run, and
  // no run is live here. The task cards are the only place a run is announced in this view.
  await expect(screen.getByTestId("working-indicator")).toHaveCount(0);
  await expect(screen.getByTestId("task-agent-status")).toHaveCount(0);

  const title = `Surface status ${Date.now()}`;
  await createOpenTask(screen, title);
  await expect(screen.getByText(title)).toBeVisible();
  await expect(screen.getByTestId("working-indicator")).toHaveCount(0);

  const taskId = await browser.evaluate(async (taskTitle) => {
    const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
      tasks: Array<{ id: string; title: string }>;
    };
    return ledger.tasks.find((task) => task.title === taskTitle)?.id ?? null;
  }, title);
  expect(taskId).not.toBeNull();
  if (taskId === null) return;

  try {
    const started = await browser.evaluate(async (id) => {
      const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "SLOW hold the plan run open" }),
      });
      return response.status;
    }, taskId);
    expect(started).toBe(202);
    await expect.poll(() => planIsLive(browser, taskId), { timeout: 30_000 }).toBe(true);

    // The open task's own live plan run says planning, with the same braille frames as chat.
    // One chat core means two surfaces: the list marks the run on the task's card, and the word
    // itself lives in the plan pane, which on a phone is the task detail's first tab.
    await expect(screen.getByTestId(`task-planning-${taskId}`)).toBeVisible();
    await screen.getByText(title).first().tap();
    await expect(screen.getByTestId("task-agent-status-indicator")).toBeVisible();
    await expect(screen.getByTestId("task-agent-status-activity")).toHaveText("planning");
    const indicator = await browser.evaluate(
      () =>
        document.querySelector('[data-testid="task-agent-status-indicator"]')?.textContent ?? "",
    );
    expect(indicator).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠿]/);
  } finally {
    await browser.evaluate(async (id) => {
      const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/chat/stop`, {
        method: "POST",
      });
      return response.status;
    }, taskId);
  }

  await expect.poll(() => planIsLive(browser, taskId), { timeout: 30_000 }).toBe(false);
  await expect(screen.getByTestId(`task-planning-${taskId}`)).toHaveCount(0);
  await expect(screen.getByTestId("working-indicator")).toHaveCount(0);
});

test("a live chat run never becomes the tasks page status", {
  timeout: 180_000,
}, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks");

  const title = `Surface isolation ${Date.now()}`;
  await createOpenTask(screen, title);
  await expect(screen.getByTestId("page-dot-chat")).toBeVisible();
  const composer = screen.getByRole("textbox", "Message");
  await composer.fill(`SLOW keep the main run open ${Date.now()}`);
  await screen.getByRole("button", "Send").tap();

  try {
    await expect(screen.getByRole("button", "Stop")).toBeVisible({ timeout: 30_000 });
    await expect(screen.getByTestId("header-activity")).toHaveText("working");

    // A live chat run stays on the chat page: the tasks list shows nothing for it.
    await screen.getByTestId("page-dot-tasks").tap();
    expect(await screen.getByTestId("working-indicator").first().isVisible()).toBe(false);
    await expect(screen.getByTestId("task-agent-status")).toHaveCount(0);

    // The chat page shows the main run's own word.
    await screen.getByTestId("page-dot-chat").tap();
    await expect(screen.getByTestId("header-activity")).toHaveText("working");
    await expect(screen.getByTestId("working-indicator")).toBeVisible();
  } finally {
    await browser.evaluate(async () => {
      const response = await fetch("/api/stop", { method: "POST" });
      return response.status;
    });
  }

  await expect(screen.getByTestId("working-status")).toHaveAttribute("data-open", "false");
});
