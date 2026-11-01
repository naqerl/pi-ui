import { test } from "@e2e-dev/web";
import { expect } from "e2e";

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
  const cardId = await browser.evaluate(() => {
    const card = [...document.querySelectorAll("[data-task-card]")].find((item) =>
      item.textContent?.includes("Write the ledger"),
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

  // A parent with an open subtask cannot be completed from its card menu either.
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
  const parentMarkDone = screen.getByRole("menuitem", "Mark done Write the ledger");
  await expect(parentMarkDone).toBeVisible();
  await expect(parentMarkDone).toHaveAttribute("aria-disabled", "true");
  await expect(parentMarkDone).toHaveAttribute("title", "Finish open subtasks first");
  expect(
    await browser.evaluate(() => {
      const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
        (node) => node.getAttribute("aria-label") === "Mark done Write the ledger",
      );
      return item?.disabled ?? null;
    }),
  ).toBe(true);
  await browser.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return null;
  });
  await expect(screen.getByTestId("task-menu")).toHaveCount(0);

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
  const parentStatus = screen.getByTestId("task-detail-status");
  await expect(parentStatus).toBeVisible();
  await expect(parentStatus).toHaveAttribute("aria-disabled", "true");
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

  await browser.evaluate(() => {
    const card = [...document.querySelectorAll("[data-task-card]")].find((item) =>
      item.textContent?.includes("Review the diff"),
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
  await screen.getByRole("menuitem", "Mark done Review the diff").tap();
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
  await expect(screen.getByRole("menuitem", "Reopen Review the diff")).toBeVisible();
  await screen.getByRole("menuitem", "Remove Review the diff").tap();
  await expect(screen.getByText("Review the diff", { exact: true })).not.toBeVisible();

  await screen.getByRole("tab", "Chat").tap();
  await expect(screen.getByRole("textbox", "Message")).toBeVisible();
  await expect(screen.getByTestId("subtask-progress")).toHaveCount(0);
  expect(await browser.evaluate(() => new URLSearchParams(location.search).get("page"))).toBe(
    "chat",
  );
});
