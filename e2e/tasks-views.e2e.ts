import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { removeTasks } from "./tasks-helpers.js";

test("switches to tasks with a horizontal swipe and back again", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");

  const chrome = await browser.evaluate(() => {
    const dots = document.querySelector("[data-testid=page-dots]");
    const header = document.querySelector("header");
    const dock = document.querySelector("[data-testid=composer-dock]");
    const row = dock?.querySelector(".ink-line") ?? null;
    const gear = document.querySelector("[data-pi-menu]");
    if (dots === null || dock === null || row === null || gear === null) return null;
    const dotsBox = dots.getBoundingClientRect();
    const gearBox = gear.getBoundingClientRect();
    return {
      noHeader: header === null,
      inRow: row.contains(dots) && row.contains(gear),
      inDock: dock.contains(row),
      gearRightOfDots: gearBox.left >= dotsBox.right,
      gearLast: row.lastElementChild === gear,
      arrows:
        document.querySelector("[aria-label='Show chat'], [aria-label='Show tasks']") !== null,
      inline: Math.abs(dotsBox.top + dotsBox.height / 2 - (gearBox.top + gearBox.height / 2)),
    };
  });
  expect(chrome?.noHeader).toBe(true);
  expect(chrome?.inRow).toBe(true);
  expect(chrome?.inDock).toBe(true);
  expect(chrome?.gearRightOfDots).toBe(true);
  expect(chrome?.gearLast).toBe(true);
  expect(chrome?.arrows).toBe(false);
  expect(chrome?.inline ?? 99).toBeLessThanOrEqual(1);

  const swipe = async (direction: "forward" | "back" | "cancel-back") =>
    browser.evaluate(async (kind) => {
      const pager = document.querySelector("[data-testid=pager]");
      if (!(pager instanceof HTMLElement)) return null;
      const box = pager.getBoundingClientRect();
      const y = box.top + Math.min(120, box.height / 2);
      const start = box.left + box.width * (kind === "forward" ? 0.8 : 0.2);
      const delta = kind === "forward" ? -1 : 1;
      const fire = (type: string, x: number) => {
        pager.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: 7,
            pointerType: "touch",
            isPrimary: true,
            clientX: x,
            clientY: y,
            button: 0,
            buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
          }),
        );
      };
      fire("pointerdown", start);
      fire("pointermove", start + delta * 24);
      fire("pointermove", start + delta * 160);
      // A cancelled touch often reports clientX 0. The page must follow the
      // last real finger position, which is to the right of where it started.
      fire(
        kind === "cancel-back" ? "pointercancel" : "pointerup",
        kind === "cancel-back" ? 0 : start + delta * 160,
      );
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });
      return pager.getAttribute("data-page");
    }, direction);

  expect(await swipe("forward")).toBe("tasks");
  await expect(screen.getByRole("textbox", "New task")).toBeVisible();
  expect(await browser.evaluate(() => new URLSearchParams(location.search).get("page"))).toBe(
    "tasks",
  );

  expect(await swipe("back")).toBe("chat");
  await expect(screen.getByRole("textbox", "Message")).toBeVisible();
  expect(await browser.evaluate(() => new URLSearchParams(location.search).get("page"))).toBe(
    "chat",
  );

  expect(await swipe("forward")).toBe("tasks");
  expect(await swipe("cancel-back")).toBe("chat");
  await expect(screen.getByRole("textbox", "Message")).toBeVisible();
});

