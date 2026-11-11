import type { Browser } from "@e2e-dev/web";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second)).toISOString();

const longBody = Array.from(
  { length: 60 },
  (_, index) => `Paragraph ${index + 1} keeps the task body taller than the pane.`,
).join("\n\n");

function snapshot(count: number) {
  return {
    conversationId: "tasks-scrollbar-e2e",
    messages: [],
    activity: [],
    run: "idle",
    queue: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    context: { tokens: 0, window: null, percent: null },
    tasks: {
      revision: 1_000_000,
      tasks: Array.from({ length: count }, (_, index) => ({
        id: `scroll-${index + 1}`,
        title: `Scroll task ${index + 1}`,
        status: "open",
        parentId: null,
        blockedBy: [],
        createdAt: at(index),
        proposedAt: null,
        body: index === 0 ? longBody : undefined,
        rationale: index === 0 ? longBody : undefined,
        completedAt: null,
        completion: null,
      })),
    },
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

test("keeps the tasks scrollbars in a reserved gutter on both layouts", async ({
  app,
  browser,
  screen,
}) => {
  const payload = snapshot(30);
  await openTasks(app, browser, payload, 1280, 600);
  await expect(screen.getByTestId("task-list")).toBeVisible();

  const desktop = await browser.evaluate(() => {
    const list = document.querySelector<HTMLElement>('[data-testid="task-list"]');
    const pane = list?.parentElement ?? null;
    if (list === null || pane === null) return null;
    const paneBox = pane.getBoundingClientRect();
    const listBox = list.getBoundingClientRect();
    const card = list.querySelector<HTMLElement>("[data-task-card]");
    const cardBox = card?.getBoundingClientRect() ?? null;
    const style = getComputedStyle(pane);
    return {
      gutter: style.scrollbarGutter,
      overflowY: style.overflowY,
      scrolls: pane.scrollHeight > pane.clientHeight,
      gutterWidth: pane.offsetWidth - pane.clientWidth,
      listInset: paneBox.right - listBox.right,
      cardInset: cardBox === null ? null : paneBox.right - cardBox.right,
      cardLeft: cardBox?.left ?? null,
      cardWidth: cardBox?.width ?? null,
      horizontalOverflow: pane.scrollWidth > pane.clientWidth + 1,
    };
  });
  expect(desktop?.gutter).toBe("stable");
  expect(desktop?.overflowY).toBe("auto");
  expect(desktop?.scrolls).toBe(true);
  expect(desktop?.horizontalOverflow).toBe(false);
  expect(desktop?.gutterWidth ?? 0).toBeGreaterThan(0);
  expect(desktop?.listInset ?? 0).toBeGreaterThanOrEqual(desktop?.gutterWidth ?? 0);
  expect(desktop?.cardInset ?? 0).toBeGreaterThanOrEqual(desktop?.gutterWidth ?? 0);

  await screen.getByRole("button", { name: "Open Scroll task 1" }).tap();
  await expect(screen.getByTestId("task-body")).toBeVisible();
  const detail = await browser.evaluate(() => {
    const body = document.querySelector<HTMLElement>('[data-testid="task-body"]');
    const card = document.querySelector<HTMLElement>('[data-testid="task-detail"]');
    if (body === null || card === null) return null;
    const bodyBox = body.getBoundingClientRect();
    const cardBox = card.getBoundingClientRect();
    const style = getComputedStyle(body);
    return {
      gutter: style.scrollbarGutter,
      scrolls: body.scrollHeight > body.clientHeight,
      inside: bodyBox.right <= cardBox.right + 1,
      horizontalOverflow: body.scrollWidth > body.clientWidth + 1,
    };
  });
  expect(detail?.gutter).toBe("stable");
  expect(detail?.scrolls).toBe(true);
  expect(detail?.inside).toBe(true);
  expect(detail?.horizontalOverflow).toBe(false);

  // The reserved gutter keeps card geometry identical when the list no longer overflows.
  await openTasks(app, browser, snapshot(2), 1280, 600);
  await expect(screen.getByTestId("task-list")).toBeVisible();
  const shortList = await browser.evaluate(() => {
    const list = document.querySelector<HTMLElement>('[data-testid="task-list"]');
    const pane = list?.parentElement ?? null;
    const card = list?.querySelector<HTMLElement>("[data-task-card]") ?? null;
    if (list === null || pane === null || card === null) return null;
    return {
      scrolls: pane.scrollHeight > pane.clientHeight,
      gutter: getComputedStyle(pane).scrollbarGutter,
      cardLeft: card.getBoundingClientRect().left,
      cardWidth: card.getBoundingClientRect().width,
    };
  });
  expect(shortList?.scrolls).toBe(false);
  expect(shortList?.gutter).toBe("stable");
  expect(shortList?.cardLeft).toBeCloseTo(desktop?.cardLeft ?? -1, 1);
  expect(shortList?.cardWidth ?? 0).toBeCloseTo(desktop?.cardWidth ?? 0, 1);

  await openTasks(app, browser, payload, 390, 844);
  const narrow = await browser.evaluate(() => {
    const page = document.querySelector<HTMLElement>('[data-testid="tasks-page"]');
    if (page === null) return null;
    const style = getComputedStyle(page);
    return {
      layout: page.getAttribute("data-layout"),
      gutter: style.scrollbarGutter,
      overflowY: style.overflowY,
      horizontalOverflow: page.scrollWidth > page.clientWidth + 1,
    };
  });
  expect(narrow?.layout).toBe("stack");
  expect(narrow?.gutter).toBe("stable");
  expect(narrow?.overflowY).toBe("auto");
  expect(narrow?.horizontalOverflow).toBe(false);

  await screen.getByRole("button", { name: "Open Scroll task 1" }).tap();
  await expect(screen.getByTestId("task-body")).toBeVisible();
  const narrowDetail = await browser.evaluate(() => {
    const body = document.querySelector<HTMLElement>('[data-testid="task-body"]');
    const card = document.querySelector<HTMLElement>('[data-testid="task-detail"]');
    if (body === null || card === null) return null;
    const bodyBox = body.getBoundingClientRect();
    const cardBox = card.getBoundingClientRect();
    return {
      gutter: getComputedStyle(body).scrollbarGutter,
      scrolls: body.scrollHeight > body.clientHeight,
      inside: bodyBox.right <= cardBox.right + 1,
      horizontalOverflow: body.scrollWidth > body.clientWidth + 1,
    };
  });
  expect(narrowDetail?.gutter).toBe("stable");
  expect(narrowDetail?.scrolls).toBe(true);
  expect(narrowDetail?.inside).toBe(true);
  expect(narrowDetail?.horizontalOverflow).toBe(false);
});
