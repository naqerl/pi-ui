import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createOpenTask } from "./tasks-helpers";

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
  await createOpenTask(screen, "Write the notice");
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
  await createOpenTask(screen, longTitle);
  await expect(screen.getByTestId("task-title")).toContainText(longTitle);
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

test("keeps every card detail on one clipped meta line below a long title", async ({
  app,
  browser,
  screen,
}) => {
  const now = new Date();
  const longTitle =
    "Ship the release checklist through the complete deployment pipeline without losing context";
  const longProject = "alpha-with-an-extremely-long-project-name-that-must-not-push-the-card";
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({
      json: {
        conversationId: "task-meta-e2e",
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
              id: "meta-card",
              title: longTitle,
              status: "open",
              project: longProject,
              parentId: null,
              blockedBy: [],
              createdAt: now.toISOString(),
              proposedAt: null,
              completedAt: null,
              completion: null,
            },
          ],
        },
      },
    });
  });

  const layout = async () =>
    browser.evaluate(() => {
      const card = document.querySelector<HTMLElement>(
        '[data-testid="task-meta-card"] [data-task-card]',
      );
      const title = card?.querySelector<HTMLElement>(".line-clamp-2");
      const meta = card?.querySelector<HTMLElement>('[data-testid="task-card-meta"]');
      const chip = card?.querySelector<HTMLElement>('[data-testid="task-id-meta-card"]');
      const times = card?.querySelector<HTMLElement>('[data-testid="task-card-times"]');
      if (
        !(card instanceof HTMLElement) ||
        !(title instanceof HTMLElement) ||
        !(meta instanceof HTMLElement) ||
        !(chip instanceof HTMLElement) ||
        !(times instanceof HTMLElement)
      ) {
        return null;
      }
      const cardBox = card.getBoundingClientRect();
      const titleBox = title.getBoundingClientRect();
      const metaBox = meta.getBoundingClientRect();
      const chipBox = chip.getBoundingClientRect();
      const timesBox = times.getBoundingClientRect();
      return {
        id: chip.textContent?.trim() ?? "",
        metaBelowTitle: metaBox.top >= titleBox.bottom - 0.5,
        metaInsideCard: metaBox.left >= cardBox.left - 0.5 && metaBox.right <= cardBox.right + 0.5,
        idInsideMeta: chipBox.left >= metaBox.left - 0.5 && chipBox.right <= metaBox.right + 0.5,
        timesInsideMeta:
          timesBox.left >= metaBox.left - 0.5 && timesBox.right <= metaBox.right + 0.5,
        idReadable: chipBox.width > 0 && chip.textContent?.trim().length === 4,
        metaClipped: getComputedStyle(meta).overflowX === "hidden",
        cardOverflow: card.scrollWidth > card.clientWidth,
        pageOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    });

  for (const width of [1280, 900, 390]) {
    await browser.setViewport({ width, height: 800 });
    await app.open("/?page=tasks");
    await expect(screen.getByTestId("task-meta-card")).toBeVisible();
    const result = await layout();
    expect(result?.id).toHaveLength(4);
    expect(result?.metaBelowTitle).toBe(true);
    expect(result?.metaInsideCard).toBe(true);
    expect(result?.idInsideMeta).toBe(true);
    expect(result?.timesInsideMeta).toBe(true);
    expect(result?.idReadable).toBe(true);
    expect(result?.metaClipped).toBe(true);
    expect(result?.cardOverflow).toBe(false);
    expect(result?.pageOverflow).toBe(false);
  }
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
              project: "pi-ui",
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
  await expect(screen.getByTestId("task-project-label-proposal")).toHaveText("pi-ui");
  await expect(screen.getByTestId("task-project-label-proposal")).toHaveAttribute("title", "pi-ui");

  const approval = await browser.evaluate(() => {
    const row = document.querySelector<HTMLElement>('[data-testid="proposal-decision"]');
    const buttons = [...(row?.querySelectorAll("button") ?? [])];
    return {
      buttons: buttons.length,
      icons: buttons.map((button) => button.querySelector("svg")?.getAttribute("data-icon") ?? ""),
      row: row !== null && getComputedStyle(row).flexDirection === "row",
      rightAligned: row !== null && getComputedStyle(row).justifyContent === "flex-end",
    };
  });
  expect(approval).toEqual({
    buttons: 2,
    icons: ["close", "check"],
    row: true,
    rightAligned: true,
  });

  const headers = await browser.evaluate(() => {
    const measure = (id: string) => {
      const header = document.querySelector<HTMLElement>(
        `[data-testid="${id}"] [data-slot="collapsible-trigger"]`,
      );
      const count = header?.querySelectorAll<HTMLElement>("span")[1];
      const chevron = header?.querySelector("svg");
      if (header == null || count == null || !(chevron instanceof SVGElement)) return null;
      const box = header.getBoundingClientRect();
      const style = getComputedStyle(header);
      return {
        background: style.backgroundColor,
        color: style.color,
        font: style.font,
        height: box.height,
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
        countRight: count.getBoundingClientRect().right > box.left + box.width / 2,
        chevron: true,
        chevronBeforeCount:
          (chevron.compareDocumentPosition(count) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
      };
    };
    return { needs: measure("task-section-needs"), open: measure("task-section-active") };
  });
  expect(headers.needs).not.toBeNull();
  expect(headers.needs).toEqual(headers.open);
  expect(headers.open).toMatchObject({
    countRight: true,
    chevron: true,
    chevronBeforeCount: true,
  });

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
    const count = [...trigger.querySelectorAll<HTMLElement>("span")].find(
      (span) => span !== label && /^\d+$/.test(span.textContent?.trim() ?? ""),
    );
    if (
      !(label instanceof HTMLElement) ||
      !(chevron instanceof SVGElement) ||
      count === undefined
    ) {
      return null;
    }
    const labelBox = label.getBoundingClientRect();
    const chevronBox = chevron.getBoundingClientRect();
    const countBox = count.getBoundingClientRect();
    return {
      dark: getComputedStyle(trigger).backgroundColor === getComputedStyle(document.body).color,
      labelLeft: labelBox.right <= chevronBox.left + 1,
      chevronLeftOfCount: chevronBox.right <= countBox.left + 1,
      chevronBeforeCount:
        (chevron.compareDocumentPosition(count) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
    };
  });
  expect(header).toEqual({
    dark: true,
    labelLeft: true,
    chevronLeftOfCount: true,
    chevronBeforeCount: true,
  });

  await browser.setViewport({ width: 360, height: 800 });
  await expect(screen.getByTestId("task-filters")).toHaveCount(0);
  await expect(screen.getByTestId("task-filter-active")).toHaveCount(0);
  await expect(screen.getByTestId("task-filter-blocked")).toHaveCount(0);
  await expect(screen.getByTestId("task-filter-proposed")).toHaveCount(0);
  await expect(screen.getByTestId("task-list")).toBeVisible();
});

