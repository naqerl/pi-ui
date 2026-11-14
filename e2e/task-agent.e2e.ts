import { type Browser, beforeEach, describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createOpenTask, openTaskChatTab, removeTasks } from "./tasks-helpers";

async function createPlanTask(browser: Browser, title: string): Promise<string | null> {
  return browser.evaluate(async (taskTitle) => {
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: taskTitle }),
    });
    if (!response.ok) return null;
    const ledger = (await response.json()) as {
      tasks: Array<{ id: string; title: string }>;
    };
    return ledger.tasks.find((task) => task.title === taskTitle)?.id ?? null;
  }, title);
}

async function startPlanRun(browser: Browser, taskId: string, text: string): Promise<number> {
  return browser.evaluate(
    async ({ id, prompt }) => {
      const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: prompt }),
      });
      return response.status;
    },
    { id: taskId, prompt: text },
  );
}

async function stopPlanRun(browser: Browser, taskId: string): Promise<number> {
  return browser.evaluate(
    async (id) =>
      (
        await fetch(`/api/tasks/${encodeURIComponent(id)}/chat/stop`, {
          method: "POST",
        })
      ).status,
    taskId,
  );
}

async function settle(browser: Browser): Promise<void> {
  await browser.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
      }),
  );
}

interface ChatFocus {
  page: string | null;
  focused: boolean;
  selectionStart: number | null;
  selectionEnd: number | null;
}

function readChatFocus(browser: Browser): Promise<ChatFocus> {
  return browser.evaluate(() => {
    const composer = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
    return {
      page:
        document.querySelector('[data-testid="page-dot-chat"]')?.getAttribute("aria-selected") ??
        null,
      focused: composer !== null && document.activeElement === composer,
      selectionStart: composer?.selectionStart ?? null,
      selectionEnd: composer?.selectionEnd ?? null,
    };
  });
}

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

  test("a plan run leaves the chat page and the focused composer alone", {
    timeout: 180_000,
  }, async ({ app, browser, screen }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await app.open("/");
    const composer = screen.getByRole("textbox", "Message");
    await expect(composer).toBeVisible();

    const title = `Plan focus ${Date.now()}`;
    const taskId = await createPlanTask(browser, title);
    expect(taskId).not.toBeNull();
    if (taskId === null) return;

    await composer.fill("keep this draft and its caret");
    await browser.evaluate(() => {
      const element = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
      if (element === null) return false;
      element.focus();
      element.setSelectionRange(5, 5);
      return document.activeElement === element;
    });
    const before = await readChatFocus(browser);
    expect(before).toEqual({
      page: "true",
      focused: true,
      selectionStart: 5,
      selectionEnd: 5,
    });

    // Start a plan run on a task while the operator is typing in the main chat.
    expect(await startPlanRun(browser, taskId, "SLOW keep the plan run open")).toBe(202);
    await expect
      .poll(
        () =>
          browser.evaluate(async (id) => {
            const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
              planning?: string[];
            };
            return (ledger.planning ?? []).includes(id);
          }, taskId),
        { timeout: 30_000 },
      )
      .toBe(true);
    await settle(browser);

    // Page, focus, and caret are exactly where the operator left them.
    expect(await readChatFocus(browser)).toEqual(before);
    expect(
      await browser.evaluate(() => document.querySelector('[data-testid="task-detail"]') !== null),
    ).toBe(false);

    // The end of the run is not a navigation either.
    expect(await stopPlanRun(browser, taskId)).toBe(200);
    await expect
      .poll(
        () =>
          browser.evaluate(async (id) => {
            const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
              planning?: string[];
            };
            return (ledger.planning ?? []).includes(id);
          }, taskId),
        { timeout: 30_000 },
      )
      .toBe(false);
    await settle(browser);
    expect(await readChatFocus(browser)).toEqual(before);

    await removeTasks(browser, [title]);
  });

  test("a plan run becoming active on the tasks page opens nothing", {
    timeout: 180_000,
  }, async ({ app, browser, screen }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await app.open("/?page=tasks");
    const title = `Plan page ${Date.now()}`;
    const taskId = await createPlanTask(browser, title);
    expect(taskId).not.toBeNull();
    if (taskId === null) return;
    await expect(screen.getByRole("button", { name: `Open ${title}` })).toBeVisible();

    expect(await startPlanRun(browser, taskId, "SLOW keep the plan run open")).toBe(202);
    await expect
      .poll(
        () =>
          browser.evaluate(async (id) => {
            const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
              planning?: string[];
            };
            return (ledger.planning ?? []).includes(id);
          }, taskId),
        { timeout: 30_000 },
      )
      .toBe(true);
    await settle(browser);

    // The list stays the page, the card carries the signal, and no detail opens.
    expect(
      await browser.evaluate(
        () =>
          document.querySelector('[data-testid="page-dot-tasks"]')?.getAttribute("aria-selected") ??
          null,
      ),
    ).toBe("true");
    await expect(screen.getByTestId(`task-planning-${taskId}`)).toHaveText("Planning");
    expect(
      await browser.evaluate(() => document.querySelector('[data-testid="task-detail"]') !== null),
    ).toBe(false);

    expect(await stopPlanRun(browser, taskId)).toBe(200);
    await expect
      .poll(
        () =>
          browser.evaluate(async (id) => {
            const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
              planning?: string[];
            };
            return (ledger.planning ?? []).includes(id);
          }, taskId),
        { timeout: 30_000 },
      )
      .toBe(false);
    await settle(browser);
    expect(
      await browser.evaluate(
        () =>
          document.querySelector('[data-testid="page-dot-tasks"]')?.getAttribute("aria-selected") ??
          null,
      ),
    ).toBe("true");
    expect(
      await browser.evaluate(() => document.querySelector('[data-testid="task-detail"]') !== null),
    ).toBe(false);

    await removeTasks(browser, [title]);
  });
});
