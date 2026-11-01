import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second)).toISOString();

const longBody = [
  "# Ship plan",
  "",
  "Use **small** steps.",
  "",
  ...Array.from({ length: 30 }, (_, index) => `- Step ${index + 1} keeps the body long.`),
].join("\n");

const longRationale = [
  "The card hides too much detail when a task has a long rationale.",
  "The modal keeps the full text readable without widening the card.",
  ...Array.from(
    { length: 10 },
    (_, index) => `Paragraph ${index + 1} keeps the rationale long enough to overflow.`,
  ),
].join("\n\n");

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
        body: longBody,
        rationale: longRationale,
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
  await expect(screen.getByTestId("task-list")).toHaveCount(0);
  await expect(screen.getByTestId("task-filters")).toHaveCount(0);
  await expect(
    screen.getByText("The modal keeps the full text readable without widening the card.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(detail.getByText("Review the details", { exact: true })).toBeVisible();
  await expect(detail.getByTestId("task-detail-id")).toHaveText("t1");
  await expect(detail.getByRole("heading", { name: "Ship plan" })).toBeVisible();
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
  await expect(screen.getByTestId("task-list")).toBeVisible();

  await screen.getByRole("button", { name: "Open Ship the modal" }).tap();
  await expect(screen.getByTestId("task-detail")).toBeVisible();
  await browser.keyboard.press("Escape");
  await expect(screen.getByTestId("task-detail")).toHaveCount(0);
});

test("on a desktop the first task is selected and the detail stays beside the list", async ({
  app,
  browser,
  screen,
}) => {
  await openWith(browser, 1280, 800);
  await app.open("/?page=tasks");
  await expect(screen.getByTestId("tasks-page")).toHaveAttribute("data-layout", "split");
  await expect(screen.getByTestId("task-detail-empty")).toHaveCount(0);
  await expect(screen.getByTestId("task-detail")).toHaveAttribute("aria-label", "Clean the cache");
  await expect(screen.getByTestId("task-detail-close")).toHaveCount(0);
  await expect(screen.getByTestId("task-t1").getByTestId("task-id-t1")).toHaveText("t1");
  await expect(screen.getByTestId("proposal-p1").getByTestId("task-id-p1")).toHaveText("p1");

  await screen.getByRole("button", { name: "Open Ship the modal" }).tap();
  await expect(screen.getByTestId("task-detail")).toHaveAttribute("aria-label", "Ship the modal");
  await expect(screen.getByTestId("task-detail")).toBeVisible();
  await expect(screen.getByTestId("task-filters")).toHaveCount(0);
  const sides = await browser.evaluate(() => {
    const list = document.querySelector<HTMLElement>('[data-testid="task-list"]');
    const detail = document.querySelector<HTMLElement>('[data-testid="task-detail"]');
    if (list === null || detail === null) return null;
    return detail.getBoundingClientRect().left > list.getBoundingClientRect().right;
  });
  expect(sides).toBe(true);

  const body = await browser.evaluate(() => {
    const node = document.querySelector<HTMLElement>('[data-testid="task-body"]');
    const detail = document.querySelector<HTMLElement>('[data-testid="task-detail"]');
    const composer = document.querySelector<HTMLElement>('[data-testid="composer-dock"]');
    const rationale = document.querySelector<HTMLElement>('[data-testid="task-rationale"]');
    if (node === null || detail === null || composer === null || rationale === null) return null;
    const style = getComputedStyle(node);
    const detailBox = detail.getBoundingClientRect();
    return {
      overflowY: style.overflowY,
      maxHeight: style.maxHeight,
      flexGrow: style.flexGrow,
      height: node.clientHeight,
      scrolls: node.scrollHeight > node.clientHeight,
      cardOverflow: detail.scrollHeight - detail.clientHeight,
      rationaleInside: rationale.getBoundingClientRect().bottom <= detailBox.bottom + 1,
      aboveComposer: detailBox.bottom <= composer.getBoundingClientRect().top,
    };
  });
  expect(body?.overflowY).toBe("auto");
  expect(body?.maxHeight).not.toBe("none");
  expect(body?.flexGrow).toBe("1");
  expect(body?.height).toBeGreaterThan(0);
  expect(body?.scrolls).toBe(true);
  expect(body?.cardOverflow).toBeLessThanOrEqual(1);
  expect(body?.rationaleInside).toBe(true);
  expect(body?.aboveComposer).toBe(true);

  // The task page is persistent on desktop: Escape and a missing close button leave it open.
  await browser.keyboard.press("Escape");
  await expect(screen.getByTestId("task-detail")).toHaveAttribute("aria-label", "Ship the modal");
});

