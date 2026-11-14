import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createOpenTask, openTaskChatTab, removeTasks } from "./tasks-helpers";

interface PlanSwitchGeometry {
  radius: string;
  left: number;
  statusLeft: number;
  statusCentre: number;
  centre: number;
  lineTextCentre: number;
  background: string;
  dockHeight: number;
  composerHeight: number;
  lineHeight: number;
  inTopLine: boolean;
  inComposerForm: boolean;
  parentTestId: string | null;
}

// Measured on main at 390x844: the dock is 90 px, the composer body 48 px and
// the top line 41 px. The switch must ride that existing line, not grow it.
const DOCK_HEIGHT = 90;
const COMPOSER_HEIGHT = 48;
const TOP_LINE_HEIGHT = 41;

test("the plan switch sits on the dock's top line with a visible label", {
  timeout: 120_000,
}, async ({ app, browser, screen }) => {
  // The phone is the first acceptance surface: the dock's top line and its
  // action row collapse differently there, so sample the alignment before wide.
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks");
  await browser.evaluate(() => {
    sessionStorage.removeItem("pi-ui:plan-task-draft");
    return null;
  });
  await app.open("/?page=tasks");

  const toggle = screen.getByTestId("plan-task-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  // The visible label is the whole accessible name, exactly once.
  await expect(screen.getByRole("button", "Plan task")).toHaveCount(1);
  await expect(toggle).toHaveAccessibleName("Plan task");
  const visibleLabel = toggle.getByText("Plan task", { exact: true });
  await expect(visibleLabel).toBeVisible();
  await expect(visibleLabel).toHaveText("Plan task");

  const composer = screen.getByRole("textbox", "New task");
  await composer.fill("keep this draft");
  await composer.focus();

  const readGeometry = (): Promise<PlanSwitchGeometry> =>
    browser.evaluate(() => {
      const button = document.querySelector<HTMLElement>('[data-testid="plan-task-toggle"]');
      const status = document.querySelector<HTMLElement>('[data-testid="working-status"]');
      const dock = document.querySelector<HTMLElement>('[data-testid="composer-dock"]');
      const composerBody = document.querySelector<HTMLElement>('[data-testid="composer-body"]');
      const track = button?.querySelector<HTMLElement>('[data-testid="plan-task-switch-track"]');
      if (
        button === null ||
        track === null ||
        track === undefined ||
        status === null ||
        dock === null ||
        composerBody === null
      ) {
        throw new Error(
          "the plan switch, its track, status line, dock, or composer body is missing",
        );
      }
      const line = button.closest<HTMLElement>(".ink-line");
      if (line === null) throw new Error("the plan switch is not on the dock's top line");
      const rect = button.getBoundingClientRect();
      const statusRect = status.getBoundingClientRect();
      const lineRect = line.getBoundingClientRect();
      const lineStyle = getComputedStyle(line);
      const lineContentTop =
        lineRect.top +
        Number.parseFloat(lineStyle.borderTopWidth) +
        Number.parseFloat(lineStyle.paddingTop);
      const lineContentHeight =
        lineRect.height -
        Number.parseFloat(lineStyle.borderTopWidth) -
        Number.parseFloat(lineStyle.borderBottomWidth) -
        Number.parseFloat(lineStyle.paddingTop) -
        Number.parseFloat(lineStyle.paddingBottom);
      return {
        radius: getComputedStyle(button).borderTopLeftRadius,
        left: rect.left,
        statusLeft: statusRect.left,
        statusCentre: statusRect.top + statusRect.height / 2,
        centre: rect.top + rect.height / 2,
        lineTextCentre: lineContentTop + lineContentHeight / 2,
        background: getComputedStyle(track).backgroundColor,
        dockHeight: dock.getBoundingClientRect().height,
        composerHeight: composerBody.getBoundingClientRect().height,
        lineHeight: lineRect.height,
        inTopLine: line !== null,
        inComposerForm: button.closest('[data-testid="composer-form"]') !== null,
        parentTestId: button.parentElement?.getAttribute("data-testid") ?? null,
      };
    });

  const checkGeometry = (sample: PlanSwitchGeometry) => {
    expect(sample.radius).toBe("0px");
    expect(sample.inTopLine).toBe(true);
    expect(sample.inComposerForm).toBe(false);
    expect(sample.parentTestId).toBe("working-status");
    expect(Math.abs(sample.left - sample.statusLeft)).toBeLessThanOrEqual(1);
    expect(Math.abs(sample.centre - sample.lineTextCentre)).toBeLessThanOrEqual(1);
    expect(Math.abs(sample.centre - sample.statusCentre)).toBeLessThanOrEqual(1);
  };

  const checkHeights = (sample: PlanSwitchGeometry) => {
    expect(sample.dockHeight).toBe(DOCK_HEIGHT);
    expect(sample.composerHeight).toBe(COMPOSER_HEIGHT);
    expect(sample.lineHeight).toBe(TOP_LINE_HEIGHT);
  };

  const on = await readGeometry();
  checkGeometry(on);
  checkHeights(on);
  const focusedInput = () =>
    browser.evaluate(() => {
      const active = document.activeElement;
      return active instanceof HTMLTextAreaElement
        ? (active.getAttribute("aria-label") ?? active.tagName)
        : (active?.tagName ?? "");
    });

  await toggle.tap();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect.poll(focusedInput).toBe("New task");
  const off = await readGeometry();
  checkGeometry(off);
  checkHeights(off);
  expect(off.background).not.toBe(on.background);
  await app.screenshot("plan-task-switch-off");

  await toggle.tap();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect.poll(focusedInput).toBe("New task");
  const again = await readGeometry();
  checkGeometry(again);
  checkHeights(again);
  expect(again.background).toBe(on.background);
  await expect(composer).toHaveValue("keep this draft");
  await app.screenshot("plan-task-switch-on");

  // The same top-line alignment holds when the dock is wide.
  await browser.setViewport({ width: 1280, height: 900 });
  await expect(toggle).toBeVisible();
  const wide = await readGeometry();
  checkGeometry(wide);
  await expect(screen.getByTestId("composer-plus")).toBeVisible();
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
