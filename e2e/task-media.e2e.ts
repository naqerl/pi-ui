import { beforeEach, describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

const openButtons = '[data-testid="task-attachments"] [data-testid^="task-attachment-open-"]';

/** Draw a small PNG in the page and hand it to the composer's file input. */
async function attachImage(browser: { evaluate: <T>(fn: () => T | Promise<T>) => Promise<T> }) {
  return browser.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 40;
    const context = canvas.getContext("2d");
    if (context === null) return false;
    context.fillStyle = "#e11d48";
    context.fillRect(0, 0, 64, 40);
    context.fillStyle = "#0ea5e9";
    context.fillRect(16, 8, 32, 24);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (blob === null) return false;
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], `shot-${Math.random()}.png`, { type: "image/png" }));
    const inputs = [...document.querySelectorAll<HTMLInputElement>("[data-testid=attach-input]")];
    const input = inputs.find((item) => item.closest("[aria-hidden=true]") === null) ?? inputs[0];
    if (input === undefined) return false;
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  });
}

async function attachmentStatuses(browser: {
  evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
}) {
  return browser.evaluate(() =>
    [...document.querySelectorAll("[data-testid=composer-attachments] li")].map(
      (item) => item.getAttribute("data-status") ?? "",
    ),
  );
}

async function waitReady(browser: { evaluate: <T>(fn: () => T | Promise<T>) => Promise<T> }) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const statuses = await attachmentStatuses(browser);
    if (statuses.length > 0 && statuses.every((status) => status === "ready")) return statuses;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return attachmentStatuses(browser);
}

async function attachmentCount(
  browser: {
    evaluate: <T>(fn: (id: string) => T | Promise<T>, arg: string) => Promise<T>;
  },
  id: string,
) {
  return browser.evaluate(async (taskId) => {
    const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
      tasks: Array<{ id: string; attachments?: string[] }>;
    };
    return ledger.tasks.find((task) => task.id === taskId)?.attachments?.length ?? 0;
  }, id);
}

/** Upload a randomly coloured PNG and create a task carrying two of them. */
async function createTaskWithImages(browser: {
  evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
}) {
  return browser.evaluate(async () => {
    const upload = async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 40;
      const context = canvas.getContext("2d");
      if (context === null) return null;
      context.fillStyle = `hsl(${Math.random() * 360} 80% 50%)`;
      context.fillRect(0, 0, 64, 40);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (blob === null) return null;
      const response = await fetch("/api/media", {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: blob,
      });
      if (!response.ok) return null;
      return ((await response.json()) as { id: string }).id;
    };
    const ids = [await upload(), await upload()].filter((id): id is string => id !== null);
    const title = `Task media ${Date.now()}`;
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        body: [
          "# Images on this task",
          "",
          ...Array.from(
            { length: 80 },
            (_, index) => `- Line ${index + 1} keeps the detail pane scrollable.`,
          ),
        ].join("\n"),
        attachments: ids,
      }),
    });
    if (!response.ok) return { ok: false as const, title, id: null };
    const ledger = (await response.json()) as {
      tasks: Array<{ id: string; title: string }>;
    };
    return {
      ok: true as const,
      title,
      id: ledger.tasks.find((task) => task.title === title)?.id ?? null,
    };
  });
}

/** Put one image through the task detail's shared media picker. */
async function addImageThroughPicker(
  browser: {
    evaluate: <T>(fn: (color: string) => T | Promise<T>, arg: string) => Promise<T>;
  },
  color: string,
) {
  return browser.evaluate(async (color) => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 40;
    const context = canvas.getContext("2d");
    if (context === null) return false;
    context.fillStyle = color;
    context.fillRect(0, 0, 64, 40);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (blob === null) return false;
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], `task-media-${Math.random()}.png`, { type: "image/png" }));
    const input = document.querySelector<HTMLInputElement>("[data-testid=task-media-input]");
    if (input === null) return false;
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, color);
}

