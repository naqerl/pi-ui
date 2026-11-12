import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { chooseTaskAction, isTaskChatUrl } from "./tasks-helpers";

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second)).toISOString();

const longBody = Array.from(
  { length: 60 },
  (_, index) => `Paragraph ${index + 1} keeps the task body taller than the detail.`,
).join("\n\n");

function ledger(count: number, doneCount = 0) {
  return {
    revision: 1_000_000,
    tasks: Array.from({ length: count }, (_, index) => {
      const done = index >= count - doneCount;
      return {
        id: `scroll-${index + 1}`,
        title: `Scroll task ${index + 1}`,
        status: done ? "done" : "open",
        parentId: null,
        blockedBy: [],
        createdAt: at(index),
        proposedAt: null,
        body: longBody,
        rationale: longBody,
        completedAt: done ? new Date(Date.now() - (index + 1) * 60_000).toISOString() : null,
        completion: null,
      };
    }),
  };
}

function snapshot(count: number, doneCount = 0) {
  return {
    conversationId: "tasks-detail-scroll-e2e",
    messages: [],
    activity: [],
    run: "idle",
    queue: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    context: { tokens: 0, window: null, percent: null },
    tasks: ledger(count, doneCount),
  };
}

async function openTasks(
  app: { open(path?: string): Promise<void> },
  browser: Browser,
  payload: ReturnType<typeof snapshot>,
  width: number,
  height: number,
) {
  await browser.setViewport({ width, height });
  await browser.unrouteAll();
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: JSON.parse(JSON.stringify(payload)) });
  });
  await app.open("/?page=tasks");
}

interface ListAnchor {
  id: string;
  label: string;
  scrollTop: number;
  offset: number;
}

/**
 * Scroll the narrow page to a non-zero offset, then align the first card that
 * the detail's capture would choose so the test can tap that exact card.
 */
async function scrollAndPick(browser: Browser): Promise<ListAnchor> {
  return browser.evaluate(async () => {
    const page = document.querySelector<HTMLElement>('[data-testid="tasks-page"]');
    if (page === null) throw new Error("the tasks page is missing");
    const nextFrame = () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    page.scrollTop = Math.floor((page.scrollHeight - page.clientHeight) / 2);
    await nextFrame();
    const cards = [...page.querySelectorAll<HTMLElement>("[data-task-card]")];
    const card = cards.find(
      (item) => item.getBoundingClientRect().bottom > page.getBoundingClientRect().top + 1,
    );
    if (card === undefined) throw new Error("no task card is visible");
    const partial = card.getBoundingClientRect().top - page.getBoundingClientRect().top;
    if (partial < 8) {
      page.scrollTop += partial;
      await nextFrame();
    }
    const pageBox = page.getBoundingClientRect();
    const box = card.getBoundingClientRect();
    const row = card.closest<HTMLElement>('li[data-testid^="task-"]') ?? null;
    const testId = row?.getAttribute("data-testid") ?? "";
    if (
      row === null ||
      !testId.startsWith("task-") ||
      box.top < pageBox.top ||
      box.bottom > pageBox.bottom
    ) {
      throw new Error("the first visible task card is not fully visible");
    }
    return {
      id: testId.slice("task-".length),
      label: card.getAttribute("aria-label") ?? "",
      scrollTop: page.scrollTop,
      offset: row.getBoundingClientRect().top - pageBox.top,
    };
  });
}

async function readPosition(browser: Browser, id: string) {
  return browser.evaluate((taskId) => {
    const page = document.querySelector<HTMLElement>('[data-testid="tasks-page"]');
    const row = document.querySelector<HTMLElement>(`[data-testid="task-${CSS.escape(taskId)}"]`);
    if (page === null || row === null) return null;
    return {
      scrollTop: page.scrollTop,
      offset: row.getBoundingClientRect().top - page.getBoundingClientRect().top,
    };
  }, id);
}

async function expectRestored(browser: Browser, anchor: ListAnchor, withScroll = true) {
  await expect
    .poll(async () => {
      const position = await readPosition(browser, anchor.id);
      if (position === null) return null;
      return {
        scroll: withScroll ? Math.abs(position.scrollTop - anchor.scrollTop) <= 2 : true,
        card: Math.abs(position.offset - anchor.offset) <= 2,
      };
    })
    .toEqual({ scroll: true, card: true });
}

test("a narrow detail opens at the top instead of keeping the list offset", async ({
  app,
  browser,
  screen,
}) => {
  await openTasks(app, browser, snapshot(40, 15), 390, 700);
  await expect(screen.getByTestId("task-list")).toBeVisible();
  const anchor = await scrollAndPick(browser);
  expect(anchor.scrollTop).toBeGreaterThan(0);

  await screen.getByRole("button", { name: anchor.label }).tap();
  await expect(screen.getByTestId("task-detail")).toBeVisible();
  await expect
    .poll(() =>
      browser.evaluate(
        () => document.querySelector<HTMLElement>('[data-testid="tasks-page"]')?.scrollTop ?? -1,
      ),
    )
    .toBe(0);
});