test("uses one gap between every section header and the cards below it", async ({
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
  await browser.setViewport({ width: 390, height: 844 });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({
      json: {
        conversationId: "task-spacing-e2e",
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
              id: "alpha-task",
              title: "First project work",
              status: "open",
              project: "Alpha",
              parentId: null,
              blockedBy: [],
              createdAt: at(yesterday),
              proposedAt: null,
              completedAt: null,
              completion: null,
            },
            {
              id: "beta-task",
              title: "Second project work",
              status: "open",
              project: "Beta",
              parentId: null,
              blockedBy: [],
              createdAt: at(yesterday),
              proposedAt: null,
              completedAt: null,
              completion: null,
            },
            {
              id: "done-today",
              title: "Finished today",
              status: "done",
              parentId: null,
              blockedBy: [],
              createdAt: at(today),
              proposedAt: null,
              completedAt: at(today),
              completion: { evidence: "e2e/tasks-views.e2e.ts" },
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
              completion: { evidence: "e2e/tasks-views.e2e.ts" },
            },
          ],
        },
      },
    });
  });
  await app.open("/?page=tasks");
  await expect(screen.getByTestId("task-project-Alpha")).toBeVisible();
  await expect(screen.getByTestId("task-project-Beta")).toBeVisible();
  await expect(screen.getByTestId("task-alpha-task")).toBeVisible();
  await expect(screen.getByTestId("task-beta-task")).toBeVisible();

  const yesterdayGroup = screen.getByTestId(`task-day-${key(yesterday)}`);
  await expect(yesterdayGroup).toHaveAttribute("data-open", "false");
  await screen.getByRole("button", { name: /Done yesterday/ }).tap();
  await expect(yesterdayGroup).toHaveAttribute("data-open", "true");
  await expect(screen.getByTestId("task-done-yesterday")).toBeVisible();

  const gaps = await browser.evaluate(
    (ids) => {
      const trigger = (testId: string) => {
        const element = document.querySelector<HTMLElement>(
          `[data-testid="${testId}"] [data-slot="collapsible-trigger"]`,
        );
        return element?.getBoundingClientRect() ?? null;
      };
      const cards = (testId: string) => {
        const group = document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
        if (group === null) return null;
        const boxes = [...group.querySelectorAll<HTMLElement>("[data-task-card]")].map((card) =>
          card.getBoundingClientRect(),
        );
        return boxes.length === 0 ? null : { first: boxes[0], last: boxes[boxes.length - 1] };
      };
      const open = trigger("task-section-active");
      const alpha = trigger(ids.alphaHeader);
      const beta = trigger(ids.betaHeader);
      const todayHeader = trigger(ids.todayHeader);
      const yesterdayHeader = trigger(ids.yesterdayHeader);
      const alphaCards = cards(ids.alphaHeader);
      const betaCards = cards(ids.betaHeader);
      const todayCards = cards(ids.todayHeader);
      const yesterdayCards = cards(ids.yesterdayHeader);
      if (
        open === null ||
        alpha === null ||
        beta === null ||
        todayHeader === null ||
        yesterdayHeader === null ||
        alphaCards === null ||
        betaCards === null ||
        todayCards === null ||
        yesterdayCards === null
      ) {
        return null;
      }
      return {
        openHeaderToProjectHeader: alpha.top - open.bottom,
        projectHeaderToFirstCard: alphaCards.first.top - alpha.bottom,
        lastCardToNextProjectHeader: beta.top - alphaCards.last.bottom,
        secondProjectHeaderToFirstCard: betaCards.first.top - beta.bottom,
        doneDayHeaderToFirstCard: todayCards.first.top - todayHeader.bottom,
        lastCardToNextDoneDayHeader: yesterdayHeader.top - todayCards.last.bottom,
        yesterdayHeaderToFirstCard: yesterdayCards.first.top - yesterdayHeader.bottom,
      };
    },
    {
      alphaHeader: "task-project-Alpha",
      betaHeader: "task-project-Beta",
      todayHeader: `task-day-${key(today)}`,
      yesterdayHeader: `task-day-${key(yesterday)}`,
    },
  );
  expect(gaps).not.toBeNull();
  const values = Object.values(gaps ?? {});
  expect(values).toHaveLength(7);
  const gap = values[0] ?? 0;
  expect(Math.abs(gap - 8)).toBeLessThanOrEqual(1);
  for (const value of values) expect(Math.abs(value - gap)).toBeLessThanOrEqual(1);
});
