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

interface PlanEndGap {
  /** The last row's bottom to the dock's top, with the transcript at its end. */
  gap: number;
  /** The scroller's own end padding, the single source of the gutter. */
  paddingBottom: number;
}

/** Measure the plan transcript at its end and its scroller's end padding. */
function readPlanEndGap(browser: Browser): Promise<PlanEndGap | null> {
  return browser.evaluate(async () => {
    const transcript = document.querySelector<HTMLElement>('[data-testid="task-agent-transcript"]');
    const dock = document.querySelector<HTMLElement>('[data-testid="composer-dock"]');
    if (transcript === null || dock === null) return null;
    const rows = transcript.querySelectorAll<HTMLElement>("[data-message-id]");
    const last = rows[rows.length - 1];
    if (last === undefined) return null;
    transcript.scrollTop = transcript.scrollHeight;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    return {
      gap: dock.getBoundingClientRect().top - last.getBoundingClientRect().bottom,
      paddingBottom: Number.parseFloat(getComputedStyle(transcript).paddingBottom),
    };
  });
}

/** During a sweep the exit leg is 90 ms, delayed by the node's slot. */
function expectSweepExit(
  node: Pick<
    DockSwapVisual,
    "phase" | "transitionProperty" | "transitionDuration" | "transitionDelay"
  > | null,
  delay: string,
) {
  expect(node).not.toBeNull();
  expect(node?.phase).toBe("exit");
  expect(node?.transitionProperty).toContain("opacity");
  const properties = node?.transitionProperty.split(/,\s*/) ?? [];
  const durations = node?.transitionDuration.split(/,\s*/) ?? [];
  expect(durations[properties.indexOf("opacity")] ?? durations[0]).toBe("0.09s");
  expect(node?.transitionDelay).toBe(delay);
}

/** The enter leg mounts at the final x and fades in from 0 over 110 ms. */
function expectSweepEnter(
  node: Pick<
    DockSwapVisual,
    "phase" | "animationName" | "animationDuration" | "animationDelay"
  > | null,
  delay: string,
) {
  expect(node).not.toBeNull();
  expect(node?.phase).toBe("enter");
  expect(node?.animationName).toContain("dock-scan-in");
  expect(node?.animationDuration).toBe("0.11s");
  expect(node?.animationDelay).toBe(delay);
}

