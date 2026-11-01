import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

// The e2e server and its task store are shared by every test file: leave no tasks behind.
async function removeTasks(browser: Browser, titles: readonly string[]) {
  const left = await browser.evaluate(async (names) => {
    const matching = async () =>
      (
        (await (await fetch("/api/tasks")).json()).tasks as Array<{ id: string; title: string }>
      ).filter((task) => names.includes(task.title));
    for (const task of await matching()) {
      await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
    }
    return (await matching()).length;
  }, titles);
  expect(left).toBe(0);
}

test("keeps a todo with subtasks and blockers on the tasks page", { timeout: 300_000 }, async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 800 });
  await app.open("/");
  await expect(screen.getByRole("textbox", "Message")).toBeVisible();

  await screen.getByRole("tab", "Tasks").tap();
  const composer = screen.getByRole("textbox", "New task");
  await expect(composer).toBeVisible();

  await composer.fill("Write the ledger");
  await screen.getByRole("button", "Add task").tap();
  const list = screen.getByTestId("task-list");
  await expect(list.getByText("Write the ledger", { exact: true })).toBeVisible();
  expect(await browser.evaluate(() => document.querySelector("[data-task-check]") === null)).toBe(
    true,
  );
  await expect(composer).toHaveValue("");
  await expect(screen.getByTestId("subtask-progress")).toHaveCount(0);

  const mouseHold = await browser.evaluate(async () => {
    const card = [...document.querySelectorAll("[data-task-card]")].find((item) =>
      item.textContent?.includes("Write the ledger"),
    );
    if (!(card instanceof HTMLElement)) return null;
    const box = card.getBoundingClientRect();
    const fire = (type: string) => {
      card.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 3,
          pointerType: "mouse",
          isPrimary: true,
          clientX: box.left + 24,
          clientY: box.top + box.height / 2,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
        }),
      );
    };
    fire("pointerdown");
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 560);
    });
    fire("pointerup");
    return document.querySelector("[data-testid=task-menu]") !== null;
  });
  expect(mouseHold).toBe(false);

  const selectedBefore = await browser.evaluate(
    () => document.querySelector("[data-testid=task-detail]")?.getAttribute("aria-label") ?? null,
  );
  const longPress = await browser.evaluate(async () => {
    const card = [...document.querySelectorAll("[data-task-card]")].find((item) =>
      item.textContent?.includes("Write the ledger"),
    );
    if (!(card instanceof HTMLElement)) return null;
    const box = card.getBoundingClientRect();
    const x = box.left + 24;
    const y = box.top + box.height / 2;
    const fire = (type: string) => {
      card.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 4,
          pointerType: "touch",
          isPrimary: true,
          clientX: x,
          clientY: y,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
        }),
      );
    };
    fire("pointerdown");
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 560);
    });
    fire("pointerup");
    card.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return document.querySelector("[data-testid=task-detail]")?.getAttribute("aria-label") ?? null;
  });
  // The long press leaves the desktop's selected task alone instead of opening another one.
  expect(longPress).toBe(selectedBefore);
  await expect(screen.getByTestId("task-menu")).toBeVisible();
  await expect(list.getByRole("button", { name: /Done Write the ledger/ })).toHaveCount(0);

  await screen.getByRole("menuitem", "Subtask of Write the ledger").tap();
  const subtask = screen.getByRole("textbox", "New subtask");
  await expect(subtask).toBeVisible();
  await subtask.fill("Store tasks.json");
  await screen.getByRole("button", "Add task").tap();
  await expect(list.getByText("Store tasks.json", { exact: true })).toBeVisible();
  await expect(list.getByText("0 of 1 subtasks done", { exact: true })).toBeVisible();
  const cards = await browser.evaluate(() => {
    const page = getComputedStyle(document.body).backgroundColor;
    const read = (title: string) => {
      const card = [...document.querySelectorAll("[data-task-card]")].find((item) =>
        item.textContent?.includes(title),
      );
      if (!(card instanceof HTMLElement)) return null;
      const background = getComputedStyle(card).backgroundColor;
      const match = background.match(/^rgba?\(([^)]+)\)$/);
      const parts = match?.[1]?.split(/[,\s/]+/).filter(Boolean) ?? [];
      const alpha = parts.length === 4 ? Number(parts[3]) : 1;
      return { background, alpha, page };
    };
    return {
      parent: read("Write the ledger"),
      child: read("Store tasks.json"),
    };
  });
  expect(cards?.parent?.background).not.toBe(cards?.parent?.page);
  expect(cards?.parent?.alpha).toBe(1);
  expect(cards?.child?.background).toBe(cards?.parent?.background);
  expect(cards?.child?.alpha).toBe(1);

  await screen.getByRole("button", "New top-level task").tap();
  await screen.getByRole("textbox", "New task").fill("Review the diff");
  await screen.getByRole("button", "Add task").tap();
  await expect(list.getByText("Review the diff", { exact: true })).toBeVisible();

  await browser.evaluate(() => {
    const card = [...document.querySelectorAll("[data-task-card]")].find((item) =>
      item.textContent?.includes("Write the ledger"),
    );
    if (!(card instanceof HTMLElement)) return null;
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
  await screen.getByRole("menuitem", "Blockers for Write the ledger").tap();
  await screen.getByRole("button", "Blocked by Review the diff").tap();
  await expect(list.getByText("Blocked by Review the diff", { exact: true })).toBeVisible();

  await browser.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return null;
  });
  await expect(screen.getByTestId("task-menu")).toHaveCount(0);
  await screen.getByRole("button", { name: "Open Write the ledger" }).tap();
  const parentDone = await browser.evaluate(() => {
    const button = document.querySelector<HTMLElement>('[data-testid="task-detail-status"]');
    return button?.getAttribute("aria-disabled") === "true";
  });
  expect(parentDone).toBe(true);
  const blockedTap = await browser.evaluate(async () => {
    const button = document.querySelector<HTMLElement>('[data-testid="task-detail-status"]');
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return {
      disabled: button?.getAttribute("aria-disabled") ?? null,
      label: button?.textContent?.trim() ?? null,
    };
  });
  expect(blockedTap).toEqual({ disabled: "true", label: "Mark done" });

  await screen.getByRole("button", { name: "Open Review the diff" }).tap();
  await screen.getByTestId("task-detail-status").tap();
  await expect(list.getByText("Blocked by Review the diff", { exact: true })).not.toBeVisible();
  await screen.getByRole("button", { name: "Open Store tasks.json" }).tap();
  await screen.getByTestId("task-detail-status").tap();
  await expect(screen.getByTestId("task-state")).toHaveText("Done");
  await expect(list.getByText("1 of 1 subtasks done", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Open Write the ledger" }).tap();
  await screen.getByTestId("task-detail-status").tap();
  await expect(screen.getByTestId("task-state")).toHaveText("Done");

  expect(await browser.evaluate(() => new URLSearchParams(location.search).get("page"))).toBe(
    "tasks",
  );
  await app.open("/?page=tasks");
  await expect(screen.getByRole("textbox", "New task")).toBeVisible();
  await expect(list.getByText("Write the ledger", { exact: true })).toBeVisible();
  await expect(list.getByText("Store tasks.json", { exact: true })).toBeVisible();
  await expect(list.getByText("1 of 1 subtasks done", { exact: true })).toBeVisible();

  await browser.evaluate(() => {
    const card = [...document.querySelectorAll('[data-state="done"] > [data-task-card]')].find(
      (item) => item.textContent?.includes("Review the diff"),
    );
    if (!(card instanceof HTMLElement)) return null;
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
  await screen.getByRole("menuitem", "Remove Review the diff").tap();
  await expect(screen.getByText("Review the diff", { exact: true })).not.toBeVisible();

  await screen.getByRole("tab", "Chat").tap();
  await expect(screen.getByRole("textbox", "Message")).toBeVisible();
  await expect(screen.getByTestId("subtask-progress")).toHaveCount(0);
  expect(await browser.evaluate(() => new URLSearchParams(location.search).get("page"))).toBe(
    "chat",
  );
});

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
    const row = dock?.firstElementChild ?? null;
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
  await screen.getByRole("textbox", "New task").fill("Review the notice");
  await screen.getByRole("button", "Add task").tap();

  const openMenu = (title: string) =>
    browser.evaluate((name) => {
      const card = [...document.querySelectorAll("[data-task-card]")].find((item) =>
        item.textContent?.includes(name),
      );
      if (!(card instanceof HTMLElement)) return null;
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
    }, title);

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

  await openMenu("Write the notice");
  await screen.getByRole("menuitem", "Blockers for Write the notice").tap();
  await failNextPatch("Blockers would cycle");
  await screen.getByRole("button", "Blocked by Review the notice").tap();
  await expect(screen.getByTestId("task-error")).toHaveText("Blockers would cycle");
  const menuError = await browser.evaluate(() => {
    const menu = document.querySelector("[data-testid=task-menu]");
    const error = menu?.querySelector("[data-testid=task-error]");
    const item = menu?.querySelector("[role=menuitem]");
    if (!(error instanceof HTMLElement) || !(item instanceof HTMLElement)) return null;
    return error.getBoundingClientRect().bottom <= item.getBoundingClientRect().top + 1;
  });
  expect(menuError).toBe(true);

  await screen.getByRole("button", "Blocked by Review the notice").tap();
  await expect(screen.getByText("Blocked by Review the notice", { exact: true })).toBeVisible();
  await expect(screen.getByTestId("task-error")).toHaveCount(0);
  await browser.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return null;
  });
  await expect(screen.getByTestId("task-menu")).toHaveCount(0);

  await failNextPatch("Open subtasks");
  await screen.getByRole("button", { name: "Open Write the notice" }).tap();
  await screen.getByTestId("task-detail-status").tap();
  await expect(screen.getByTestId("task-detail").getByTestId("task-error")).toHaveText(
    "Open subtasks",
  );
  await expect(screen.getByTestId("task-detail-status")).toHaveText("Mark done");
  const cardError = await browser.evaluate(() => {
    const error = document.querySelector("[data-testid=task-error]");
    const card = [...document.querySelectorAll("[data-task-card]")].find(
      (item) => item.getAttribute("aria-describedby") === error?.id,
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

  await openMenu("Write the notice");
  await screen.getByRole("menuitem", "Subtask of Write the notice").tap();
  const subtask = screen.getByRole("textbox", "New subtask");
  await subtask.fill("too late");
  await screen.getByRole("button", "Add task").tap();
  await expect(screen.getByTestId("composer-error")).toHaveText("Task is done");
  await expect(subtask).toHaveValue("too late");
  const added = await browser.evaluate(
    () =>
      [...document.querySelectorAll("[data-task-card]")].some((item) =>
        item.textContent?.includes("too late"),
      ) ?? false,
  );
  expect(added).toBe(false);
  const composerError = await browser.evaluate(() => {
    const error = document.querySelector("[data-testid=composer-error]");
    const field = document.querySelector("textarea");
    const footer = field?.closest(".float-footer");
    if (
      !(error instanceof HTMLElement) ||
      !(field instanceof HTMLElement) ||
      !(footer instanceof HTMLElement)
    ) {
      return null;
    }
    return (
      footer.contains(error) &&
      error.getBoundingClientRect().bottom <= field.getBoundingClientRect().top + 1
    );
  });
  expect(composerError).toBe(true);

  await subtask.fill("too late.");
  await expect(screen.getByTestId("composer-error")).toHaveCount(0);

  await screen.getByRole("button", "New top-level task").tap();
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
  const at = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();
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
              completedAt: at(600_000),
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

test("puts the task filters in the composer header and groups done work by day", async ({
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
        conversationId: "task-filters-e2e",
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
  await expect(screen.getByTestId("task-filters")).toBeVisible();

  const place = await browser.evaluate(() => {
    const filters = document.querySelector<HTMLElement>('[data-testid="task-filters"]');
    const row = document.querySelector<HTMLElement>(
      '[data-testid="composer-dock"]',
    )?.firstElementChild;
    const dots = document.querySelector<HTMLElement>('[data-testid="page-dots"]');
    const status = document.querySelector<HTMLElement>('[data-testid="working-status"]');
    if (filters === null || row == null || dots === null || status === null) return null;
    const filtersBox = filters.getBoundingClientRect();
    const dotsBox = dots.getBoundingClientRect();
    const statusBox = status.getBoundingClientRect();
    return {
      inRow: row.contains(filters) && row.contains(dots) && row.contains(status),
      leftOfDots: filtersBox.right <= dotsBox.left + 1,
      leftOfStatus: filtersBox.left < statusBox.left,
    };
  });
  expect(place).toEqual({ inRow: true, leftOfDots: true, leftOfStatus: true });

  const selected = await browser.evaluate(() => {
    const tab = document.querySelector<HTMLElement>('[data-testid="task-filter-active"]');
    const open = document.querySelector<HTMLElement>(
      '[data-testid="task-section-active"] [data-slot="collapsible-trigger"]',
    );
    const tabCount = tab?.querySelector<HTMLElement>("span:last-child");
    const openCount = open?.querySelectorAll<HTMLElement>("span")[1];
    if (tab === null || tab === undefined || open == null) return null;
    if (tabCount === null || tabCount === undefined || openCount == null) return null;
    const tabBox = tab.getBoundingClientRect();
    const openBox = open.getBoundingClientRect();
    return {
      sameBackground:
        getComputedStyle(tab).backgroundColor === getComputedStyle(open).backgroundColor,
      tabCountRight: tabCount.getBoundingClientRect().right > tabBox.left + tabBox.width / 2,
      openCountRight: openCount.getBoundingClientRect().right > openBox.left + openBox.width / 2,
      openChevron: open.querySelector("svg") !== null,
    };
  });
  expect(selected).toEqual({
    sameBackground: true,
    tabCountRight: true,
    openCountRight: true,
    openChevron: true,
  });

  await screen.getByTestId("task-filter-proposed").tap();
  await expect(screen.getByTestId("proposal-proposal")).toBeVisible();
  await expect(screen.getByTestId("task-done-today")).toHaveCount(0);
  await expect(screen.getByTestId("task-open-task")).toHaveCount(0);

  await screen.getByTestId("task-filter-active").tap();
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
});

test("edits a task title in the detail view and refuses an empty one", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 800 });
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
  await screen.getByRole("button", { name: "Open Draft title" }).click();
  await screen.getByRole("button", { name: "Edit title Draft title" }).click();
  const title = screen.getByRole("textbox", "Task title");
  await title.fill("Corrected title");
  await title.press("Enter");
  await expect(screen.getByRole("button", { name: "Edit title Corrected title" })).toBeVisible();
  await expect(screen.getByRole("button", { name: "Open Corrected title" })).toBeVisible();
  await expect
    .poll(() =>
      browser.evaluate(async (taskId) => {
        const ledger = (await (await fetch("/api/tasks")).json()) as {
          tasks: Array<{ id: string; title: string }>;
        };
        return ledger.tasks.find((task) => task.id === taskId)?.title ?? null;
      }, id),
    )
    .toBe("Corrected title");

  await app.open("/?page=tasks");
  await expect(screen.getByRole("button", { name: "Open Corrected title" })).toBeVisible();
  await screen.getByRole("button", { name: "Open Corrected title" }).click();
  await screen.getByRole("button", { name: "Edit title Corrected title" }).click();
  const again = screen.getByRole("textbox", "Task title");
  await again.fill("   ");
  await again.press("Enter");
  await expect(screen.getByText("Title must not be empty")).toBeVisible();
  await expect(screen.getByRole("button", { name: "Edit title Corrected title" })).toBeVisible();
  await expect
    .poll(() =>
      browser.evaluate(async (taskId) => {
        const ledger = (await (await fetch("/api/tasks")).json()) as {
          tasks: Array<{ id: string; title: string }>;
        };
        return ledger.tasks.find((task) => task.id === taskId)?.title ?? null;
      }, id),
    )
    .toBe("Corrected title");

  await removeTasks(browser, ["Corrected title"]);
});

test("sets, edits and clears a task body that renders as markdown", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 800 });
  await app.open("/?page=tasks");
  const rationale = "The rationale belongs to the proposer and must survive a body edit.";
  const id = await browser.evaluate(async (why) => {
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Body draft", rationale: why, propose: true }),
    });
    const ledger = (await response.json()) as { tasks: Array<{ id: string; title: string }> };
    const task = ledger.tasks.find((item) => item.title === "Body draft");
    if (task === undefined) return "";
    await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "open" }),
    });
    return task.id;
  }, rationale);
  await app.open("/?page=tasks");
  await screen.getByRole("button", { name: "Open Body draft" }).click();
  await screen.getByRole("button", { name: "Add body" }).click();
  const body = screen.getByRole("textbox", "Task body");
  await body.fill("# Route plan\n\nUse **tram 4**.");
  await body.press("Control+Enter");
  await expect(
    screen.getByTestId("task-body").getByRole("heading", { name: "Route plan" }),
  ).toBeVisible();
  await expect(screen.getByTestId("task-body").getByText("tram 4")).toBeVisible();
  await expect(screen.getByText(rationale)).toBeVisible();

  await app.open("/?page=tasks");
  await screen.getByRole("button", { name: "Open Body draft" }).click();
  await expect(
    screen.getByTestId("task-body").getByRole("heading", { name: "Route plan" }),
  ).toBeVisible();
  await screen.getByRole("button", { name: "Edit body" }).click();
  const edited = screen.getByRole("textbox", "Task body");
  await edited.fill("## Later plan\n\nWalk instead.");
  await edited.press("Control+Enter");
  await expect(
    screen.getByTestId("task-body").getByRole("heading", { name: "Later plan" }),
  ).toBeVisible();
  await expect(screen.getByText(rationale)).toBeVisible();

  await screen.getByRole("button", { name: "Edit body" }).click();
  const cleared = screen.getByRole("textbox", "Task body");
  await cleared.fill("");
  await cleared.press("Control+Enter");
  await expect(screen.getByTestId("task-body")).toHaveCount(0);
  await expect
    .poll(() =>
      browser.evaluate(async (taskId) => {
        const ledger = (await (await fetch("/api/tasks")).json()) as {
          tasks: Array<{ id: string; body?: string; rationale?: string }>;
        };
        const task = ledger.tasks.find((item) => item.id === taskId);
        return { body: task?.body ?? null, rationale: task?.rationale ?? null };
      }, id),
    )
    .toEqual({ body: null, rationale });

  await app.open("/?page=tasks");
  await screen.getByRole("button", { name: "Open Body draft" }).click();
  await expect(screen.getByTestId("task-body")).toHaveCount(0);
  await expect(screen.getByText(rationale)).toBeVisible();

  await removeTasks(browser, ["Body draft"]);
});

