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

  await screen.getByRole("button", "Subtask of Write the ledger").tap();
  const subtask = screen.getByRole("textbox", "New subtask");
  await expect(subtask).toBeVisible();
  await subtask.fill("Store tasks.json");
  await screen.getByRole("button", "Add task").tap();
  await expect(screen.getByText("Store tasks.json", { exact: true })).toBeVisible();

  await screen.getByRole("button", "New top-level task").tap();
  await screen.getByRole("textbox", "New task").fill("Review the diff");
  await screen.getByRole("button", "Add task").tap();
  await expect(screen.getByText("Review the diff", { exact: true })).toBeVisible();

  await screen.getByRole("button", "Blockers for Write the ledger").tap();
  await screen.getByRole("button", "Blocked by Review the diff").tap();
  await expect(screen.getByText("blocked by Review the diff", { exact: true })).toBeVisible();

  const parentDone = await browser.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find(
      (item) => item.getAttribute("aria-label") === "Done Write the ledger",
    );
    return button instanceof HTMLButtonElement ? button.disabled : null;
  });
  expect(parentDone).toBe(true);

  await screen.getByRole("button", "Done Review the diff").tap();
  await expect(screen.getByText("blocked by Review the diff", { exact: true })).not.toBeVisible();
  await screen.getByRole("button", "Done Store tasks.json").tap();
  await expect(screen.getByRole("button", "Reopen Store tasks.json")).toBeVisible();
  await screen.getByRole("button", "Done Write the ledger").tap();
  await expect(screen.getByRole("button", "Reopen Write the ledger")).toBeVisible();

  await app.open("/");
  await screen.getByRole("tab", "Tasks").tap();
  await expect(screen.getByText("Write the ledger", { exact: true })).toBeVisible();
  await expect(screen.getByText("Store tasks.json", { exact: true })).toBeVisible();

  await screen.getByRole("button", "Remove Review the diff").tap();
  await expect(screen.getByText("Review the diff", { exact: true })).not.toBeVisible();

  await screen.getByRole("tab", "Chat").tap();
  await expect(screen.getByRole("textbox", "Message")).toBeVisible();
});

test("switches to tasks with a horizontal swipe", async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");

  const page = await browser.evaluate(async () => {
    const pager = document.querySelector("[data-testid=pager]");
    if (!(pager instanceof HTMLElement)) return null;
    const box = pager.getBoundingClientRect();
    const y = box.top + Math.min(120, box.height / 2);
    const start = box.left + box.width * 0.8;
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
          buttons: type === "pointerup" ? 0 : 1,
        }),
      );
    };
    fire("pointerdown", start);
    fire("pointermove", start - 24);
    fire("pointermove", start - 160);
    fire("pointerup", start - 160);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return pager.getAttribute("data-page");
  });

  expect(page).toBe("tasks");
  await expect(screen.getByRole("textbox", "New task")).toBeVisible();
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
    const closed = left !== undefined ? await patch(left.id, { status: "done" }) : 0;
    const child = left !== undefined ? await post("too late", left.id) : { status: 0 };
    return { empty: empty.status, blocked, cycle, closed, child: child.status };
  });

  expect(result?.empty).toBe(400);
  expect(result?.blocked).toBe(200);
  expect(result?.cycle).toBe(409);
  expect(result?.closed).toBe(200);
  expect(result?.child).toBe(409);
});
