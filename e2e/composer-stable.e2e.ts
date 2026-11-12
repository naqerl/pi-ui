import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createOpenTask } from "./tasks-helpers";

type Sample = {
  same: boolean;
  left: number;
  top: number;
  width: number;
  height: number;
  placeholder: string;
};

async function startSampling(browser: { evaluate: <T>(fn: () => T | Promise<T>) => Promise<T> }) {
  await browser.evaluate(() => {
    type Sample = {
      same: boolean;
      left: number;
      top: number;
      width: number;
      height: number;
      placeholder: string;
    };
    const form = document.querySelector("[data-testid=composer-form]");
    const records: Sample[] = [];
    const started = performance.now();
    const scope = window as unknown as {
      __composerNode: Element | null;
      __composerSamples: Sample[];
    };
    scope.__composerNode = form;
    scope.__composerSamples = records;
    const tick = () => {
      const current = document.querySelector("[data-testid=composer-form]");
      const dock = document.querySelector("[data-testid=composer-dock]");
      const textarea = current?.querySelector("textarea");
      const box = dock instanceof HTMLElement ? dock.getBoundingClientRect() : null;
      records.push({
        same: current !== null && current === scope.__composerNode,
        left: box?.left ?? -1,
        top: box?.top ?? -1,
        width: box?.width ?? -1,
        height: box?.height ?? -1,
        placeholder: textarea?.placeholder ?? "",
      });
      if (performance.now() - started < 900) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return true;
  });
}

async function collectSamples(browser: {
  evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
}): Promise<Sample[]> {
  await browser.evaluate(
    () => new Promise<void>((resolve) => window.setTimeout(() => resolve(), 900)),
  );
  return browser.evaluate(
    () => (window as unknown as { __composerSamples?: Sample[] }).__composerSamples ?? [],
  );
}

function expectStableFooter(samples: Sample[], allowedPlaceholders: readonly string[]) {
  expect(samples.length).toBeGreaterThan(5);
  const first = samples[0];
  expect(first).toBeDefined();
  if (first === undefined) return;
  const seen = new Set<string>();
  for (const item of samples) {
    expect(item.same, "composer form remounted during navigation").toBe(true);
    expect(item.width).toBeGreaterThan(0);
    expect(item.height).toBeGreaterThan(0);
    expect(Math.abs(item.left - first.left), "footer left drifted").toBeLessThanOrEqual(1);
    expect(Math.abs(item.width - first.width), "footer width drifted").toBeLessThanOrEqual(1);
    expect(Math.abs(item.top - first.top), "footer top drifted").toBeLessThanOrEqual(1);
    expect(Math.abs(item.height - first.height), "footer height drifted").toBeLessThanOrEqual(1);
    seen.add(item.placeholder);
    expect(
      allowedPlaceholders.includes(item.placeholder),
      `unexpected placeholder ${item.placeholder}`,
    ).toBe(true);
  }
  expect(seen.size, "placeholder flickered through an extra value").toBeLessThanOrEqual(2);
}

async function navigateAndSample(
  browser: { evaluate: <T>(fn: () => T | Promise<T>) => Promise<T> },
  screen: { getByTestId: (id: string) => { click: () => Promise<void> } },
  target: "chat" | "tasks",
  allowedPlaceholders: readonly string[],
) {
  await startSampling(browser);
  await screen.getByTestId(`page-dot-${target}`).click();
  const samples = await collectSamples(browser);
  expectStableFooter(samples, allowedPlaceholders);
}

test("the composer stays the same node and size when switching chat and tasks", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 800 });
  await app.open("/?page=chat");
  await expect(screen.getByTestId("composer-form")).toBeVisible();
  await expect(screen.getByRole("textbox", "Message")).toBeVisible();

  await navigateAndSample(browser, screen, "tasks", ["Message pi", "New task"]);
  await expect(screen.getByRole("textbox", "New task")).toBeVisible();
  await expect(
    screen.getByText("Select a task to see its details.", { exact: true }),
  ).toBeVisible();

  await navigateAndSample(browser, screen, "chat", ["New task", "Message pi"]);
  await expect(screen.getByRole("textbox", "Message")).toBeVisible();
  await expect(screen.getByText("Send a message to start.", { exact: true })).toBeVisible();

  const title = `Stable composer ${Date.now()}`;
  await screen.getByTestId("page-dot-tasks").click();
  await createOpenTask(screen, title);
  await expect(screen.getByTestId("task-agent-input")).toBeVisible();

  await navigateAndSample(browser, screen, "chat", [
    "Message the task agent",
    "Describe the task to plan…",
    "Ask the planning agent to help formulate this task.",
    "Message pi",
  ]);
  await expect(screen.getByRole("textbox", "Message")).toBeVisible();

  await navigateAndSample(browser, screen, "tasks", [
    "Message pi",
    "Message the task agent",
    "Describe the task to plan…",
    "Ask the planning agent to help formulate this task.",
  ]);
  await expect(screen.getByTestId("task-agent-input")).toBeVisible();
  await expect(screen.getByRole("textbox", "New task")).toHaveCount(0);
});

test("the composer stays the same node on a phone when switching chat and tasks", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=chat");
  await expect(screen.getByTestId("composer-form")).toBeVisible();

  await navigateAndSample(browser, screen, "tasks", ["Message pi", "New task"]);
  await expect(screen.getByRole("textbox", "New task")).toBeVisible();
  await expect(screen.getByText("No tasks yet.", { exact: true })).toBeVisible();

  await navigateAndSample(browser, screen, "chat", ["New task", "Message pi"]);
  await expect(screen.getByRole("textbox", "Message")).toBeVisible();
});
