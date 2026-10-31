import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second)).toISOString();

const snapshot = {
  conversationId: "task-detail-e2e",
  messages: [],
  activity: [],
  run: "idle",
  queue: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
  context: { tokens: 0, window: null, percent: null },
  tasks: {
    revision: 1_000_000,
    tasks: [
      {
        id: "t1",
        title: "Ship the modal",
        status: "open",
        parentId: null,
        blockedBy: ["t2"],
        createdAt: at(0),
        proposedAt: null,
        rationale:
          "The card hides too much detail when a task has a long rationale.\n\nThe modal keeps the full text readable without widening the card.",
        completedAt: null,
        completion: null,
      },
      {
        id: "t2",
        title: "Review the details",
        status: "done",
        parentId: null,
        blockedBy: [],
        createdAt: at(1),
        proposedAt: null,
        completedAt: at(20),
        completion: {
          timeSpentMinutes: 25,
          timeSpentText: "25m",
          tokens: 1200,
          evidence: "commit 9c58abc",
        },
      },
      {
        id: "p1",
        title: "Clean the cache",
        status: "proposed",
        parentId: null,
        blockedBy: [],
        createdAt: at(2),
        proposedAt: at(2),
        rationale: "The cache keeps stale entries for a whole day and needs a cleanup path.",
        completedAt: null,
        completion: null,
      },
    ],
  },
};

async function openWith(browser: Browser, width: number, height: number) {
  await browser.setViewport({ width, height });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: JSON.parse(JSON.stringify(snapshot)) });
  });
}

test("on a phone the task detail replaces the list and goes back with its button or Escape", async ({
  app,
  browser,
  screen,
}) => {
  await openWith(browser, 390, 844);
  await app.open("/?page=tasks");
  await expect(screen.getByTestId("tasks-page")).toHaveAttribute("data-layout", "stack");

  await screen.getByRole("button", { name: "Open Ship the modal" }).tap();
  const detail = screen.getByTestId("task-detail");
  await expect(detail).toBeVisible();
  await expect(screen.getByTestId("task-filters")).toHaveCount(0);
  await expect(
    screen.getByText("The modal keeps the full text readable without widening the card.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(detail.getByText("Review the details", { exact: true })).toBeVisible();
  await expect(screen.getByTestId("task-state")).toHaveText("Open");
  await expect(screen.getByTestId("task-stats")).toBeVisible();

  const fits = await browser.evaluate(() => {
    const node = document.querySelector<HTMLElement>('[data-testid="task-detail"]');
    if (node === null) return null;
    const box = node.getBoundingClientRect();
    return box.left >= 0 && box.right <= window.innerWidth;
  });
  expect(fits).toBe(true);

  await screen.getByTestId("task-detail-back").tap();
  await expect(screen.getByTestId("task-detail")).toHaveCount(0);
  await expect(screen.getByTestId("task-filters")).toBeVisible();

  await screen.getByRole("button", { name: "Open Ship the modal" }).tap();
  await expect(screen.getByTestId("task-detail")).toBeVisible();
  await browser.keyboard.press("Escape");
  await expect(screen.getByTestId("task-detail")).toHaveCount(0);
});

test("on a desktop the list and the detail sit side by side", async ({ app, browser, screen }) => {
  await openWith(browser, 1280, 800);
  await app.open("/?page=tasks");
  await expect(screen.getByTestId("tasks-page")).toHaveAttribute("data-layout", "split");
  await expect(screen.getByTestId("task-detail-empty")).toBeVisible();

  await screen.getByRole("button", { name: "Open Ship the modal" }).tap();
  await expect(screen.getByTestId("task-detail")).toBeVisible();
  await expect(screen.getByTestId("task-filters")).toBeVisible();
  const sides = await browser.evaluate(() => {
    const list = document.querySelector<HTMLElement>('[data-testid="task-filters"]');
    const detail = document.querySelector<HTMLElement>('[data-testid="task-detail"]');
    if (list === null || detail === null) return null;
    return detail.getBoundingClientRect().left > list.getBoundingClientRect().right;
  });
  expect(sides).toBe(true);

  await screen.getByTestId("task-detail-close").tap();
  await expect(screen.getByTestId("task-detail")).toHaveCount(0);
  await expect(screen.getByTestId("task-detail-empty")).toBeVisible();
});

test("the row glyph marks done without opening the detail, and the detail adds a blocker", async ({
  app,
  browser,
  screen,
}) => {
  await openWith(browser, 390, 844);
  await app.open("/?page=tasks");

  await screen.getByRole("button", { name: "Done Ship the modal" }).tap();
  await expect(screen.getByTestId("task-detail")).toHaveCount(0);

  await screen.getByRole("button", { name: "Open Ship the modal" }).tap();
  await screen.getByRole("button", { name: "Add blocker to Ship the modal" }).tap();
  await expect(screen.getByTestId("task-menu")).toBeVisible();
});

test("proposal approve and dismiss buttons act from the keyboard without opening the detail", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  let patches = 0;
  let deletes = 0;
  await browser.route("**/api/tasks/**", async (route) => {
    if (route.request.method === "PATCH") patches += 1;
    if (route.request.method === "DELETE") deletes += 1;
    await route.fulfill({ json: JSON.parse(JSON.stringify(snapshot.tasks)) });
  });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: JSON.parse(JSON.stringify(snapshot)) });
  });
  await app.open("/?page=tasks");

  const approve = screen.getByRole("button", { name: "Approve Clean the cache" });
  await approve.focus();
  await browser.keyboard.press("Enter");
  await expect.poll(() => patches).toBe(1);
  await expect(screen.getByTestId("task-detail")).toHaveCount(0);

  const dismiss = screen.getByRole("button", { name: "Dismiss Clean the cache" });
  await dismiss.focus();
  await browser.keyboard.press("Space");
  await expect.poll(() => deletes).toBe(1);
  await expect(screen.getByTestId("task-detail")).toHaveCount(0);
});

test("done tasks group by day: today open, past days collapsed with a count", async ({
  app,
  browser,
  screen,
}) => {
  await openWith(browser, 390, 844);
  await app.open("/?page=tasks");
  const today = screen.getByTestId("task-section-done");
  await expect(today).toBeVisible();
  await expect(today).toContainText("Today");
  await expect(today).toContainText("Nothing done yet today.");
  const past = screen.getByTestId("task-day-2026-01-01");
  await expect(past).toHaveAttribute("data-open", "false");
  await expect(past).toContainText("1");
  await expect(screen.getByTestId("task-t2")).toHaveCount(0);

  await screen.getByRole("button", { name: /Jan 1/ }).tap();
  await expect(past).toHaveAttribute("data-open", "true");
  await expect(screen.getByTestId("task-t2")).toBeVisible();
  await expect(screen.getByTestId("task-t2")).toContainText("Review the details");
});
