import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { isTaskChatUrl } from "./tasks-helpers";
import { removeTasks } from "./tasks-helpers.js";

async function blur(browser: Browser) {
  await browser.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    return true;
  });
}

test("edits a task title in place, grows to two lines, and refuses an empty one", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 800 });
  let patches = 0;
  await browser.route("**/api/tasks/**", async (route) => {
    if (isTaskChatUrl(route.request.url)) {
      await route.continue();
      return;
    }
    if (route.request.method === "PATCH") patches += 1;
    await route.continue();
  });
  await app.open("/?page=tasks");
  const id = await browser.evaluate(async () => {
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Draft title", parentId: null }),
    });
    const ledger = (await response.json()) as { tasks: Array<{ id: string; title: string }> };
    return ledger.tasks.find((task) => task.title === "Draft title")?.id ?? "";
  });
  await app.open("/?page=tasks");
  await screen.getByRole("button", { name: "Open Draft title" }).click();
  const detail = screen.getByTestId("task-detail");
  await expect(screen.getByTestId("task-title-edit")).toHaveCount(0);
  await expect(screen.getByTestId("task-body-edit")).toHaveCount(0);
  await expect(detail.getByRole("button", { name: /Edit title/ })).toHaveCount(0);

  await detail.getByText("Draft title", { exact: true }).click();
  const title = screen.getByRole("textbox", "Task title");
  const single = await title.boundingBox();
  await title.fill("Long first line\nCorrected title");
  const grown = await title.boundingBox();
  expect(grown?.height ?? 0).toBeGreaterThan((single?.height ?? 0) + 10);
  const sizing = await browser.evaluate(() => {
    const field = document.querySelector<HTMLTextAreaElement>('[data-testid="task-title-input"]');
    if (field === null) return null;
    return {
      rows: field.rows,
      value: field.value,
      scrolls: field.scrollHeight > field.clientHeight + 1,
    };
  });
  expect(sizing).toEqual({ rows: 2, value: "Long first line\nCorrected title", scrolls: false });

  await blur(browser);
  await expect
    .poll(() =>
      browser.evaluate(async (taskId) => {
        const ledger = (await (await fetch("/api/tasks")).json()) as {
          tasks: Array<{ id: string; title: string }>;
        };
        return ledger.tasks.find((task) => task.id === taskId)?.title ?? null;
      }, id),
    )
    .toBe("Long first line\nCorrected title");

  await browser.reload();
  await screen.getByRole("button", { name: /Open Long first line\s+Corrected title/ }).click();
  expect(
    await browser.evaluate(
      () => document.querySelector('[data-testid="task-title"]')?.textContent ?? null,
    ),
  ).toBe("Long first line\nCorrected title");

  await screen.getByTestId("task-title").click();
  const escaped = screen.getByRole("textbox", "Task title");
  await escaped.fill("Should not save");
  const beforeEscape = patches;
  await escaped.press("Escape");
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(patches).toBe(beforeEscape);
  expect(
    await browser.evaluate(
      () => document.querySelector('[data-testid="task-title"]')?.textContent ?? null,
    ),
  ).toBe("Long first line\nCorrected title");

  await screen.getByTestId("task-title").click();
  const again = screen.getByRole("textbox", "Task title");
  await again.fill("   ");
  await blur(browser);
  await expect(screen.getByText("Title must not be empty")).toBeVisible();
  await expect
    .poll(() =>
      browser.evaluate(async (taskId) => {
        const ledger = (await (await fetch("/api/tasks")).json()) as {
          tasks: Array<{ id: string; title: string }>;
        };
        return ledger.tasks.find((task) => task.id === taskId)?.title ?? null;
      }, id),
    )
    .toBe("Long first line\nCorrected title");

  await removeTasks(browser, ["Long first line\nCorrected title"]);
});
