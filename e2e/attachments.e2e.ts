import { beforeEach, describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

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
describe("attachments against one shared app", { serial: true }, () => {
  beforeEach(async ({ browser }) => {
    await browser.unrouteAll();
  });

  test("sends an image without text and removes a preview", async ({ app, browser, screen }) => {
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

  test("attaches an image to a new task", async ({ app, browser, screen }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await app.open("/?page=tasks");
    await expect(screen.getByRole("textbox", "New task")).toBeVisible();

    const created = await browser.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 40;
      const context = canvas.getContext("2d");
      if (context === null) return { ok: false, error: "no canvas" };
      context.fillStyle = "#e11d48";
      context.fillRect(0, 0, 64, 40);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (blob === null) return { ok: false, error: "no blob" };
      const uploaded = await fetch("/api/media", {
        method: "POST",
        headers: { "Content-Type": "image/png" },
        body: blob,
      });
      if (!uploaded.ok) return { ok: false, error: await uploaded.text() };
      const media = (await uploaded.json()) as { id: string };
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Fix the layout in this screenshot",
          attachments: [media.id],
        }),
      });
      if (!response.ok) return { ok: false, error: await response.text() };
      return { ok: true, error: null };
    });
    expect(created).toEqual({ ok: true, error: null });

    await expect(
      screen
        .getByTestId("task-list")
        .getByText("Fix the layout in this screenshot", { exact: true }),
    ).toBeVisible();
    await screen.getByRole("button", "Open Fix the layout in this screenshot").tap();
    await expect(screen.getByTestId("task-attachments")).toBeVisible();

    const task = await browser.evaluate(async () => {
      const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
        tasks: { title: string; attachments?: string[] }[];
      };
      const found = ledger.tasks.find((item) => item.title === "Fix the layout in this screenshot");
      const image = document.querySelector<HTMLImageElement>("[data-testid=task-attachments] img");
      return {
        count: found?.attachments?.length ?? 0,
        shown: image !== null && new URL(image.src).pathname.startsWith("/api/media/"),
      };
    });
    expect(task).toEqual({ count: 1, shown: true });
  });
});
