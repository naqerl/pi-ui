import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { backToTaskList, createOpenTask } from "./tasks-helpers";

test("a live plan run shows Planning on the card and detail, then clears without a reload", {
  timeout: 180_000,
}, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks");
  const title = `Plan the planning badge ${Date.now()}`;
  await createOpenTask(screen, title, { project: "pi-ui" });

  const taskId = await browser.evaluate(async (taskTitle) => {
    const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
      tasks: Array<{ id: string; title: string }>;
    };
    return ledger.tasks.find((task) => task.title === taskTitle)?.id ?? null;
  }, title);
  expect(taskId).not.toBeNull();
  if (taskId === null) return;

  await screen.getByTestId("task-detail-back").tap();
  await expect(screen.getByRole("textbox", "New task")).toBeVisible();

  const started = await browser.evaluate(async (id) => {
    const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "SLOW hold the plan run open" }),
    });
    return response.status;
  }, taskId);
  expect(started).toBe(202);

  await expect
    .poll(
      () =>
        browser.evaluate(async (id) => {
          const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
            planning?: string[];
            tasks: Array<{ id: string; planning?: boolean }>;
          };
          return (
            (ledger.planning ?? []).includes(id) &&
            ledger.tasks.find((task) => task.id === id)?.planning === true
          );
        }, taskId),
      { timeout: 30_000 },
    )
    .toBe(true);

  const card = screen.getByTestId(`task-${taskId}`);
  await expect(card.getByTestId(`task-planning-${taskId}`)).toHaveText("Planning");

  // The extra chip must not wrap the rest of the card's meta at phone width.
  const layout = await browser.evaluate((id) => {
    const cardElement = document.querySelector<HTMLElement>(
      `[data-testid="task-${id}"] [data-task-card]`,
    );
    const meta = cardElement?.querySelector<HTMLElement>('[data-testid="task-card-meta"]');
    if (!(meta instanceof HTMLElement)) return null;
    const tops = [...meta.children]
      .filter((child): child is HTMLElement => child instanceof HTMLElement)
      .map((child) => child.getBoundingClientRect().top);
    return {
      metaHeight: meta.getBoundingClientRect().height,
      lineSpread: tops.length === 0 ? 0 : Math.max(...tops) - Math.min(...tops),
      planningLabel:
        meta.querySelector<HTMLElement>(`[data-testid="task-planning-${id}"]`)?.textContent ?? "",
    };
  }, taskId);
  expect(layout?.planningLabel).toContain("Planning");
  expect(layout?.lineSpread ?? 99).toBeLessThanOrEqual(1);
  expect(layout?.metaHeight ?? 99).toBeLessThanOrEqual(20);

  await screen.getByRole("button", { name: `Open ${title}` }).tap();
  await expect(screen.getByTestId(`task-detail-planning-${taskId}`)).toHaveText("Planning");

  // The desktop detail header carries the same live chip.
  await browser.setViewport({ width: 1280, height: 800 });
  await expect(screen.getByTestId(`task-detail-planning-${taskId}`)).toHaveText("Planning");
  await browser.setViewport({ width: 390, height: 844 });
  await backToTaskList(screen);
  await expect(card.getByTestId(`task-planning-${taskId}`)).toBeVisible();

  const stopped = await browser.evaluate(async (id) => {
    const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/chat/stop`, {
      method: "POST",
    });
    return response.status;
  }, taskId);
  expect(stopped).toBe(200);

  await expect
    .poll(
      () =>
        browser.evaluate(async (id) => {
          const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
            planning?: string[];
            tasks: Array<{ id: string; planning?: boolean }>;
          };
          return (
            !(ledger.planning ?? []).includes(id) &&
            ledger.tasks.find((task) => task.id === id)?.planning === false
          );
        }, taskId),
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect(card.getByTestId(`task-planning-${taskId}`)).toHaveCount(0);
});