test("the back button restores the list scroll and the same card position", async ({
  app,
  browser,
  screen,
}) => {
  await openTasks(app, browser, snapshot(40, 15), 390, 700);
  await expect(screen.getByTestId("task-list")).toBeVisible();
  const anchor = await scrollAndPick(browser);
  expect(anchor.scrollTop).toBeGreaterThan(0);

  await screen.getByRole("button", { name: anchor.label }).tap();
  await expect(screen.getByTestId("task-detail")).toBeVisible();
  await screen.getByTestId("task-detail-back").tap();
  await expect(screen.getByTestId("task-detail")).toHaveCount(0);
  await expect(screen.getByTestId("task-list")).toBeVisible();
  await expectRestored(browser, anchor);
});

test("history back and Escape restore the list the same way", async ({ app, browser, screen }) => {
  await openTasks(app, browser, snapshot(40, 15), 390, 700);
  await expect(screen.getByTestId("task-list")).toBeVisible();

  for (const close of ["escape", "popstate"] as const) {
    const anchor = await scrollAndPick(browser);
    expect(anchor.scrollTop).toBeGreaterThan(0);
    await screen.getByRole("button", { name: anchor.label }).tap();
    await expect(screen.getByTestId("task-detail")).toBeVisible();
    if (close === "escape") {
      await browser.keyboard.press("Escape");
    } else {
      await browser.back();
    }
    await expect(screen.getByTestId("task-detail")).toHaveCount(0);
    await expect(screen.getByTestId("task-list")).toBeVisible();
    await expectRestored(browser, anchor);
  }
});

test("a task finished from the detail returns at its original anchor after regrouping", async ({
  app,
  browser,
  screen,
}) => {
  const payload = snapshot(40, 15);
  const tasks = payload.tasks;
  await browser.setViewport({ width: 390, height: 700 });
  await browser.unrouteAll();
  await browser.route("**/api/tasks/**", async (route) => {
    if (isTaskChatUrl(route.request.url)) {
      await route.continue();
      return;
    }
    if (route.request.method === "PATCH") {
      const patch = JSON.parse(route.request.postData ?? "{}") as { status?: string };
      const id = decodeURIComponent(new URL(route.request.url).pathname.split("/").pop() ?? "");
      const task = tasks.tasks.find((item) => item.id === id);
      if (task !== undefined && patch.status !== undefined) {
        task.status = patch.status;
        task.completedAt = patch.status === "done" ? new Date().toISOString() : null;
      }
      tasks.revision += 1;
    }
    await route.fulfill({ json: JSON.parse(JSON.stringify(tasks)) });
  });
  await browser.route("**/api/state**", async (route) => {
    const state = JSON.parse(JSON.stringify(payload));
    state.tasks = tasks;
    await route.fulfill({ json: state });
  });
  await app.open("/?page=tasks");
  await expect(screen.getByTestId("task-list")).toBeVisible();
  const anchor = await scrollAndPick(browser);
  expect(anchor.scrollTop).toBeGreaterThan(0);

  await screen.getByRole("button", { name: anchor.label }).tap();
  await expect(screen.getByTestId("task-detail")).toBeVisible();
  await chooseTaskAction(screen, "task-detail-status");
  await expect
    .poll(() =>
      browser.evaluate(
        (taskId) =>
          document
            .querySelector(`[data-testid="task-${CSS.escape(taskId)}"]`)
            ?.closest('[data-testid="task-section-done"]') !== null,
        anchor.id,
      ),
    )
    .toBe(true);

  await screen.getByTestId("task-detail-back").tap();
  await expect(screen.getByTestId("task-detail")).toHaveCount(0);
  await expect(screen.getByTestId("task-list")).toBeVisible();
  // The card moved to another group, so the raw offset can differ; its place
  // under the viewport is what the anchor restore owns.
  await expectRestored(browser, anchor, false);
});

test("the desktop split keeps the list pane scroll when a selection opens and closes", async ({
  app,
  browser,
  screen,
}) => {
  await openTasks(app, browser, snapshot(40, 15), 1280, 600);
  await expect(screen.getByTestId("task-list")).toBeVisible();
  const before = await browser.evaluate(async () => {
    const list = document.querySelector<HTMLElement>('[data-testid="task-list"]');
    const pane = list?.parentElement ?? null;
    if (pane === null) throw new Error("the list pane is missing");
    pane.scrollTop = Math.floor((pane.scrollHeight - pane.clientHeight) / 2);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
    const paneBox = pane.getBoundingClientRect();
    const card = [...pane.querySelectorAll<HTMLElement>("[data-task-card]")].find((item) => {
      const box = item.getBoundingClientRect();
      return box.top >= paneBox.top + 8 && box.bottom <= paneBox.bottom - 8;
    });
    if (card === undefined) throw new Error("no task card is fully visible");
    return {
      scrollTop: pane.scrollTop,
      label: card.getAttribute("aria-label") ?? "",
    };
  });
  expect(before.scrollTop).toBeGreaterThan(0);

  await screen.getByRole("button", { name: before.label }).tap();
  await expect(screen.getByTestId("task-detail")).toBeVisible();
  await screen.getByTestId("task-detail-back").tap();
  await expect(screen.getByTestId("task-detail")).toHaveCount(0);
  await expect(screen.getByTestId("task-detail-empty")).toBeVisible();
  expect(
    await browser.evaluate(
      () =>
        document.querySelector<HTMLElement>('[data-testid="task-list"]')?.parentElement
          ?.scrollTop ?? -1,
    ),
  ).toBe(before.scrollTop);
});
