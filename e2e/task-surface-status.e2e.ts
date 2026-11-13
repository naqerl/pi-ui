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

  // With one chat core a status line belongs to a run, and no run is live in this view yet.
  await expect(screen.getByTestId("working-indicator")).toHaveCount(0);
  await expect(screen.getByTestId("task-agent-status")).toHaveCount(0);

  const title = `Surface status ${Date.now()}`;
  await createOpenTask(screen, title);
  await expect(screen.getByText(title)).toHaveCount(1);

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

    // The open task's own live plan run says planning, with the same braille frames as chat,
    // and it says it on the plan pane's own status line rather than the chat composer's.
    // Decision (a): while the plan run is live, the tasks **list** shows no status at all.
    // The plan pane has its own line, but that belongs to the pane; the list is what the
    // operator sees when choosing a task, and it must stay quiet.
    expect(await screen.getByTestId("working-indicator").count()).toBe(0);
    expect(await screen.getByTestId("task-agent-status").count()).toBe(0);
    expect(await screen.getByTestId("task-agent-status-indicator").count()).toBe(0);
    // And it stays quiet on the next tick, not only on the first render after the run began.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(await screen.getByTestId("working-indicator").count()).toBe(0);
    expect(await screen.getByTestId("task-agent-status-indicator").count()).toBe(0);
    expect(await planIsLive(browser, taskId)).toBe(true);
  } finally {
    await browser.evaluate(async (id) => {
      const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/chat/stop`, {
        method: "POST",
      });
      return response.status;
    }, taskId);
  }

  await expect.poll(() => planIsLive(browser, taskId), { timeout: 30_000 }).toBe(false);
});

test("a live chat run never becomes the tasks page status", {
  timeout: 180_000,
}, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=chat");

  const composer = screen.getByRole("textbox", "Message");
  await composer.fill(`SLOW keep the main run open ${Date.now()}`);
  await screen.getByRole("button", "Send").tap();

  try {
    await expect(screen.getByRole("button", "Stop")).toBeVisible({ timeout: 30_000 });
    await expect(screen.getByTestId("header-activity")).toHaveText("working");

    // A live chat run stays on the chat page: the tasks page shows nothing for it, because no
    // plan run is live and the chat's word belongs to the chat surface alone.
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
});