/** Upload the exact bytes of an existing image again through the shared picker. */
async function reAddMediaThroughPicker(
  browser: {
    evaluate: <T>(fn: (id: string) => T | Promise<T>, arg: string) => Promise<T>;
  },
  mediaId: string,
) {
  return browser.evaluate(async (id) => {
    const response = await fetch(`/api/media/${encodeURIComponent(id)}`);
    if (!response.ok) return false;
    const blob = await response.blob();
    const transfer = new DataTransfer();
    transfer.items.add(
      new File([blob], `restored-${Math.random()}.png`, {
        type: blob.type.length > 0 ? blob.type : "image/png",
      }),
    );
    const input = document.querySelector<HTMLInputElement>("[data-testid=task-media-input]");
    if (input === null) return false;
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, mediaId);
}

/** Scroll the mobile detail pane that owns the attachments and return its offset. */
async function scrollDetail(browser: { evaluate: <T>(fn: () => T | Promise<T>) => Promise<T> }) {
  return browser.evaluate(() => {
    const attachments = document.querySelector<HTMLElement>('[data-testid="task-attachments"]');
    let pane = attachments?.parentElement ?? null;
    while (pane !== null) {
      const style = getComputedStyle(pane);
      if (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        pane.scrollHeight > pane.clientHeight
      ) {
        break;
      }
      pane = pane.parentElement;
    }
    if (pane === null) return null;
    pane.scrollTop = Math.min(140, pane.scrollHeight - pane.clientHeight);
    return pane.scrollTop;
  });
}

async function detailScrollTop(browser: { evaluate: <T>(fn: () => T | Promise<T>) => Promise<T> }) {
  return browser.evaluate(() => {
    const attachments = document.querySelector<HTMLElement>('[data-testid="task-attachments"]');
    let pane = attachments?.parentElement ?? null;
    while (pane !== null) {
      const style = getComputedStyle(pane);
      if (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        pane.scrollHeight > pane.clientHeight
      ) {
        return pane.scrollTop;
      }
      pane = pane.parentElement;
    }
    return null;
  });
}

describe("task media against one shared app", { serial: true }, () => {
  beforeEach(async ({ browser }) => {
    await browser.unrouteAll();
  });

  test("sends a composer image without text and removes a preview", async ({
    app,
    browser,
    screen,
  }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await app.open("/");
    await expect(screen.getByRole("textbox", "Message")).toBeVisible();

    expect(await attachImage(browser)).toBe(true);
    expect(await attachImage(browser)).toBe(true);
    expect(await waitReady(browser)).toEqual(["ready", "ready"]);
    await screen.getByRole("button", "Remove attachment 2").tap();
    expect(await attachmentStatuses(browser)).toEqual(["ready"]);

    await screen.getByRole("button", "Send").tap();
    await expect(screen.getByText("Echo:  [images: 1]", { exact: false })).toBeVisible({
      timeout: 15_000,
    });
  });

  test("previews, removes and adds task images without moving the detail pane", async ({
    app,
    browser,
    screen,
  }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await app.open("/?page=tasks");
    await expect(screen.getByTestId("task-list")).toBeVisible();

    const created = await createTaskWithImages(browser);
    expect(created.ok).toBe(true);
    expect(created.id).not.toBeNull();
    const id = created.id as string;

    await screen.getByRole("button", { name: `Open ${created.title}` }).tap();
    await expect(screen.getByTestId("task-attachments")).toBeVisible();
    await expect(browser.locator(openButtons)).toHaveCount(2);
    expect(await attachmentCount(browser, id)).toBe(2);
    expect(
      await browser.evaluate(
        () => document.querySelector("[data-testid=task-attachments]")?.childElementCount ?? 0,
      ),
    ).toBeGreaterThanOrEqual(2);

    const scrollTop = await scrollDetail(browser);
    expect(scrollTop).not.toBeNull();
    expect(scrollTop as number).toBeGreaterThan(0);

    // Remove immediately, without letting the test runner scroll the thumbnail into view.
    await browser.evaluate(() => {
      document.querySelector<HTMLElement>('[data-testid="task-attachment-remove-1"]')?.click();
      return true;
    });
    await expect(browser.locator(openButtons)).toHaveCount(1);
    await expect.poll(() => attachmentCount(browser, id), { timeout: 10_000 }).toBe(1);
    expect(await detailScrollTop(browser)).toBe(scrollTop);

    expect(await addImageThroughPicker(browser, "#123456")).toBe(true);
    await expect(browser.locator(openButtons)).toHaveCount(2);
    await expect.poll(() => attachmentCount(browser, id), { timeout: 10_000 }).toBe(2);
    expect(await detailScrollTop(browser)).toBe(scrollTop);

    await browser.reload();
    await expect(screen.getByRole("button", { name: `Open ${created.title}` })).toBeVisible({
      timeout: 15_000,
    });
    await screen.getByRole("button", { name: `Open ${created.title}` }).tap();
    await expect(browser.locator(openButtons)).toHaveCount(2);
    expect(await attachmentCount(browser, id)).toBe(2);

    // Removing the last image must not keep its content-addressed id hidden forever.
    const targetId = await browser.evaluate(async (taskId) => {
      const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
        tasks: Array<{ id: string; attachments?: string[] }>;
      };
      return ledger.tasks.find((task) => task.id === taskId)?.attachments?.at(-1) ?? null;
    }, id);
    expect(targetId).not.toBeNull();

    for (let remaining = 2; remaining > 0; remaining--) {
      await browser.evaluate(() => {
        document.querySelector<HTMLElement>('[data-testid="task-attachment-remove-1"]')?.click();
        return true;
      });
      await expect(browser.locator(openButtons)).toHaveCount(remaining - 1);
    }
    await expect(screen.getByTestId("task-attachments")).toHaveCount(0);
    await expect.poll(() => attachmentCount(browser, id), { timeout: 10_000 }).toBe(0);

    expect(await reAddMediaThroughPicker(browser, targetId as string)).toBe(true);
    await expect(screen.getByTestId("task-attachments")).toBeVisible();
    await expect(browser.locator(openButtons)).toHaveCount(1);
    await expect.poll(() => attachmentCount(browser, id), { timeout: 10_000 }).toBe(1);
  });
});