test("keeps a rightward touch for the pager instead of the browser", async ({ app, browser }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");

  const claimed = await browser.evaluate(() => {
    const pager = document.querySelector("[data-testid=pager]");
    if (!(pager instanceof HTMLElement)) return null;
    const box = pager.getBoundingClientRect();
    const y = box.top + 120;
    const startX = box.left + box.width * 0.2;
    const touch = (x: number, clientY: number) =>
      new Touch({
        identifier: 1,
        target: pager,
        clientX: x,
        clientY,
      });
    const dispatch = (type: string, x: number, clientY: number) => {
      const point = touch(x, clientY);
      return pager.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: type === "touchend" ? [] : [point],
          targetTouches: type === "touchend" ? [] : [point],
          changedTouches: [point],
        }),
      );
    };
    dispatch("touchstart", startX, y);
    const horizontal = dispatch("touchmove", startX + 48, y + 2);
    dispatch("touchend", startX + 48, y);
    dispatch("touchstart", startX, y);
    const vertical = dispatch("touchmove", startX + 2, y + 48);
    return { horizontal, vertical };
  });

  expect(claimed?.horizontal).toBe(false);
  expect(claimed?.vertical).toBe(true);
});

test("rejects an empty title, a cycle, and a subtask of a done task", async ({ app, browser }) => {
  await app.open("/");
  const result = await browser.evaluate(async () => {
    const post = async (title: string, parentId: string | null = null) => {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, parentId }),
      });
      const ledger = response.ok
        ? ((await response.json()) as { tasks: Array<{ id: string; title: string }> })
        : null;
      return { status: response.status, ledger };
    };
    const patch = async (id: string, body: unknown) => {
      const response = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return response.status;
    };
    const empty = await post("   ");
    const first = await post("cycle left");
    const second = await post("cycle right");
    const left = first.ledger?.tasks.find((task) => task.title === "cycle left");
    const right = second.ledger?.tasks.find((task) => task.title === "cycle right");
    const blocked =
      left !== undefined && right !== undefined
        ? await patch(left.id, { blockedBy: [right.id] })
        : 0;
    const cycle =
      left !== undefined && right !== undefined
        ? await patch(right.id, { blockedBy: [left.id] })
        : 0;
    const closed =
      left !== undefined
        ? await patch(left.id, {
            status: "done",
            completion: {
              timeSpent: "2m",
              tokens: 12,
              evidence: "e2e/tasks.e2e.ts",
            },
          })
        : 0;
    const child = left !== undefined ? await post("too late", left.id) : { status: 0 };
    const longTitle = "L".repeat(450);
    const long = await post(longTitle);
    return {
      empty: empty.status,
      blocked,
      cycle,
      closed,
      child: child.status,
      long: long.status,
      kept: long.ledger?.tasks.some((task) => task.title === longTitle) ?? false,
    };
  });

  expect(result?.empty).toBe(400);
  expect(result?.blocked).toBe(200);
  expect(result?.cycle).toBe(409);
  expect(result?.closed).toBe(200);
  expect(result?.child).toBe(409);
  expect(result?.long).toBe(201);
  expect(result?.kept).toBe(true);
});

test("shows a failed task action beside the control and keeps a long title", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/?page=tasks");
  const composer = screen.getByRole("textbox", "New task");
  await composer.fill("Write the notice");
  await screen.getByRole("button", "Add task").tap();
  const failNextPatch = (message: string) =>
    browser.evaluate((text) => {
      const original = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const method = (
          init?.method ?? (input instanceof Request ? input.method : "GET")
        ).toUpperCase();
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (method === "PATCH" && url.includes("/api/tasks/")) {
          window.fetch = original;
          return Promise.resolve(new Response(text, { status: 409 }));
        }
        return original(input, init);
      };
      return null;
    }, message);

  await failNextPatch("Open subtasks");
  await screen.getByRole("button", { name: "Open Write the notice" }).tap();
  await screen.getByTestId("task-detail-status").tap();
  await expect(screen.getByTestId("task-detail").getByTestId("task-error")).toHaveText(
    "Open subtasks",
  );
  await expect(screen.getByTestId("task-detail-status")).toHaveText("Mark done");
  const cardError = await browser.evaluate(() => {
    const error = document.querySelector("[data-testid=task-error]");
    const card = [...document.querySelectorAll("[data-task-card]")].find((item) =>
      item
        .getAttribute("aria-describedby")
        ?.split(" ")
        .includes(error?.id ?? ""),
    );
    if (!(error instanceof HTMLElement) || !(card instanceof HTMLElement)) return null;
    const errorBox = error.getBoundingClientRect();
    const cardBox = card.getBoundingClientRect();
    return error.parentElement === card.parentElement && errorBox.top >= cardBox.bottom - 1;
  });
  expect(cardError).toBe(true);

  await screen.getByTestId("task-detail-status").tap();
  await expect(screen.getByTestId("task-state")).toHaveText("Done");
  await expect(screen.getByTestId("task-error")).toHaveCount(0);

  const longTitle = "M".repeat(450);
  await screen.getByRole("textbox", "New task").fill(longTitle);
  await screen.getByRole("button", "Add task").tap();
  await expect(screen.getByText(longTitle, { exact: true })).toBeVisible();
  await expect(screen.getByTestId("composer-error")).toHaveCount(0);
});