/** Outside a sweep the settled dock swap keeps its full 160 ms opacity leg. */
function expectDockTransition(
  node: Pick<DockSwapVisual, "transitionProperty" | "transitionDuration"> | null,
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
  phase: string | null;
  inert: boolean;
  ariaHidden: string | null;
  pointerEvents: string;
  transitionProperty: string;
  transitionDuration: string;
  transitionDelay: string;
  animationName: string;
  animationDuration: string;
  animationDelay: string;
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

type DockTaskTrigger =
  | { kind: "open"; id: string; phase?: "exit" | "enter" }
  | { kind: "close"; phase?: "exit" | "enter" }
  | {
      kind: "read";
      phase?: "exit" | "enter";
      statusReady?: boolean;
      planReady?: boolean;
    };

/** Records dock mutations before the trigger so a stalled frame cannot skip a phase. */
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
        phase: node.getAttribute("data-dock-phase"),
        inert: node.hasAttribute("inert"),
        ariaHidden: node.getAttribute("aria-hidden"),
        pointerEvents: style.pointerEvents,
        transitionProperty: style.transitionProperty,
        transitionDuration: style.transitionDuration,
        transitionDelay: style.transitionDelay,
        animationName: style.animationName,
        animationDuration: style.animationDuration,
        animationDelay: style.animationDelay,
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
    // The task send loses its test id the moment the dock leaves the task surface,
    // while its leaving wrapper is still mounted; find that exit by its label.
    const taskSend = () => lane("task-agent-send") ?? laneByLabel("Send");
    const statusNode = () =>
      document.querySelector<HTMLElement>('[data-testid="working-status"] [aria-live="polite"]');
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
    type Sample = ReturnType<typeof read>;
    type Recorder = { samples: Sample[]; stop: () => void };
    const holder = window as Window & { __dockScanRecorder?: Recorder };
    const hasPhase = (sample: Sample, phase: "exit" | "enter") =>
      sample.status?.phase === phase ||
      sample.planSwitch?.phase === phase ||
      Object.values(sample.actions).some((action) => action?.phase === phase);
    const matches = (sample: Sample, phase: "exit" | "enter") => {
      if (!hasPhase(sample, phase)) return false;
      if (trigger.kind === "open") {
        return sample.actions.taskSend?.open === "true" && sample.actions.addTask?.open === "false";
      }
      if (trigger.kind === "close") {
        return sample.actions.addTask?.open === "true" && sample.actions.taskSend?.open === "false";
      }
      if (phase === "enter" && trigger.statusReady === true) {
        const planReady = trigger.planReady !== true || sample.planSwitch?.open === "true";
        return planReady && (sample.status === null || sample.status.open === "true");
      }
      if (phase === "enter") return sample.planSwitch?.open === "true";
      return true;
    };
    const startRecorder = () => {
      holder.__dockScanRecorder?.stop();
      const samples: Sample[] = [];
      const observer = new MutationObserver(() => {
        const sample = read();
        if (hasPhase(sample, "exit") || hasPhase(sample, "enter")) samples.push(sample);
      });
      observer.observe(document.body, {
        subtree: true,
        attributes: true,
        attributeFilter: ["data-dock-phase", "data-open", "inert", "aria-hidden"],
        childList: true,
      });
      const recorder = { samples, stop: () => observer.disconnect() };
      holder.__dockScanRecorder = recorder;
      return recorder;
    };

    const expected = trigger.phase ?? (kind === "read" ? null : "exit");
    if (expected === null) {
      return new Promise<Sample>((resolve) => {
        requestAnimationFrame(() => resolve(read()));
      });
    }

    const recorder =
      trigger.kind === "read" ? (holder.__dockScanRecorder ?? startRecorder()) : startRecorder();
    if (kind === "open") {
      const card = document.querySelector<HTMLElement>(`[data-testid="task-${id}"]`);
      card?.querySelector<HTMLElement>("[data-task-card]")?.click();
    } else if (kind === "close") {
      document.querySelector<HTMLButtonElement>('[data-testid="task-detail-back"]')?.click();
    }

    return new Promise<Sample>((resolve) => {
      const start = performance.now();
      const check = () => {
        const hit = recorder.samples.find((sample) => matches(sample, expected));
        if (hit !== undefined) {
          resolve(hit);
          return true;
        }
        if (performance.now() - start > 1500) {
          resolve(read());
          return true;
        }
        return false;
      };
      if (check()) return;
      const timer = window.setInterval(() => {
        if (check()) window.clearInterval(timer);
      }, 10);
    });
  }, trigger) as Promise<DockTaskSample>;
}

type SettledStatusSample = {
  open: string | null;
  phase: string | null;
  text: string;
  transitionProperty: string;
  transitionDuration: string;
  textIn: boolean;
  childAnimationName: string | null;
};

type SettledStatusTrigger = { kind: "send" } | { kind: "stop"; id: string };

type SettledStatusResult = {
  samples: SettledStatusSample[];
  final: SettledStatusSample;
};

/**
 * Records a settled word swap from before the trigger. A sweep suppresses the
 * keyed child's 160 ms fade, but the next word change on the same surface must
 * still mount with `dock-text-in`; a rAF started after the click can miss it.
 */