test("sets an existing or new project and clears it to No project", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 800 });
  await app.open("/?page=tasks");
  const created = await browser.evaluate(async () => {
    const post = async (body: unknown) => {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return ((await response.json()) as { tasks: Array<{ id: string; title: string }> }).tasks;
    };
    await post({ title: "Project anchor", parentId: null, project: "alpha" });
    const tasks = await post({ title: "Project target", parentId: null });
    return tasks.find((task) => task.title === "Project target")?.id ?? "";
  });
  await app.open("/?page=tasks");
  await screen.getByRole("button", { name: "Open Project target" }).click();
  const project = screen.getByRole("textbox", "Task project");
  await expect(project).toHaveValue("");
  await project.fill("alpha");
  await project.press("Enter");
  await expect(
    screen.getByTestId("task-project-alpha").getByText("Project target", { exact: true }),
  ).toBeVisible();

  await project.fill("beta");
  await project.press("Enter");
  await expect(
    screen.getByTestId("task-project-beta").getByText("Project target", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      browser.evaluate(async (taskId) => {
        const ledger = (await (await fetch("/api/tasks")).json()) as {
          tasks: Array<{ id: string; project?: string }>;
        };
        return ledger.tasks.find((task) => task.id === taskId)?.project ?? null;
      }, created),
    )
    .toBe("beta");

  await app.open("/?page=tasks");
  await screen.getByRole("button", { name: "Open Project target" }).click();
  await expect(screen.getByRole("textbox", "Task project")).toHaveValue("beta");
  const cleared = screen.getByRole("textbox", "Task project");
  await cleared.fill("");
  await cleared.press("Enter");
  await expect(
    screen.getByTestId("task-project-none").getByText("Project target", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      browser.evaluate(async (taskId) => {
        const ledger = (await (await fetch("/api/tasks")).json()) as {
          tasks: Array<{ id: string; project?: string }>;
        };
        return ledger.tasks.find((task) => task.id === taskId)?.project ?? null;
      }, created),
    )
    .toBeNull();

  await removeTasks(browser, ["Project target", "Project anchor"]);
});

test("PATCH rejects a non-string, overlong or empty field with a 400", async ({ app, browser }) => {
  await app.open("/");
  const result = await browser.evaluate(async () => {
    const create = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Validation target", parentId: null }),
    });
    const ledger = (await create.json()) as { tasks: Array<{ id: string; title: string }> };
    const id = ledger.tasks.find((task) => task.title === "Validation target")?.id ?? "";
    const patch = async (body: unknown) => {
      const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, text: await response.text() };
    };
    const notString = await patch({ body: 42 });
    const tooLong = await patch({ body: "x".repeat(20_001) });
    const emptyTitle = await patch({ title: "   " });
    const blankBody = await patch({ body: "   " });
    await fetch(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
    return { notString, tooLong, emptyTitle, blankBody };
  });
  expect(result?.notString.status).toBe(400);
  expect(result?.notString.text).toContain("body");
  expect(result?.tooLong.status).toBe(400);
  expect(result?.tooLong.text).toContain("body");
  expect(result?.emptyTitle.status).toBe(400);
  expect(result?.emptyTitle.text).toContain("title");
  expect(result?.blankBody.status).toBe(200);
});