test("shows created and closed times at the bottom right of a task card", async ({
  app,
  browser,
  screen,
}) => {
  const now = Date.now();
  const at = (agoMs: number) => new Date(now - agoMs).toISOString();
  // The done list keys groups by calendar day and only opens today's group, so
  // keep the close inside today even when "ten minutes ago" crosses midnight.
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 1, 0, 0);
  const closedToday = new Date(Math.min(startOfToday.getTime(), now)).toISOString();
  await browser.setViewport({ width: 1280, height: 800 });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({
      json: {
        conversationId: "task-card-times-e2e",
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
              id: "open-card",
              title: "Keep the ledger open",
              status: "open",
              parentId: null,
              blockedBy: [],
              createdAt: at(3_600_000),
              proposedAt: null,
              completedAt: null,
              completion: null,
            },
            {
              id: "done-card",
              title: "Close the ledger",
              status: "done",
              parentId: null,
              blockedBy: [],
              createdAt: at(7_200_000),
              proposedAt: null,
              completedAt: closedToday,
              completion: { evidence: "e2e/tasks.e2e.ts" },
            },
          ],
        },
      },
    });
  });
  await app.open("/?page=tasks");
  await expect(screen.getByTestId("task-open-card")).toBeVisible();
  await expect(screen.getByTestId("task-done-card")).toBeVisible();

  const layout = await browser.evaluate(() => {
    const measure = (id: string) => {
      const card = document.querySelector(`[data-testid="task-${id}"] [data-task-card]`);
      if (!(card instanceof HTMLElement)) return null;
      const times = card.querySelector('[data-testid="task-card-times"]');
      const title = card.querySelector(".line-clamp-2");
      if (!(times instanceof HTMLElement) || !(title instanceof HTMLElement)) return null;
      const cardBox = card.getBoundingClientRect();
      const timesBox = times.getBoundingClientRect();
      const titleBox = title.getBoundingClientRect();
      const lineHeight = Number.parseFloat(getComputedStyle(title).lineHeight) || titleBox.height;
      return {
        created: times.textContent?.includes("Created") ?? false,
        closed: times.textContent?.includes("Closed") ?? false,
        rightInside: timesBox.right <= cardBox.right + 0.5,
        leftInside: timesBox.left >= cardBox.left - 0.5,
        belowTitle: timesBox.top >= titleBox.top + lineHeight - 0.5,
        noOverflow: card.scrollWidth <= card.clientWidth,
      };
    };
    return { open: measure("open-card"), done: measure("done-card") };
  });
  expect(layout?.open).toEqual({
    created: true,
    closed: false,
    rightInside: true,
    leftInside: true,
    belowTitle: true,
    noOverflow: true,
  });
  expect(layout?.done).toEqual({
    created: true,
    closed: true,
    rightInside: true,
    leftInside: true,
    belowTitle: true,
    noOverflow: true,
  });
});