function sampleSettledStatusSwap(
  browser: Browser,
  trigger: SettledStatusTrigger,
): Promise<SettledStatusResult> {
  return browser.evaluate(async (trigger) => {
    const statusNode = document.querySelector<HTMLElement>(
      '[data-testid="working-status"] [aria-live="polite"]',
    );
    if (statusNode === null) throw new Error("the dock status is missing");
    const status = statusNode;
    const read = (): SettledStatusSample => {
      const style = getComputedStyle(status);
      const child = status.firstElementChild as HTMLElement | null;
      return {
        open: status.getAttribute("data-open"),
        phase: status.getAttribute("data-dock-phase"),
        text: (status.textContent ?? "").trim(),
        transitionProperty: style.transitionProperty,
        transitionDuration: style.transitionDuration,
        textIn: child?.classList.contains("dock-text-in") ?? false,
        childAnimationName: child === null ? null : getComputedStyle(child).animationName,
      };
    };
    const samples: SettledStatusSample[] = [];
    const record = () => {
      samples.push(read());
    };
    const observer = new MutationObserver(record);
    observer.observe(status, {
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "data-open", "data-dock-phase"],
      childList: true,
      characterData: true,
    });

    if (trigger.kind === "send") {
      document.querySelector<HTMLButtonElement>('[data-testid="task-agent-send"]')?.click();
    } else {
      const response = await fetch(`/api/tasks/${encodeURIComponent(trigger.id)}/chat/stop`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(`stop failed: ${response.status}`);
    }

    return new Promise<{
      samples: SettledStatusSample[];
      final: SettledStatusSample;
    }>((resolve) => {
      const start = performance.now();
      const finish = () => {
        record();
        observer.disconnect();
        resolve({ samples, final: read() });
      };
      const timer = window.setInterval(() => {
        // The word can appear one render before the run flips to its running
        // branch, so wait for the keyed child's fade. The observer keeps the
        // frame even if the animation is already over.
        const hit = samples.find((sample) => sample.textIn && sample.phase === null);
        if (hit !== undefined) {
          window.clearInterval(timer);
          finish();
          return;
        }
        if (performance.now() - start > 2000) {
          window.clearInterval(timer);
          finish();
        }
      }, 10);
    });
  }, trigger) as unknown as Promise<SettledStatusResult>;
}

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

  // A page switch only changes identities: sample both the leaving and the
  // arriving switch while they are fading. The dock, top line and composer
  // must keep the exact heights they had before the switch.
  await browser.setViewport({ width: 390, height: 844 });
  await browser.emulateMedia({ reducedMotion: "no-preference" });
  // The media query change drives a React state update; let it commit before the
  // switch, otherwise the scan still sees the reduce-mode snap.
  await browser.evaluate(
    () =>
      new Promise<boolean>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))),
      ),
  );
  const switchAndSample = (id: "chat" | "tasks", phase: "exit" | "enter") =>
    browser.evaluate(
      ({ pageId, expected }) => {
        const read = () => {
          const dock = document.querySelector<HTMLElement>('[data-testid="composer-dock"]');
          const body = document.querySelector<HTMLElement>('[data-testid="composer-body"]');
          const line = document.querySelector<HTMLElement>(".ink-line");
          const planSwitch = document.querySelector<HTMLElement>(
            '[data-testid="plan-task-toggle"]',
          );
          const style = planSwitch === null ? null : getComputedStyle(planSwitch);
          return {
            dockHeight: dock?.getBoundingClientRect().height ?? null,
            composerHeight: body?.getBoundingClientRect().height ?? null,
            lineHeight: line?.getBoundingClientRect().height ?? null,
            planSwitch:
              planSwitch === null || style === null
                ? null
                : {
                    open: planSwitch.getAttribute("data-open"),
                    phase: planSwitch.getAttribute("data-dock-phase"),
                    inert: planSwitch.hasAttribute("inert"),
                    ariaHidden: planSwitch.getAttribute("aria-hidden"),
                    pointerEvents: style.pointerEvents,
                    transitionProperty: style.transitionProperty,
                    transitionDuration: style.transitionDuration,
                    transitionDelay: style.transitionDelay,
                    animationName: style.animationName,
                    animationDuration: style.animationDuration,
                    animationDelay: style.animationDelay,
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
            const ready = planSwitch?.getAttribute("data-dock-phase") === expected;
            if (ready || performance.now() - start > 400) {
              resolve(read());
              return;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
      },
      { pageId: id, expected: phase },
    );

  const leavingSample = await switchAndSample("chat", "exit");
  expect(leavingSample.dockHeight).toBe(DOCK_HEIGHT);
  expect(leavingSample.composerHeight).toBe(COMPOSER_HEIGHT);
  expect(leavingSample.lineHeight).toBe(TOP_LINE_HEIGHT);
  expect(leavingSample.planSwitch).toMatchObject({
    open: "true",
    phase: "exit",
    inert: true,
    ariaHidden: "true",
    pointerEvents: "none",
  });
  expectSweepExit(leavingSample.planSwitch, "0s");
  await expect.poll(async () => screen.getByTestId("plan-task-toggle").count()).toBe(0);

  const arrivingSample = await switchAndSample("tasks", "enter");
  expect(arrivingSample.dockHeight).toBe(DOCK_HEIGHT);
  expect(arrivingSample.composerHeight).toBe(COMPOSER_HEIGHT);
  expect(arrivingSample.lineHeight).toBe(TOP_LINE_HEIGHT);
  expect(arrivingSample.planSwitch).toMatchObject({
    open: "true",
    phase: "enter",
    inert: false,
    ariaHidden: null,
  });
  expectSweepEnter(arrivingSample.planSwitch, "0s");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("data-open", "true");
  // The same persistent Composer kept the draft and the focus across the swap.
  await expect(composer).toHaveValue("keep this draft");
  await expect.poll(focusedInput).toBe("New task");
});

test("a page switch never moves a visible top-line node", {
  timeout: 180_000,
}, async ({ app, browser }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await browser.emulateMedia({ reducedMotion: "no-preference" });
  await app.open("/?page=chat");

  // Sampling eagerly (rather than once per paint) observes the swap frame
  // before the 12 ms stagger lets the arriving nodes become visible.
  const scan = await browser.evaluate(() => {
    const keyOf = (node: HTMLElement) => {
      if (node.matches('[data-testid="plan-task-toggle"]')) return "plan";
      if (node.matches('[aria-live="polite"]')) return "status";
      if (node.classList.contains("bg-jobs-counts")) return "jobs";
      return null;
    };
    const samples: Array<{
      key: string;
      left: number;
      previousLeft: number;
      visualLeft: number;
      width: number;
      opacity: number;
      phase: string | null;
      open: string | null;
      transform: string;
      text: string;
    }> = [];
    const enterDelays: Record<string, string> = {};
    const phases = new Set<string>();
    const seen = new Map<string, number>();
    const start = performance.now();
    let finished = false;
    const sample = () => {
      const line = document.querySelector<HTMLElement>(".ink-line");
      if (line === null) return;
      for (const node of line.querySelectorAll<HTMLElement>(".dock-swap")) {
        const key = keyOf(node);
        if (key === null) continue;
        // offsetLeft is layout, not the 3px transform drift the exit owns.
        const left = node.offsetLeft;
        const style = getComputedStyle(node);
        const phase = node.getAttribute("data-dock-phase");
        if (phase !== null) phases.add(phase);
        if (phase === "enter") enterDelays[key] = style.animationDelay;
        const previousLeft = seen.get(key);
        if (previousLeft !== undefined) {
          samples.push({
            key,
            left,
            previousLeft,
            visualLeft: node.getBoundingClientRect().left,
            width: node.offsetWidth,
            opacity: Number(style.opacity),
            phase,
            open: node.getAttribute("data-open"),
            transform: style.transform,
            text: (node.textContent ?? "").trim(),
          });
        }
        seen.set(key, left);
      }
    };
    document.querySelector<HTMLButtonElement>('[data-testid="page-dot-tasks"]')?.click();
    return new Promise<{
      samples: typeof samples;
      enterDelays: typeof enterDelays;
      phases: string[];
    }>((resolve) => {
      // The observer runs in the commit's microtask checkpoint, before paint and
      // before the 12 ms stagger advances the arriving opacity.
      const observer = new MutationObserver(sample);
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["data-dock-phase", "data-open", "class"],
      });
      const tick = () => {
        sample();
        if (performance.now() - start < 1200) {
          setTimeout(tick, 1);
          return;
        }
        finished = true;
        observer.disconnect();
        resolve({ samples, enterDelays, phases: [...phases] });
      };
      setTimeout(tick, 1);
      window.addEventListener(
        "pagehide",
        () => {
          if (!finished) observer.disconnect();
        },
        { once: true },
      );
    });
  });

  // A correct swap either moves nothing or moves only a fully transparent node.
  // It must still run both halves of the sweep within the sampled window.
  expect(scan.phases).toEqual(expect.arrayContaining(["exit", "enter"]));
  const moved = scan.samples.filter(
    (sample) => sample.width > 0 && Math.abs(sample.left - sample.previousLeft) > 0.5,
  );
  for (const frame of moved) expect(frame.opacity, JSON.stringify(frame)).toBe(0);
  // The enter leg is opacity-only: every arriving node stays at its final
  // visual x from the first frame, when its opacity is still zero.
  const enterLefts = new Map<string, number>();
  for (const frame of scan.samples) {
    if (frame.phase !== "enter" || frame.open !== "true" || frame.width === 0) continue;
    expect(frame.transform, JSON.stringify(frame)).toMatch(/^(none|matrix\(1, 0, 0, 1, 0, 0\))$/);
    const first = enterLefts.get(frame.key);
    if (first === undefined) enterLefts.set(frame.key, frame.visualLeft);
    else expect(Math.abs(frame.visualLeft - first), JSON.stringify(frame)).toBeLessThanOrEqual(0.5);
  }
  expect(enterLefts.size).toBeGreaterThan(0);
  // The plan switch is slot 0; a status word that is actually entering is slot 1.
  expect(scan.enterDelays.plan).toBe("0s");
  if (scan.enterDelays.status !== undefined) {
    expect(["0s", "0.012s"]).toContain(scan.enterDelays.status);
  }
});

