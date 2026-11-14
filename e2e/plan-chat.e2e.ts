import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createOpenTask, openTaskChatTab, removeTasks } from "./tasks-helpers";

test("a plan run that dies without an answer shows a dismissible error", {
  timeout: 180_000,
}, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks");
  const title = `Plan run failure ${Date.now()}`;
  await createOpenTask(screen, title);
  await openTaskChatTab(screen);
  await expect(screen.getByTestId("task-agent-chat")).toBeVisible();

  const taskId = await browser.evaluate(async (taskTitle) => {
    const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
      tasks: Array<{ id: string; title: string }>;
    };
    return ledger.tasks.find((task) => task.title === taskTitle)?.id ?? null;
  }, title);
  expect(taskId).not.toBeNull();
  if (taskId === null) return;

  await browser.evaluate(async () => {
    await fetch("/api/e2e/push", { method: "DELETE" });
    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        endpoint: "https://push.example/e2e-plan-run-error",
        keys: { p256dh: "plan-error-key", auth: "plan-error-auth" },
      }),
    });
    return true;
  });

  const transcriptTop = await browser.evaluate(
    () =>
      document
        .querySelector<HTMLElement>('[data-testid="task-agent-transcript"]')
        ?.getBoundingClientRect().top ?? null,
  );
  const input = screen.getByTestId("task-agent-input");
  await input.fill("DELEGATE_FAIL");
  await screen.getByTestId("task-agent-send").tap();

  const header = screen.getByTestId("run-error-header");
  await expect(header).toBeVisible({ timeout: 60_000 });
  // The plan pane has no second copy of the run error.
  await expect.poll(async () => screen.getByTestId("run-error-header").count()).toBe(1);
  await expect(screen.getByTestId("composer-error")).toHaveCount(0);
  await expect(screen.getByTestId("run-error-class")).toHaveText("ModelError");
  await expect(screen.getByTestId("run-error-message")).toContainText(/delegate failure/i);

  const planPlacement = await browser.evaluate(() => {
    const element = document.querySelector<HTMLElement>('[data-testid="run-error-header"]');
    const transcript = document.querySelector<HTMLElement>('[data-testid="task-agent-transcript"]');
    return {
      position: element === null ? null : getComputedStyle(element).position,
      height: element?.getBoundingClientRect().height ?? 99,
      transcriptTop: transcript?.getBoundingClientRect().top ?? null,
    };
  });
  expect(planPlacement.position).toBe("absolute");
  expect(planPlacement.height).toBeLessThan(40);
  // Absolute placement: the header overlays the top, it does not move the transcript.
  expect(planPlacement.transcriptTop).toBe(transcriptTop);

  // The same single host survives the wide layout.
  await browser.setViewport({ width: 1280, height: 900 });
  await expect.poll(async () => screen.getByTestId("run-error-header").count()).toBe(1);

  await expect
    .poll(async () =>
      browser.evaluate(async (id) => {
        const response = await fetch("/api/e2e/push", { cache: "no-store" });
        const body = (await response.json()) as {
          notifications?: Array<{
            title?: unknown;
            body?: unknown;
            url?: unknown;
            tag?: unknown;
          }>;
        };
        const match = body.notifications?.find(
          (item) => item.title === `Turn failed in the plan chat for ${id}`,
        );
        return match === undefined
          ? null
          : {
              body: typeof match.body === "string" ? match.body : null,
              url: typeof match.url === "string" ? match.url : null,
              tag: typeof match.tag === "string" ? match.tag : null,
            };
      }, taskId),
    )
    .toEqual({
      body: expect.stringMatching(/delegate failure/i),
      url: `/#/tasks/${taskId}?tab=plan`,
      tag: `run-error-${taskId}`,
    });

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

  // A page switch is a new render, not a resurrection of the dismissed plan error.
  await screen.getByTestId("page-dot-chat").tap();
  await expect.poll(async () => screen.getByTestId("run-error-header").count()).toBe(0);
  await screen.getByTestId("page-dot-tasks").tap();
  await expect.poll(async () => screen.getByTestId("run-error-header").count()).toBe(0);
  await expect(screen.getByTestId("task-agent-chat")).toBeVisible();

  await removeTasks(browser, [title]);
});
