import { type Browser, test } from "@e2e-dev/web";
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
  // The failed run settles to the composer dock's idle word, with no pane copy.
  await expect(screen.getByTestId("working-status")).toHaveText("idle", { timeout: 60_000 });
  await expect(screen.getByTestId("task-agent-status")).toHaveCount(0);
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

  // The composer is the retry path after a failed run: another message starts a run.
  const retryInput = screen.getByTestId("task-agent-input");
  await retryInput.fill("SLOW retry after the failed plan run");
  await screen.getByTestId("task-agent-send").tap();
  await expect(screen.getByTestId("working-status")).toHaveAttribute("data-open", "true", {
    timeout: 30_000,
  });
  await expect(screen.getByTestId("header-activity")).toHaveText("planning", {
    timeout: 30_000,
  });
  expect(await stopPlan(browser, taskId)).toBe(200);
  await expect(screen.getByTestId("working-status")).toHaveAttribute("data-open", "false", {
    timeout: 30_000,
  });
  await expect(screen.getByTestId("task-agent-status")).toHaveCount(0);

  await removeTasks(browser, [title]);
});

interface PlanStatusSurface {
  paneCount: number;
  dockCount: number;
  dockOpen: string | null;
  dockWord: string | null;
  composerHeight: number | null;
  transcriptScrollTop: number | null;
}

function readPlanStatus(browser: Browser): Promise<PlanStatusSurface> {
  return browser.evaluate(() => {
    const dock = document.querySelector<HTMLElement>('[data-testid="working-status"]');
    const composer = document.querySelector<HTMLElement>('[data-testid="composer-dock"]');
    const transcript = document.querySelector<HTMLElement>('[data-testid="task-agent-transcript"]');
    return {
      paneCount: document.querySelectorAll('[data-testid="task-agent-status"]').length,
      dockCount: document.querySelectorAll('[data-testid="working-status"]').length,
      dockOpen: dock?.getAttribute("data-open") ?? null,
      dockWord:
        document
          .querySelector<HTMLElement>('[data-testid="header-activity"]')
          ?.textContent?.trim() ??
        (dock?.textContent?.trim().length === 0 ? null : dock?.textContent?.trim()) ??
        null,
      composerHeight: composer?.getBoundingClientRect().height ?? null,
      transcriptScrollTop: transcript?.scrollTop ?? null,
    };
  });
}

async function postPlan(browser: Browser, taskId: string, text: string): Promise<number> {
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

async function stopPlan(browser: Browser, taskId: string): Promise<number> {
  return browser.evaluate(
    async (id) =>
      (await fetch(`/api/tasks/${encodeURIComponent(id)}/chat/stop`, { method: "POST" })).status,
    taskId,
  );
}

test("the plan chat renders its run status only in the composer dock", {
  timeout: 180_000,
}, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks");
  const title = `Plan status once ${Date.now()}`;
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

  const dock = screen.getByTestId("working-status");
  await expect(dock).toHaveText("idle", { timeout: 60_000 });
  const phoneIdle = await readPlanStatus(browser);
  expect(phoneIdle).toMatchObject({
    paneCount: 0,
    dockCount: 1,
    dockOpen: "false",
    dockWord: "idle",
  });
  expect(phoneIdle.composerHeight ?? 0).toBeGreaterThan(0);
  await app.screenshot("plan-chat-idle");

  // A run started from the plan composer keeps the dock as its only status.
  const input = screen.getByTestId("task-agent-input");
  await input.fill("SLOW keep the plan run open");
  await screen.getByTestId("task-agent-send").tap();
  await expect(dock).toHaveAttribute("data-open", "true", { timeout: 30_000 });
  await expect(screen.getByTestId("header-activity")).toHaveText("planning", {
    timeout: 30_000,
  });
  await expect(screen.getByTestId("task-agent-status")).toHaveCount(0);
  const phoneLive = await readPlanStatus(browser);
  expect(phoneLive).toMatchObject({
    paneCount: 0,
    dockCount: 1,
    dockOpen: "true",
    dockWord: "planning",
  });
  expect(phoneLive.composerHeight).toBe(phoneIdle.composerHeight);
  expect(phoneLive.transcriptScrollTop).toBe(phoneIdle.transcriptScrollTop);
  await app.screenshot("plan-chat-live");

  expect(await stopPlan(browser, taskId)).toBe(200);
  await expect(dock).toHaveAttribute("data-open", "false", { timeout: 30_000 });
  await expect(dock).toHaveText("idle", { timeout: 30_000 });
  const phoneStopped = await readPlanStatus(browser);
  expect(phoneStopped).toMatchObject({
    paneCount: 0,
    dockCount: 1,
    dockOpen: "false",
    dockWord: "idle",
  });
  expect(phoneStopped.composerHeight).toBe(phoneIdle.composerHeight);
  expect(phoneStopped.transcriptScrollTop).toBe(phoneLive.transcriptScrollTop);

  // The same single status survives the wide split layout.
  await browser.setViewport({ width: 1280, height: 900 });
  await expect(dock).toHaveText("idle", { timeout: 60_000 });
  const wideIdle = await readPlanStatus(browser);
  expect(wideIdle).toMatchObject({
    paneCount: 0,
    dockCount: 1,
    dockOpen: "false",
    dockWord: "idle",
  });
  expect(wideIdle.composerHeight ?? 0).toBeGreaterThan(0);

  expect(await postPlan(browser, taskId, "SLOW keep the plan run open")).toBe(202);
  await expect(dock).toHaveAttribute("data-open", "true", { timeout: 30_000 });
  await expect(screen.getByTestId("header-activity")).toHaveText("planning", {
    timeout: 30_000,
  });
  await expect(screen.getByTestId("task-agent-status")).toHaveCount(0);
  const wideLive = await readPlanStatus(browser);
  expect(wideLive).toMatchObject({
    paneCount: 0,
    dockCount: 1,
    dockOpen: "true",
    dockWord: "planning",
  });
  expect(wideLive.composerHeight).toBe(wideIdle.composerHeight);

  expect(await stopPlan(browser, taskId)).toBe(200);
  await expect(dock).toHaveAttribute("data-open", "false", { timeout: 30_000 });
  await expect(dock).toHaveText("idle", { timeout: 30_000 });
  await expect(screen.getByTestId("task-agent-status")).toHaveCount(0);

  await removeTasks(browser, [title]);
});