test("a second page switch during the enter leg still settles on the latest surface", {
  timeout: 60_000,
}, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await browser.emulateMedia({ reducedMotion: "no-preference" });
  await app.open("/?page=chat");

  // Leaving in the first exit and returning during the first enter repeats the
  // phase value "exit"; the swap timer must still be armed for the new leg.
  // Wait at least 180 ms, then switch as soon as the enter leg is on screen.
  const enteredLeg = await browser.evaluate(
    () =>
      new Promise<string | null>((resolve) => {
        document.querySelector<HTMLButtonElement>('[data-testid="page-dot-tasks"]')?.click();
        const start = performance.now();
        const tick = () => {
          const toggle = document.querySelector<HTMLElement>('[data-testid="plan-task-toggle"]');
          const phase = toggle?.getAttribute("data-dock-phase") ?? null;
          const elapsed = performance.now() - start;
          if (phase === "enter" && elapsed >= 180) {
            document.querySelector<HTMLButtonElement>('[data-testid="page-dot-chat"]')?.click();
            resolve(phase);
            return;
          }
          if (elapsed > 2000) {
            resolve(null);
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
  expect(enteredLeg).toBe("enter");

  await expect
    .poll(async () =>
      browser.evaluate(
        () => document.querySelectorAll('[data-testid="composer-dock"] [data-dock-phase]').length,
      ),
    )
    .toBe(0);
  await expect(screen.getByTestId("plan-task-toggle")).toHaveCount(0);
  await expect
    .poll(async () =>
      browser.evaluate(
        () =>
          document
            .querySelector('[data-testid="working-status"] [aria-live="polite"]')
            ?.textContent?.trim() ?? "",
      ),
    )
    .toBe("idle");
  expect(
    await browser.evaluate(
      () => document.querySelector("[data-testid=pager]")?.getAttribute("data-page") ?? null,
    ),
  ).toBe("chat");
  expect(
    await browser.evaluate(() => document.querySelectorAll('[aria-live="polite"]').length),
  ).toBe(1);
});

test("create and plan-chat sweep the action and status without moving the dock", {
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

    // create -> plan-chat: the add-task control leaves while the task send arrives.
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
    expect(opened.actions.taskSend).toMatchObject({
      open: "true",
      phase: "exit",
      inert: true,
      ariaHidden: "true",
      pointerEvents: "none",
    });
    expectSweepExit(opened.actions.taskSend, "0.036s");

    // The status word enters as its own keyed child, never as a second live region.
    const enteredScenario = await sampleTaskDockTransition(browser, {
      kind: "read",
      phase: "enter",
      statusReady: true,
    });
    expect(enteredScenario.liveRegions).toBe(1);
    expect(enteredScenario.status).toMatchObject({
      open: "true",
      phase: "enter",
      inert: false,
      ariaHidden: null,
      text: "idle",
    });
    expectSweepEnter(enteredScenario.status, "0.012s");

    // plan-chat -> create: the task send leaves, and the held status word exits.
    const closed = await sampleTaskDockTransition(browser, { kind: "close" });
    expect(closed.dockHeight).toBe(DOCK_HEIGHT);
    expect(closed.composerHeight).toBe(COMPOSER_HEIGHT);
    expect(closed.lineHeight).toBe(TOP_LINE_HEIGHT);
    expect(closed.liveRegions).toBe(1);
    expect(closed.actions.addTask).toMatchObject({
      open: "true",
      phase: "exit",
      inert: true,
      ariaHidden: "true",
      pointerEvents: "none",
    });
    expectSweepExit(closed.actions.addTask, "0.036s");
    expect(closed.actions.taskSend).toMatchObject({
      open: "false",
      inert: true,
      ariaHidden: "true",
      pointerEvents: "none",
    });
    expect(closed.status).toMatchObject({
      open: "true",
      phase: "exit",
      inert: true,
      ariaHidden: "true",
      pointerEvents: "none",
      text: "idle",
    });
    expectSweepExit(closed.status, "0.012s");

    const enteredBack = await sampleTaskDockTransition(browser, {
      kind: "read",
      phase: "enter",
      planReady: true,
    });
    expect(enteredBack.actions.addTask).toMatchObject({ open: "true", phase: "enter" });
    expectSweepEnter(enteredBack.actions.addTask, "0.036s");
    expect(enteredBack.planSwitch).toMatchObject({ open: "true", phase: "enter" });
    expectSweepEnter(enteredBack.planSwitch, "0s");
    await expect(screen.getByTestId("task-agent-send")).toHaveCount(0);
    await expect(screen.getByTestId("plan-task-toggle")).toBeVisible();
    await expect(screen.getByTestId("add-task")).toBeVisible();
  } finally {
    await removeTasks(browser, [title]);
  }
});

test("stats transitions sweep the top line and reduced motion drops the leaving nodes", {
  timeout: 180_000,
}, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await browser.emulateMedia({ reducedMotion: "no-preference" });
  await app.open("/?page=tasks");

  const readGeometry = () => ({
    dockHeight:
      document.querySelector<HTMLElement>('[data-testid="composer-dock"]')?.getBoundingClientRect()
        .height ?? null,
    composerHeight:
      document.querySelector<HTMLElement>('[data-testid="composer-body"]')?.getBoundingClientRect()
        .height ?? null,
    lineHeight:
      document.querySelector<HTMLElement>(".ink-line")?.getBoundingClientRect().height ?? null,
  });
  const tasksBaseline = await browser.evaluate(readGeometry);
  expect(tasksBaseline.dockHeight).toBe(DOCK_HEIGHT);
  expect(tasksBaseline.composerHeight).toBe(COMPOSER_HEIGHT);
  expect(tasksBaseline.lineHeight).toBe(TOP_LINE_HEIGHT);

  // tasks -> stats: the plan switch sweeps out before stats' status word arrives.
  const tasksToStats = await browser.evaluate(() => {
    const planVisual = () => {
      const node = document.querySelector<HTMLElement>('[data-testid="plan-task-toggle"]');
      if (node === null) return null;
      const style = getComputedStyle(node);
      return {
        open: node.getAttribute("data-open"),
        phase: node.getAttribute("data-dock-phase"),
        inert: node.hasAttribute("inert"),
        ariaHidden: node.getAttribute("aria-hidden"),
        pointerEvents: style.pointerEvents,
        transitionProperty: style.transitionProperty,
        transitionDuration: style.transitionDuration,
        transitionDelay: style.transitionDelay,
        animationName: style.animationName,
        animationDuration: style.animationDuration,
        animationDelay: style.animationDelay,
        className: node.className,
        text: (node.textContent ?? "").trim(),
      };
    };
    document.querySelector<HTMLButtonElement>('[data-testid="page-dot-stats"]')?.click();
    return new Promise<ReturnType<typeof planVisual>>((resolve) => {
      const start = performance.now();
      const tick = () => {
        const plan = document.querySelector<HTMLElement>('[data-testid="plan-task-toggle"]');
        if (plan?.getAttribute("data-dock-phase") === "exit" || performance.now() - start > 1500) {
          resolve(planVisual());
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  });
  expect(tasksToStats).toMatchObject({
    open: "true",
    phase: "exit",
    inert: true,
    ariaHidden: "true",
    pointerEvents: "none",
  });
  expectSweepExit(tasksToStats, "0s");
  await expect
    .poll(() =>
      browser.evaluate(
        () => document.querySelector("[data-testid=pager]")?.getAttribute("data-page") ?? null,
      ),
    )
    .toBe("stats");
  await expect(screen.getByTestId("composer-body")).toHaveAttribute("data-collapsed", "true");
  await expect(screen.getByTestId("plan-task-toggle")).toHaveCount(0);

  // stats -> tasks: the dock persists across the page switch, so the arriving
  // plan switch enters at its slot-0 delay and stats' status word is dropped in
  // the same swap frame instead of holding the arriving line off its geometry.
  const statsToTasks = await browser.evaluate(() => {
    const planVisual = () => {
      const node = document.querySelector<HTMLElement>('[data-testid="plan-task-toggle"]');
      if (node === null) return null;
      const style = getComputedStyle(node);
      return {
        open: node.getAttribute("data-open"),
        phase: node.getAttribute("data-dock-phase"),
        inert: node.hasAttribute("inert"),
        ariaHidden: node.getAttribute("aria-hidden"),
        pointerEvents: style.pointerEvents,
        transitionProperty: style.transitionProperty,
        transitionDuration: style.transitionDuration,
        transitionDelay: style.transitionDelay,
        animationName: style.animationName,
        animationDuration: style.animationDuration,
        animationDelay: style.animationDelay,
        className: node.className,
        text: (node.textContent ?? "").trim(),
      };
    };
    const readStatus = () => {
      const node = document.querySelector<HTMLElement>(
        '[data-testid="working-status"] [aria-live="polite"]',
      );
      return node === null
        ? null
        : {
            open: node.getAttribute("data-open"),
            phase: node.getAttribute("data-dock-phase"),
            text: (node.textContent ?? "").trim(),
            children: node.childElementCount,
          };
    };
    const body = document.querySelector<HTMLElement>('[data-testid="composer-body"]');
    document.querySelector<HTMLButtonElement>('[data-testid="page-dot-tasks"]')?.click();
    return new Promise<{
      plan: ReturnType<typeof planVisual>;
      status: ReturnType<typeof readStatus>;
      collapsed: string | null;
    }>((resolve) => {
      const start = performance.now();
      const tick = () => {
        const plan = document.querySelector<HTMLElement>('[data-testid="plan-task-toggle"]');
        if (plan?.getAttribute("data-dock-phase") === "enter" || performance.now() - start > 1500) {
          resolve({
            plan: planVisual(),
            status: readStatus(),
            collapsed: body?.getAttribute("data-collapsed") ?? null,
          });
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  });
  expect(statsToTasks.plan).toMatchObject({ open: "true", phase: "enter" });
  expectSweepEnter(statsToTasks.plan, "0s");
  expect(statsToTasks.status).toMatchObject({ open: "false", text: "", children: 0 });
  expect(statsToTasks.collapsed).toBe("false");
  await expect
    .poll(() => browser.evaluate(readGeometry))
    .toMatchObject({
      dockHeight: DOCK_HEIGHT,
      composerHeight: COMPOSER_HEIGHT,
      lineHeight: TOP_LINE_HEIGHT,
    });

  // The same holds when a done task's collapsed detail closes back to create.
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
    await expect(screen.getByTestId("composer-dock-shell")).toBeVisible();
    await expect(screen.getByTestId("composer-dock-shell")).toHaveAttribute("data-overlay", "true");
    await expect(screen.getByTestId("composer-body")).toHaveAttribute("data-collapsed", "true");
    await expect(screen.getByTestId("task-agent-input")).toBeHidden();
    await expect(screen.getByTestId("plan-task-toggle")).toHaveCount(0);

    const doneToCreate = await browser.evaluate(() => {
      const read = () => {
        const planSwitch = document.querySelector<HTMLElement>('[data-testid="plan-task-toggle"]');
        const style = planSwitch === null ? null : getComputedStyle(planSwitch);
        const body = document.querySelector<HTMLElement>('[data-testid="composer-body"]');
        return {
          planSwitch:
            planSwitch === null || style === null
              ? null
              : {
                  open: planSwitch.getAttribute("data-open"),
                  phase: planSwitch.getAttribute("data-dock-phase"),
                  animationName: style.animationName,
                  animationDuration: style.animationDuration,
                  animationDelay: style.animationDelay,
                },
          collapsed: body?.getAttribute("data-collapsed") ?? null,
        };
      };
      document.querySelector<HTMLButtonElement>('[data-testid="task-detail-back"]')?.click();
      return new Promise<ReturnType<typeof read>>((resolve) => {
        const start = performance.now();
        const tick = () => {
          const planSwitch = document.querySelector<HTMLElement>(
            '[data-testid="plan-task-toggle"]',
          );
          if (
            planSwitch?.getAttribute("data-dock-phase") === "enter" ||
            performance.now() - start > 1500
          ) {
            resolve(read());
            return;
          }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
    });
    expect(doneToCreate.planSwitch).toMatchObject({ open: "true", phase: "enter" });
    expectSweepEnter(doneToCreate.planSwitch, "0s");
    expect(doneToCreate.collapsed).toBe("false");
  } finally {
    await removeTasks(browser, [title]);
  }

  // Reduced motion is an immediate unmount, not a zero-length fade.
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
  // A transcript with spare room below the last row would measure that empty
  // space, not the scroller's end padding; fill it so the row sits at the end.
  await input.fill(`DELEGATE_FAIL ${"filler ".repeat(1000)}`);
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

  // Chromium rounds scrollHeight to an integer, so a correct 16px end gutter can
  // measure just under 16 at max scroll; the computed padding pins the token.
  const phoneEnd = await readPlanEndGap(browser);
  expect(phoneEnd).not.toBeNull();
  expect(phoneEnd?.paddingBottom).toBe(16);
  expect(phoneEnd?.gap ?? 0).toBeGreaterThanOrEqual(15.5);
  // The phone has no page inset, so the gutter is the scroller's padding alone.
  expect(Math.abs((phoneEnd?.gap ?? 0) - (phoneEnd?.paddingBottom ?? 0))).toBeLessThanOrEqual(1);

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

  // The wide split keeps the same end gutter above the dock.
  const wideEnd = await readPlanEndGap(browser);
  expect(wideEnd).not.toBeNull();
  expect(wideEnd?.paddingBottom).toBe(16);
  expect(wideEnd?.gap ?? 0).toBeGreaterThanOrEqual(15.5);

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

  // The retry adds a row to the overflowing transcript; only subpixel rounding
  // may move the measured gutter, never a fixed band appearing below it.
  await expect
    .poll(async () => {
      const end = await readPlanEndGap(browser);
      if (end === null || wideEnd === null) return Number.POSITIVE_INFINITY;
      return Math.abs(end.gap - wideEnd.gap);
    })
    .toBeLessThanOrEqual(1);

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
  // The page switch into the plan chat is a sweep, so the settled word swaps
  // below run with motion enabled rather than the runner's reduced-motion default.
  await browser.emulateMedia({ reducedMotion: "no-preference" });
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
  // Let the page switch into the plan chat finish before starting the run: the
  // settled word swap below must not be folded into the sweep's enter leg.
  await expect
    .poll(async () =>
      browser.evaluate(
        () => document.querySelectorAll('[data-testid="composer-dock"] [data-dock-phase]').length,
      ),
    )
    .toBe(0);
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
  const started = await sampleSettledStatusSwap(browser, { kind: "send" });
  expect(started.final).toMatchObject({ phase: null });
  expectDockTransition(started.final);
  // The sweep suppressed the word's fade while it entered; this later idle ->
  // running remount on the same surface must restore the settled 160 ms fade.
  expect(started.samples.some((sample) => sample.textIn)).toBe(true);
  expect(started.samples.find((sample) => sample.textIn)?.childAnimationName).toContain(
    "dock-text-in",
  );
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

  const stopped = await sampleSettledStatusSwap(browser, { kind: "stop", id: taskId });
  expect(stopped.final).toMatchObject({ phase: null });
  expectDockTransition(stopped.final);
  expect(stopped.samples.some((sample) => sample.textIn)).toBe(true);
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
