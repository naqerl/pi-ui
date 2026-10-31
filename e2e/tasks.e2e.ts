import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("keeps a todo with subtasks and blockers on the tasks page", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  await expect(screen.getByRole("textbox", "Message")).toBeVisible();

  await screen.getByRole("tab", "Tasks").tap();
  const composer = screen.getByRole("textbox", "New task");
  await expect(composer).toBeVisible();

  await composer.fill("Write the ledger");
  await screen.getByRole("button", "Add task").tap();
  await expect(screen.getByText("Write the ledger", { exact: true })).toBeVisible();
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
    return document.querySelector("[data-testid=task-detail]") !== null;
  });
  expect(longPress).toBe(false);
  await expect(screen.getByTestId("task-menu")).toBeVisible();
  await expect(screen.getByRole("button", "Done Write the ledger")).toBeVisible();

  await screen.getByRole("menuitem", "Subtask of Write the ledger").tap();
  const subtask = screen.getByRole("textbox", "New subtask");
  await expect(subtask).toBeVisible();
  await subtask.fill("Store tasks.json");
  await screen.getByRole("button", "Add task").tap();
  await expect(screen.getByText("Store tasks.json", { exact: true })).toBeVisible();
  await expect(screen.getByText("0 of 1 subtasks done", { exact: true })).toBeVisible();
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

  const checkbox = await browser.evaluate(() => {
    const card = [...document.querySelectorAll("[data-task-card]")].find((item) =>
      item.textContent?.includes("Write the ledger"),
    );
    const box = card?.querySelector("[data-task-check]");
    if (!(card instanceof HTMLElement) || !(box instanceof HTMLElement)) return null;
    const title = box.nextElementSibling;
    if (!(title instanceof HTMLElement)) return null;
    const titleBox = title.getBoundingClientRect();
    const check = box.getBoundingClientRect();
    return Math.abs(check.top + check.height / 2 - (titleBox.top + titleBox.height / 2));
  });
  expect(checkbox ?? 99).toBeLessThanOrEqual(1);

  await screen.getByRole("button", "New top-level task").tap();
  await screen.getByRole("textbox", "New task").fill("Review the diff");
  await screen.getByRole("button", "Add task").tap();
  await expect(screen.getByText("Review the diff", { exact: true })).toBeVisible();

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
  await expect(screen.getByText("Blocked by Review the diff", { exact: true })).toBeVisible();

  const parentDone = await browser.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find(
      (item) => item.getAttribute("aria-label") === "Done Write the ledger",
    );
    return button?.getAttribute("aria-disabled") === "true";
  });
  expect(parentDone).toBe(true);
  await browser.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return null;
  });
  await expect(screen.getByTestId("task-menu")).toHaveCount(0);
  const blockedTap = await browser.evaluate(async () => {
    const button = [...document.querySelectorAll("button")].find(
      (item) => item.getAttribute("aria-label") === "Done Write the ledger",
    );
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return button?.getAttribute("aria-pressed") ?? null;
  });
  expect(blockedTap).toBe("false");

  await screen.getByRole("button", "Done Review the diff").tap();
  await expect(screen.getByText("Blocked by Review the diff", { exact: true })).not.toBeVisible();
  await screen.getByRole("button", "Done Store tasks.json").tap();
  await expect(screen.getByRole("button", "Reopen Store tasks.json")).toBeVisible();
  await expect(screen.getByText("1 of 1 subtasks done", { exact: true })).toBeVisible();
  await screen.getByRole("button", "Done Write the ledger").tap();
  await expect(screen.getByRole("button", "Reopen Write the ledger")).toBeVisible();

  expect(await browser.evaluate(() => new URLSearchParams(location.search).get("page"))).toBe(
    "tasks",
  );
  await app.open("/?page=tasks");
  await expect(screen.getByRole("textbox", "New task")).toBeVisible();
  await expect(screen.getByText("Write the ledger", { exact: true })).toBeVisible();
  await expect(screen.getByText("Store tasks.json", { exact: true })).toBeVisible();
  await expect(screen.getByText("1 of 1 subtasks done", { exact: true })).toBeVisible();

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
  await screen.getByRole("button", "Done Write the notice").tap();
  await expect(screen.getByTestId("task-error")).toHaveText("Open subtasks");
  await expect(screen.getByRole("button", "Done Write the notice")).toBeVisible();
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

  await screen.getByRole("button", "Done Write the notice").tap();
  await expect(screen.getByRole("button", "Reopen Write the notice")).toBeVisible();
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
