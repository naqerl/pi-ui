import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second)).toISOString();

const snapshot = {
  conversationId: "task-modal-e2e",
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

test("a task card opens a full-screen modal that closes with Escape, the backdrop and its button", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: JSON.parse(JSON.stringify(snapshot)) });
  });
  await app.open("/?page=tasks");

  await screen.getByRole("button", { name: "Open Ship the modal" }).tap();
  await expect(screen.getByTestId("task-modal")).toBeVisible();
  await expect(
    screen.getByText("The modal keeps the full text readable without widening the card.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    screen.getByTestId("task-modal").getByText("Review the details", { exact: true }),
  ).toBeVisible();

  const sheet = await browser.evaluate(() => {
    const dialog = document.querySelector<HTMLDialogElement>('[data-testid="task-modal"]');
    const body = dialog?.querySelector<HTMLElement>(".overflow-y-auto") ?? null;
    if (dialog === null) return null;
    const box = dialog.getBoundingClientRect();
    return {
      open: dialog.open,
      insideWidth: box.width <= window.innerWidth,
      leftMargin: box.left > 0,
      rightMargin: window.innerWidth - box.right > 0,
      overflow: body === null ? "" : getComputedStyle(body).overflowY,
    };
  });
  expect(sheet).toEqual({
    open: true,
    insideWidth: true,
    leftMargin: true,
    rightMargin: true,
    overflow: "auto",
  });

  await browser.keyboard.press("Escape");
  await expect(screen.getByTestId("task-modal")).toHaveCount(0);

  await screen.getByRole("button", { name: "Open Ship the modal" }).tap();
  await expect(screen.getByTestId("task-modal")).toBeVisible();
  await screen.getByTestId("task-modal-close").tap();
  await expect(screen.getByTestId("task-modal")).toHaveCount(0);

  await screen.getByRole("button", { name: "Open Ship the modal" }).tap();
  await expect(screen.getByTestId("task-modal")).toBeVisible();
  await browser.evaluate(() => {
    document
      .querySelector<HTMLDialogElement>('[data-testid="task-modal"]')
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return null;
  });
  await expect(screen.getByTestId("task-modal")).toHaveCount(0);
});

test("the card action buttons work without opening the modal", async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: JSON.parse(JSON.stringify(snapshot)) });
  });
  await app.open("/?page=tasks");

  await screen.getByRole("button", { name: "Done Ship the modal" }).tap();
  await expect(screen.getByTestId("task-modal")).toHaveCount(0);

  await screen.getByRole("button", { name: "Add blocker to Ship the modal" }).tap();
  await expect(screen.getByTestId("task-menu")).toBeVisible();
  await expect(screen.getByTestId("task-modal")).toHaveCount(0);
});

test("proposal approve and dismiss buttons act from the keyboard without opening the modal", async ({
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
  await expect(screen.getByTestId("task-modal")).toHaveCount(0);

  const dismiss = screen.getByRole("button", { name: "Dismiss Clean the cache" });
  await dismiss.focus();
  await browser.keyboard.press("Space");
  await expect.poll(() => deletes).toBe(1);
  await expect(screen.getByTestId("task-modal")).toHaveCount(0);
});

test("the Proposed group heading carries its own card surface", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: JSON.parse(JSON.stringify(snapshot)) });
  });
  await app.open("/?page=tasks");
  const heading = await browser.evaluate(() => {
    const node = document.querySelector<HTMLElement>('[data-testid="task-proposals"] h2');
    if (node === null) return null;
    const style = getComputedStyle(node);
    return { className: node.className, background: style.backgroundColor };
  });
  expect(heading?.className).toContain("bg-surface");
  expect(heading?.background).not.toBe("rgba(0, 0, 0, 0)");
  await expect(screen.getByText("Proposed (1)", { exact: true })).toBeVisible();
});
