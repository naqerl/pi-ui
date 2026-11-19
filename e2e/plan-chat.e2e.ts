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

const DOCK_HEIGHT = 90;
const COMPOSER_HEIGHT = 48;
const TOP_LINE_HEIGHT = 41;

function expectDockTransition(
  node: { transitionProperty: string | null; transitionDuration: string | null } | null,
) {
  expect(node).not.toBeNull();
  const properties = (node?.transitionProperty ?? "").split(",").map((part) => part.trim());
  const durations = (node?.transitionDuration ?? "").split(",").map((part) => part.trim());
  const opacity = properties.indexOf("opacity");
  expect(opacity).toBeGreaterThanOrEqual(0);
  expect(durations[opacity]).toBe("0.16s");
}

interface DockSwapVisual {
  open: string | null;
  inert: boolean;
  ariaHidden: string | null;
  pointerEvents: string;
  transitionProperty: string;
  transitionDuration: string;
  animationName: string;
  className: string;
  text: string;
}

interface DockTaskSample {
  dockHeight: number | null;
  composerHeight: number | null;
  lineHeight: number | null;
  liveRegions: number;
  status: DockSwapVisual | null;
  actions: Record<string, DockSwapVisual | null>;
  planSwitch: DockSwapVisual | null;
}

type DockTaskTrigger = { kind: "open"; id: string } | { kind: "close" } | { kind: "read" };