test("keeps the id chip at the top right above the created line", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 800 });
  await app.open("/?page=tasks");
  const composer = screen.getByRole("textbox", "New task");
  await composer.fill("Chip anchor");
  await screen.getByRole("button", "Add task").tap();
  const list = screen.getByTestId("task-list");
  await expect(list.getByText("Chip anchor", { exact: true })).toBeVisible();

  const cardId = await browser.evaluate(() => {
    const card = [...document.querySelectorAll("[data-task-card]")].find((item) =>
      item.textContent?.includes("Chip anchor"),
    );
    const chip = card?.querySelector<HTMLElement>('[data-testid^="task-id-"]');
    const title = card?.querySelector<HTMLElement>(".line-clamp-2");
    if (
      !(card instanceof HTMLElement) ||
      !(chip instanceof HTMLElement) ||
      !(title instanceof HTMLElement)
    ) {
      return null;
    }
    const style = getComputedStyle(chip);
    const box = card.getBoundingClientRect();
    const describedBy = (card.getAttribute("aria-describedby") ?? "")
      .split(/\s+/)
      .filter((part) => part !== "");
    return {
      id: chip.textContent?.trim() ?? "",
      title: chip.getAttribute("title"),
      label: chip.getAttribute("aria-label"),
      classes: chip.className,
      background: style.backgroundColor,
      afterTitle: (chip.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_PRECEDING) !== 0,
      rightAligned: Math.abs(box.right - chip.getBoundingClientRect().right) <= 16,
      idCount: card.querySelectorAll('[data-testid^="task-id-"]').length,
      describedBy,
      describedIsChip: describedBy.some((part) => document.getElementById(part) === chip),
    };
  });
  expect(cardId?.id).toHaveLength(4);
  expect(cardId?.title).toBe(cardId?.id);
  expect(cardId?.label).toBe(`task ${cardId?.id}`);
  expect(cardId?.classes).toContain("font-mono");
  expect(cardId?.classes).toContain("text-[11px]");
  expect(cardId?.background).toBe("rgba(0, 0, 0, 0)");
  expect(cardId?.afterTitle).toBe(true);
  expect(cardId?.rightAligned).toBe(true);
  expect(cardId?.idCount).toBe(1);
  expect(cardId?.describedBy).toContain(`task-id-${cardId?.id}`);
  expect(cardId?.describedIsChip).toBe(true);
  await expect(composer).toHaveValue("");
  await expect(screen.getByTestId("subtask-progress")).toHaveCount(0);

  await removeTasks(browser, ["Chip anchor"]);
});

