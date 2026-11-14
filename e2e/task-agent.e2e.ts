import { beforeEach, describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createOpenTask, openTaskChatTab } from "./tasks-helpers";

describe("plan runs against one shared app", { serial: true }, () => {
  beforeEach(async ({ browser }) => {
    await browser.unrouteAll();
  });

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

  test("a plan run that dies without an answer shows a dismissible error", {
    timeout: 180_000,
  }, async ({ app, browser, screen }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await app.open("/?page=tasks");
    const title = `Plan run failure ${Date.now()}`;
    await createOpenTask(screen, title);
    await openTaskChatTab(screen);
    await expect(screen.getByTestId("task-agent-chat")).toBeVisible();

    const input = screen.getByTestId("task-agent-input");
    await input.fill("DELEGATE_FAIL");
    await screen.getByTestId("task-agent-send").tap();

    const header = screen.getByTestId("run-error-header");
    await expect(header).toBeVisible({ timeout: 60_000 });
    await expect(screen.getByTestId("run-error-class")).toHaveText("ModelError");
    await expect(screen.getByTestId("run-error-message")).toContainText(/delegate failure/i);

    // The chat is idle with the error, never bare idle and nothing else.
    await expect
      .poll(async () =>
        browser.evaluate(async (taskTitle) => {
          const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
            tasks: Array<{ id: string; title: string }>;
          };
          const task = ledger.tasks.find((item) => item.title === taskTitle);
          if (task === undefined) return null;
          const chat = (await (
            await fetch(`/api/tasks/${encodeURIComponent(task.id)}/chat`, { cache: "no-store" })
          ).json()) as { run?: string; runError?: { class?: string } | null; id?: string };
          return {
            id: task.id,
            run: chat.run ?? null,
            errorClass: chat.runError?.class ?? null,
          };
        }, title),
      )
      .toEqual({ id: expect.any(String), run: "idle", errorClass: "ModelError" });

    await screen.getByTestId("run-error-dismiss").tap();
    await expect(header).toHaveCount(0);
    await expect
      .poll(async () =>
        browser.evaluate(async (taskTitle) => {
          const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
            tasks: Array<{ id: string; title: string }>;
          };
          const task = ledger.tasks.find((item) => item.title === taskTitle);
          if (task === undefined) return null;
          const chat = (await (
            await fetch(`/api/tasks/${encodeURIComponent(task.id)}/chat`, { cache: "no-store" })
          ).json()) as { runError?: string | null };
          return chat.runError ?? null;
        }, title),
      )
      .toBeNull();
  });
});