test("a task card has no checkbox and the detail adds a blocker", async ({
  app,
  browser,
  screen,
}) => {
  await openWith(browser, 390, 844);
  await app.open("/?page=tasks");

  expect(await browser.evaluate(() => document.querySelector("[data-task-check]") === null)).toBe(
    true,
  );
  expect(
    await browser.evaluate(() =>
      [...document.querySelectorAll("button")].some(
        (item) => item.getAttribute("aria-label") === "Done Ship the modal",
      ),
    ),
  ).toBe(false);

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
  expect(
    await browser.evaluate(() =>
      [...document.querySelectorAll("h2")].some((item) => item.textContent === "Done"),
    ),
  ).toBe(false);
  await expect(today).toContainText("Done today");
  await expect(today).toContainText("Nothing done yet today.");
  const past = screen.getByTestId("task-day-2026-01-01");
  await expect(past).toHaveAttribute("data-open", "false");
  await expect(past).toContainText("1");
  await expect(screen.getByTestId("task-t2")).toHaveCount(0);

  await screen.getByRole("button", { name: /Done.*Jan 1/ }).tap();
  await expect(past).toHaveAttribute("data-open", "true");
  await expect(screen.getByTestId("task-t2")).toBeVisible();
  await expect(screen.getByTestId("task-t2")).toContainText("Review the details");
  await expect(screen.getByTestId("task-t2").getByTestId("task-id-t2")).toHaveText("t2");
});

test("the detail drops the activity history and its backlog toggle parks and reopens the task", async ({
  app,
  browser,
  screen,
}) => {
  const ledger = JSON.parse(JSON.stringify(snapshot.tasks)) as {
    revision: number;
    tasks: Array<{ id: string; status: string; project?: string }>;
  };
  const ship = ledger.tasks[0];
  if (ship === undefined) throw new Error("snapshot is missing the open task");
  ship.project = "Pi UI";

  await browser.setViewport({ width: 1280, height: 800 });
  await browser.route("**/api/tasks/**", async (route) => {
    if (route.request.method === "PATCH") {
      const patch = JSON.parse(route.request.postData ?? "{}") as { status?: string };
      const id = decodeURIComponent(new URL(route.request.url).pathname.split("/").pop() ?? "");
      const task = ledger.tasks.find((item) => item.id === id);
      if (task !== undefined && patch.status !== undefined) task.status = patch.status;
      ledger.revision += 1;
    }
    await route.fulfill({ json: ledger });
  });
  await browser.route("**/api/state**", async (route) => {
    const state = JSON.parse(JSON.stringify(snapshot));
    state.tasks = ledger;
    await route.fulfill({ json: state });
  });

  await app.open("/?page=tasks");
  await screen.getByRole("button", { name: "Open Ship the modal" }).tap();
  const detail = screen.getByTestId("task-detail");
  await expect(detail).toBeVisible();
  await expect(detail.getByTestId("task-history")).toHaveCount(0);
  await expect(detail).not.toContainText("earlier events");

  const toggle = detail.getByTestId("task-detail-backlog");
  await expect(toggle).toHaveText("Backlog");
  await toggle.tap();
  await expect.poll(() => ship.status).toBe("backlog");
  await expect(toggle).toHaveText("Reopen");
  await expect(
    screen.getByTestId("task-project-Pi UI").getByRole("button", { name: "Open Ship the modal" }),
  ).toBeVisible();

  await toggle.tap();
  await expect.poll(() => ship.status).toBe("open");
  await expect(toggle).toHaveText("Backlog");

  await browser.evaluate(() => {
    const card = [...document.querySelectorAll<HTMLElement>("[data-task-card]")].find(
      (item) => item.getAttribute("aria-label") === "Open Ship the modal",
    );
    if (card === undefined) return null;
    const box = card.getBoundingClientRect();
    card.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: box.left + 16,
        clientY: box.top + box.height / 2,
      }),
    );
    return null;
  });
  await screen.getByRole("menuitem", { name: "Backlog Ship the modal" }).tap();
  await expect.poll(() => ship.status).toBe("backlog");
  await expect(toggle).toHaveText("Reopen");
  await expect(screen.getByTestId("task-project-Pi UI")).toContainText("Ship the modal");
});