test("shows the single task list without filter tabs and groups done work by day", async ({
  app,
  browser,
  screen,
}) => {
  const now = new Date();
  const today = new Date(now);
  today.setHours(12, 0, 0, 0);
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const key = (date: Date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
      date.getDate(),
    ).padStart(2, "0")}`;
  const at = (date: Date) => date.toISOString();
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({
      json: {
        conversationId: "task-list-e2e",
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
              id: "done-today",
              title: "Finished today",
              status: "done",
              parentId: null,
              blockedBy: [],
              createdAt: at(today),
              proposedAt: null,
              completedAt: at(today),
              completion: { evidence: "e2e/tasks.e2e.ts" },
            },
            {
              id: "done-yesterday",
              title: "Finished yesterday",
              status: "done",
              parentId: null,
              blockedBy: [],
              createdAt: at(yesterday),
              proposedAt: null,
              completedAt: at(yesterday),
              completion: { evidence: "e2e/tasks.e2e.ts" },
            },
            {
              id: "open-task",
              title: "Still open",
              status: "open",
              parentId: null,
              blockedBy: [],
              createdAt: at(yesterday),
              proposedAt: null,
              completedAt: null,
              completion: null,
            },
            {
              id: "blocked-task",
              title: "Waiting on open",
              status: "open",
              parentId: null,
              blockedBy: ["open-task"],
              createdAt: at(yesterday),
              proposedAt: null,
              completedAt: null,
              completion: null,
            },
            {
              id: "proposal",
              title: "A proposal",
              status: "proposed",
              parentId: null,
              blockedBy: [],
              createdAt: at(today),
              proposedAt: at(today),
              rationale: "Try this next.",
              completedAt: null,
              completion: null,
            },
          ],
        },
      },
    });
  });
  await app.open("/?page=tasks");
  await expect(screen.getByTestId("task-filters")).toHaveCount(0);
  await expect(screen.getByTestId("task-filter-active")).toHaveCount(0);
  await expect(screen.getByTestId("task-filter-blocked")).toHaveCount(0);
  await expect(screen.getByTestId("task-filter-proposed")).toHaveCount(0);

  await expect(screen.getByTestId("task-list")).toBeVisible();
  await expect(screen.getByTestId("task-section-needs")).toBeVisible();
  await expect(screen.getByTestId("proposal-proposal")).toBeVisible();
  await expect(screen.getByTestId("task-open-task")).toBeVisible();
  await expect(screen.getByTestId("task-blocked-task")).toBeVisible();

  const openHeader = await browser.evaluate(() => {
    const open = document.querySelector<HTMLElement>(
      '[data-testid="task-section-active"] [data-slot="collapsible-trigger"]',
    );
    const openCount = open?.querySelectorAll<HTMLElement>("span")[1];
    if (open == null || openCount == null) return null;
    const openBox = open.getBoundingClientRect();
    return {
      countRight: openCount.getBoundingClientRect().right > openBox.left + openBox.width / 2,
      chevron: open.querySelector("svg") !== null,
    };
  });
  expect(openHeader).toEqual({ countRight: true, chevron: true });

  await screen.getByRole("tab", "Chat").tap();
  await expect(screen.getByRole("textbox", "Message")).toBeVisible();
  await screen.getByRole("tab", "Tasks").tap();
  await expect(screen.getByTestId("task-filters")).toHaveCount(0);
  await expect(screen.getByTestId("task-filter-proposed")).toHaveCount(0);
  await expect(screen.getByTestId("proposal-proposal")).toBeVisible();

  const todayGroup = screen.getByTestId(`task-day-${key(today)}`);
  await expect(todayGroup).toContainText("Done today");
  await expect(todayGroup).toContainText("Finished today");
  await expect(todayGroup).toContainText("1");
  const yesterdayGroup = screen.getByTestId(`task-day-${key(yesterday)}`);
  await expect(yesterdayGroup).toContainText("Done yesterday");
  await expect(yesterdayGroup).toHaveAttribute("data-open", "false");
  await expect(screen.getByTestId("task-done-yesterday")).toHaveCount(0);

  await screen.getByRole("button", { name: /Done yesterday/ }).tap();
  await expect(yesterdayGroup).toHaveAttribute("data-open", "true");
  await expect(screen.getByTestId("task-done-yesterday")).toBeVisible();

  const header = await browser.evaluate(() => {
    const group = document.querySelector<HTMLElement>('[data-testid^="task-day-"]');
    const trigger = group?.querySelector<HTMLElement>('[data-slot="collapsible-trigger"]');
    if (group === null || trigger == null) return null;
    const label = trigger.firstElementChild;
    const chevron = trigger.querySelector("svg");
    const count = trigger.lastElementChild;
    if (!(label instanceof HTMLElement) || !(chevron instanceof SVGElement) || count === null) {
      return null;
    }
    const labelBox = label.getBoundingClientRect();
    const chevronBox = chevron.getBoundingClientRect();
    const countBox = count.getBoundingClientRect();
    return {
      dark: getComputedStyle(trigger).backgroundColor === getComputedStyle(document.body).color,
      labelLeft: labelBox.right <= chevronBox.left + 1,
      chevronLeftOfCount: chevronBox.right <= countBox.left + 1,
    };
  });
  expect(header).toEqual({ dark: true, labelLeft: true, chevronLeftOfCount: true });

  await browser.setViewport({ width: 360, height: 800 });
  await expect(screen.getByTestId("task-filters")).toHaveCount(0);
  await expect(screen.getByTestId("task-filter-active")).toHaveCount(0);
  await expect(screen.getByTestId("task-filter-blocked")).toHaveCount(0);
  await expect(screen.getByTestId("task-filter-proposed")).toHaveCount(0);
  await expect(screen.getByTestId("task-list")).toBeVisible();
});