function sampleTaskDockTransition(
  browser: Browser,
  trigger: DockTaskTrigger,
): Promise<DockTaskSample> {
  return browser.evaluate((trigger) => {
    const { kind } = trigger;
    const id = trigger.kind === "open" ? trigger.id : "";
    const visual = (node: HTMLElement | null) => {
      if (node === null) return null;
      const style = getComputedStyle(node);
      return {
        open: node.getAttribute("data-open"),
        inert: node.hasAttribute("inert"),
        ariaHidden: node.getAttribute("aria-hidden"),
        pointerEvents: style.pointerEvents,
        transitionProperty: style.transitionProperty,
        transitionDuration: style.transitionDuration,
        animationName: style.animationName,
        className: node.className,
        text: (node.textContent ?? "").trim(),
      };
    };
    const lane = (testId: string) => {
      const button = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
      return visual(button?.closest<HTMLElement>(".dock-swap") ?? null);
    };
    const laneByLabel = (label: string) => {
      const button = document.querySelector<HTMLElement>(`button[aria-label="${label}"]`);
      return visual(button?.closest<HTMLElement>(".dock-swap") ?? null);
    };
    const taskSend = () => lane("task-agent-send") ?? laneByLabel("Send");
    const statusNode = () => {
      const live = document.querySelector<HTMLElement>(
        '[data-testid="working-status"] [aria-live="polite"]',
      );
      const child = live?.firstElementChild;
      return child instanceof HTMLElement ? child : null;
    };
    const read = () => {
      const dock = document.querySelector<HTMLElement>('[data-testid="composer-dock"]');
      const body = document.querySelector<HTMLElement>('[data-testid="composer-body"]');
      const line = document.querySelector<HTMLElement>(".ink-line");
      return {
        dockHeight: dock?.getBoundingClientRect().height ?? null,
        composerHeight: body?.getBoundingClientRect().height ?? null,
        lineHeight: line?.getBoundingClientRect().height ?? null,
        liveRegions: document.querySelectorAll(
          '[data-testid="working-status"] [aria-live="polite"]',
        ).length,
        status: visual(statusNode()),
        actions: {
          addTask: lane("add-task"),
          taskSend: taskSend(),
          taskSteer: lane("task-agent-steer"),
        },
        planSwitch: visual(document.querySelector<HTMLElement>('[data-testid="plan-task-toggle"]')),
      };
    };

    if (kind === "open") {
      const card = document.querySelector<HTMLElement>(`[data-testid="task-${id}"]`);
      card?.querySelector<HTMLElement>("[data-task-card]")?.click();
    } else if (kind === "close") {
      document.querySelector<HTMLButtonElement>('[data-testid="task-detail-back"]')?.click();
    } else {
      return new Promise<ReturnType<typeof read>>((resolve) => {
        requestAnimationFrame(() => resolve(read()));
      });
    }

    return new Promise<ReturnType<typeof read>>((resolve) => {
      const start = performance.now();
      const tick = () => {
        const addTask = lane("add-task");
        const send = taskSend();
        const status = visual(statusNode());
        const ready =
          kind === "open"
            ? send?.open === "true" && addTask?.open === "false"
            : addTask?.open === "true" &&
              send?.open === "false" &&
              (status === null || status.open === "false");
        if (ready || performance.now() - start > 120) {
          resolve(read());
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }, trigger) as Promise<DockTaskSample>;
}

test("the plan switch sits on the dock's top line with a visible label", {
  timeout: 120_000,
}, async ({ app, browser, screen }) => {
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

  await browser.setViewport({ width: 1280, height: 900 });
  await expect(toggle).toBeVisible();
  const wide = await readGeometry();
  checkGeometry(wide);
  await expect(screen.getByTestId("composer-plus")).toBeVisible();

  await browser.setViewport({ width: 390, height: 844 });
  await browser.emulateMedia({ reducedMotion: "no-preference" });
  const switchAndSample = (id: "chat" | "tasks", waitForLeaving: boolean) =>
    browser.evaluate(
      ({ pageId, leaving }) => {
        const read = () => {
          const dock = document.querySelector<HTMLElement>('[data-testid="composer-dock"]');
          const body = document.querySelector<HTMLElement>('[data-testid="composer-body"]');
          const line = document.querySelector<HTMLElement>(".ink-line");
          const planSwitch = document.querySelector<HTMLElement>(
            '[data-testid="plan-task-toggle"]',
          );
          return {
            dockHeight: dock?.getBoundingClientRect().height ?? null,
            composerHeight: body?.getBoundingClientRect().height ?? null,
            lineHeight: line?.getBoundingClientRect().height ?? null,
            planSwitch:
              planSwitch === null
                ? null
                : {
                    open: planSwitch.getAttribute("data-open"),
                    inert: planSwitch.hasAttribute("inert"),
                    ariaHidden: planSwitch.getAttribute("aria-hidden"),
                    transitionProperty: getComputedStyle(planSwitch).transitionProperty,
                    transitionDuration: getComputedStyle(planSwitch).transitionDuration,
                  },
          };
        };
        document.querySelector<HTMLButtonElement>(`[data-testid="page-dot-${pageId}"]`)?.click();
        return new Promise<ReturnType<typeof read>>((resolve) => {
          const start = performance.now();
          const tick = () => {
            const planSwitch = document.querySelector<HTMLElement>(
              '[data-testid="plan-task-toggle"]',
            );
            const ready =
              planSwitch !== null &&
              planSwitch.getAttribute("data-open") === (leaving ? "false" : "true");
            if (ready || performance.now() - start > 120) {
              resolve(read());
              return;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      },
      { pageId: id, leaving: waitForLeaving },
    );

  const leavingSample = await switchAndSample("chat", true);
  expect(leavingSample.dockHeight).toBe(DOCK_HEIGHT);
  expect(leavingSample.composerHeight).toBe(COMPOSER_HEIGHT);
  expect(leavingSample.lineHeight).toBe(TOP_LINE_HEIGHT);
  expect(leavingSample.planSwitch).not.toBeNull();
  expect(leavingSample.planSwitch?.open).toBe("false");
  expect(leavingSample.planSwitch?.inert).toBe(true);
  expect(leavingSample.planSwitch?.ariaHidden).toBe("true");
  expect(leavingSample.planSwitch?.transitionProperty).toContain("opacity");
  expectDockTransition(leavingSample.planSwitch);
  await expect(screen.getByTestId("plan-task-toggle")).toHaveCount(0);

  const arrivingSample = await switchAndSample("tasks", false);
  expect(arrivingSample.dockHeight).toBe(DOCK_HEIGHT);
  expect(arrivingSample.composerHeight).toBe(COMPOSER_HEIGHT);
  expect(arrivingSample.lineHeight).toBe(TOP_LINE_HEIGHT);
  expect(arrivingSample.planSwitch).toEqual({
    open: "true",
    inert: false,
    ariaHidden: null,
    transitionProperty: expect.stringContaining("opacity"),
    transitionDuration: expect.any(String),
  });
  expectDockTransition(arrivingSample.planSwitch);
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("data-open", "true");
  await expect(composer).toHaveValue("keep this draft");
  await expect.poll(focusedInput).toBe("New task");
});

test("create and plan-chat fade the action and status without moving the dock", {
  timeout: 180_000,
}, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await browser.emulateMedia({ reducedMotion: "no-preference" });
  await app.open("/?page=tasks");
  const title = `Dock swap ${Date.now()}`;
  await createOpenTask(screen, title);
  await openTaskChatTab(screen);
  await expect(screen.getByTestId("task-agent-chat")).toBeVisible();
  const taskId = await browser.evaluate(async (needle) => {
    const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
      tasks: Array<{ id: string; title: string }>;
    };
    return ledger.tasks.find((task) => task.title === needle)?.id ?? null;
  }, title);
  expect(taskId).not.toBeNull();
  if (taskId === null) return;

  try {
    await screen.getByTestId("task-detail-back").tap();
    await expect(screen.getByTestId("plan-task-toggle")).toBeVisible();
    await expect(screen.getByTestId("add-task")).toBeVisible();

    const opened = await sampleTaskDockTransition(browser, { kind: "open", id: taskId });
    expect(opened.dockHeight).toBe(DOCK_HEIGHT);
    expect(opened.composerHeight).toBe(COMPOSER_HEIGHT);
    expect(opened.lineHeight).toBe(TOP_LINE_HEIGHT);
    expect(opened.liveRegions).toBe(1);
    expect(opened.actions.addTask).toMatchObject({
      open: "false",
      inert: true,
      ariaHidden: "true",
      pointerEvents: "none",
    });
    expectDockTransition(opened.actions.addTask);
    expect(opened.actions.taskSend).toMatchObject({
      open: "true",
      inert: false,
      ariaHidden: null,
    });
    expectDockTransition(opened.actions.taskSend);

    await expect
      .poll(async () => (await sampleTaskDockTransition(browser, { kind: "read" })).status?.text)
      .toBe("idle");
    const enteredScenario = await sampleTaskDockTransition(browser, { kind: "read" });
    expect(enteredScenario.liveRegions).toBe(1);
    expect(enteredScenario.status).toMatchObject({
      open: "true",
      inert: false,
      ariaHidden: null,
    });
    expect(enteredScenario.status?.animationName).toContain("dock-text-in");
    expectDockTransition(enteredScenario.status);

    const closed = await sampleTaskDockTransition(browser, { kind: "close" });
    expect(closed.dockHeight).toBe(DOCK_HEIGHT);
    expect(closed.composerHeight).toBe(COMPOSER_HEIGHT);
    expect(closed.lineHeight).toBe(TOP_LINE_HEIGHT);
    expect(closed.liveRegions).toBe(1);
    expect(closed.actions.addTask).toMatchObject({
      open: "true",
      inert: false,
      ariaHidden: null,
    });
    expectDockTransition(closed.actions.addTask);
    expect(closed.actions.taskSend).toMatchObject({
      open: "false",
      inert: true,
      ariaHidden: "true",
      pointerEvents: "none",
    });
    expectDockTransition(closed.actions.taskSend);
    expect(closed.status).toMatchObject({
      open: "false",
      inert: true,
      ariaHidden: "true",
      pointerEvents: "none",
      text: "idle",
    });
    expectDockTransition(closed.status);
    await expect(screen.getByTestId("task-agent-send")).toHaveCount(0);
    await expect(screen.getByTestId("plan-task-toggle")).toBeVisible();
    await expect(screen.getByTestId("add-task")).toBeVisible();
  } finally {
    await removeTasks(browser, [title]);
  }
});

test("a collapse owns the swap and reduced motion drops the leaving nodes", {
  timeout: 180_000,
}, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await browser.emulateMedia({ reducedMotion: "no-preference" });
  await app.open("/?page=tasks");

  await screen.getByTestId("page-dot-stats").tap();
  await expect
    .poll(() =>
      browser.evaluate(
        () => document.querySelector("[data-testid=pager]")?.getAttribute("data-page") ?? null,
      ),
    )
    .toBe("stats");
  const statsToTasks = await browser.evaluate(() => {
    const read = () => {
      const planSwitch = document.querySelector<HTMLElement>('[data-testid="plan-task-toggle"]');
      const body = document.querySelector<HTMLElement>('[data-testid="composer-body"]');
      return {
        planSwitch:
          planSwitch === null
            ? null
            : {
                className: planSwitch.className,
                animationName: getComputedStyle(planSwitch).animationName,
              },
        collapsed: body?.getAttribute("data-collapsed") ?? null,
      };
    };
    document.querySelector<HTMLButtonElement>('[data-testid="page-dot-tasks"]')?.click();
    return new Promise<ReturnType<typeof read>>((resolve) => {
      const start = performance.now();
      const tick = () => {
        const planSwitch = document.querySelector('[data-testid="plan-task-toggle"]');
        if (planSwitch !== null || performance.now() - start > 120) {
          requestAnimationFrame(() => resolve(read()));
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  });
  expect(statsToTasks.planSwitch).not.toBeNull();
  expect(statsToTasks.planSwitch?.className).not.toContain("dock-swap");
  expect(statsToTasks.planSwitch?.className).not.toContain("dock-text-in");
  expect(statsToTasks.planSwitch?.animationName).toBe("none");
  expect(statsToTasks.collapsed).toBe("false");

  const title = `Done dock ${Date.now()}`;
  const doneId = await browser.evaluate(async (needle) => {
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: needle }),
    });
    const ledger = (await response.json()) as { tasks: Array<{ id: string; title: string }> };
    const task = ledger.tasks.find((item) => item.title === needle);
    if (task === undefined) return "";
    await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        status: "done",
        completion: { evidence: "e2e/plan-chat.e2e.ts done dock" },
      }),
    });
    return task.id;
  }, title);
  expect(doneId).not.toBe("");
  if (doneId === "") return;

  try {
    await app.open("/?page=tasks");
    await expect(screen.getByTestId(`task-${doneId}`)).toBeVisible();
    await browser.evaluate(
      ({ id }) => {
        const card = document.querySelector<HTMLElement>(`[data-testid="task-${id}"]`);
        card?.querySelector<HTMLElement>("[data-task-card]")?.click();
        return null;
      },
      { id: doneId },
    );
    await expect(screen.getByTestId("composer-body")).toHaveAttribute("data-collapsed", "true");
    await expect(screen.getByTestId("plan-task-toggle")).toHaveCount(0);

    const doneToCreate = await browser.evaluate(() => {
      const read = () => {
        const planSwitch = document.querySelector<HTMLElement>('[data-testid="plan-task-toggle"]');
        const body = document.querySelector<HTMLElement>('[data-testid="composer-body"]');
        return {
          planSwitch:
            planSwitch === null
              ? null
              : {
                  className: planSwitch.className,
                  animationName: getComputedStyle(planSwitch).animationName,
                },
          collapsed: body?.getAttribute("data-collapsed") ?? null,
        };
      };
      document.querySelector<HTMLButtonElement>('[data-testid="task-detail-back"]')?.click();
      return new Promise<ReturnType<typeof read>>((resolve) => {
        const start = performance.now();
        const tick = () => {
          const planSwitch = document.querySelector('[data-testid="plan-task-toggle"]');
          if (planSwitch !== null || performance.now() - start > 120) {
            requestAnimationFrame(() => resolve(read()));
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    });
    expect(doneToCreate.planSwitch).not.toBeNull();
    expect(doneToCreate.planSwitch?.className).not.toContain("dock-swap");
    expect(doneToCreate.planSwitch?.className).not.toContain("dock-text-in");
    expect(doneToCreate.planSwitch?.animationName).toBe("none");
    expect(doneToCreate.collapsed).toBe("false");
  } finally {
    await removeTasks(browser, [title]);
  }

  await browser.emulateMedia({ reducedMotion: "reduce" });
  await app.open("/?page=tasks");
  await expect(screen.getByTestId("plan-task-toggle")).toBeVisible();
  const reducedAway = await browser.evaluate(() => {
    const read = () => ({
      planSwitch: document.querySelectorAll('[data-testid="plan-task-toggle"]').length,
      addTask: document.querySelectorAll('[data-testid="add-task"]').length,
    });
    document.querySelector<HTMLButtonElement>('[data-testid="page-dot-chat"]')?.click();
    return new Promise<ReturnType<typeof read>>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(read())));
    });
  });
  expect(reducedAway).toEqual({ planSwitch: 0, addTask: 0 });

  const reducedBack = await browser.evaluate(() => {
    const read = () => {
      const planSwitch = document.querySelector<HTMLElement>('[data-testid="plan-task-toggle"]');
      return {
        planSwitchClass: planSwitch === null ? null : planSwitch.className,
        animationName: planSwitch === null ? null : getComputedStyle(planSwitch).animationName,
        transitionDuration:
          planSwitch === null ? null : getComputedStyle(planSwitch).transitionDuration,
      };
    };
    document.querySelector<HTMLButtonElement>('[data-testid="page-dot-tasks"]')?.click();
    return new Promise<ReturnType<typeof read>>((resolve) => {
      const start = performance.now();
      const tick = () => {
        const planSwitch = document.querySelector('[data-testid="plan-task-toggle"]');
        if (planSwitch !== null || performance.now() - start > 120) {
          requestAnimationFrame(() => resolve(read()));
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  });
  expect(reducedBack.planSwitchClass).not.toBeNull();
  expect(reducedBack.animationName).toBe("none");
  expect(reducedBack.transitionDuration).toBe("0s");
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
  await expect(screen.getByTestId("working-status")).toHaveText("idle", { timeout: 60_000 });
  await expect(screen.getByTestId("task-agent-status")).toHaveCount(0);
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
  expect(planPlacement.transcriptTop).toBe(transcriptTop);

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

  await screen.getByTestId("page-dot-chat").tap();
  await expect.poll(async () => screen.getByTestId("run-error-header").count()).toBe(0);
  await screen.getByTestId("page-dot-tasks").tap();
  await expect.poll(async () => screen.getByTestId("run-error-header").count()).toBe(0);
  await expect(screen.getByTestId("task-agent-chat")).toBeVisible();

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
