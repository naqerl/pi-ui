import { test } from "@e2e-dev/web";
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

for (const width of [390, 1280]) {
  test(`sends an image with a message at ${width}px`, async ({ app, browser, screen }) => {
    await browser.setViewport({ width, height: 844 });
    await app.open("/");
    const composer = screen.getByRole("textbox", "Message");
    await expect(composer).toBeVisible();
    await expect(screen.getByRole("button", "Attach image")).toBeVisible();

    expect(await attachImage(browser)).toBe(true);
    expect(await waitReady(browser)).toEqual(["ready"]);

    // The plus sits left of the text field, and the preview stays inside the composer.
    const layout = await browser.evaluate(() => {
      const plus = document.querySelector('button[aria-label="Attach image"]');
      const field = document.querySelector('textarea[aria-label="Message"]');
      const strip = document.querySelector("[data-testid=composer-attachments]");
      const form = field?.closest("form") ?? field?.parentElement?.parentElement ?? null;
      if (plus === null || field === null || strip === null || form === null) return null;
      const p = plus.getBoundingClientRect();
      const f = field.getBoundingClientRect();
      const s = strip.getBoundingClientRect();
      const box = form.getBoundingClientRect();
      return {
        plusLeftOfField: p.right <= f.left + 1,
        stripAboveField: s.bottom <= f.top + 1,
        stripInside: s.left >= box.left - 1 && s.right <= box.right + 1,
        overflow: document.documentElement.scrollWidth - window.innerWidth,
      };
    });
    expect(layout).toEqual({
      plusLeftOfField: true,
      stripAboveField: true,
      stripInside: true,
      overflow: 0,
    });

    await composer.fill(`what is in this picture ${width}`);
    await screen.getByRole("button", "Send").tap();
    await expect(
      screen.getByText(`Echo: what is in this picture ${width} [images: 1]`, { exact: false }),
    ).toBeVisible({ timeout: 15_000 });
    expect(await attachmentStatuses(browser)).toEqual([]);

    const shown = await browser.evaluate(async () => {
      const images = [
        ...document.querySelectorAll<HTMLImageElement>("[data-testid=message-attachments] img"),
      ];
      const last = images.at(-1);
      if (last === undefined) return null;
      if (!last.complete) await new Promise((resolve) => last.addEventListener("load", resolve));
      const rect = last.getBoundingClientRect();
      const bubble = last.closest("[data-testid=message-attachments]")?.parentElement;
      return {
        src: new URL(last.src).pathname.startsWith("/api/media/"),
        loaded: last.naturalWidth === 64,
        fits:
          bubble !== null &&
          bubble !== undefined &&
          rect.right <= bubble.getBoundingClientRect().right + 1,
      };
    });
    expect(shown).toEqual({ src: true, loaded: true, fits: true });

    const stored = await browser.evaluate(async () => {
      const state = (await (await fetch("/api/state", { cache: "no-store" })).json()) as {
        messages: { role: string; text: string; attachments?: { mimeType: string }[] }[];
      };
      const mine = state.messages.filter((item) => item.role === "user").at(-1);
      return { text: mine?.text ?? "", types: (mine?.attachments ?? []).map((a) => a.mimeType) };
    });
    expect(stored).toEqual({ text: `what is in this picture ${width}`, types: ["image/png"] });
  });
}

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
  const field = screen.getByRole("textbox", "New task");
  await expect(field).toBeVisible();
  await expect(screen.getByRole("button", "Attach image to task")).toBeVisible();

  expect(await attachImage(browser)).toBe(true);
  expect(await waitReady(browser)).toEqual(["ready"]);
  // A task still needs a title.
  expect(
    await browser.evaluate(
      () =>
        document.querySelector<HTMLButtonElement>('button[aria-label="Add task"]')?.disabled ??
        null,
    ),
  ).toBe(true);

  await field.fill("Fix the layout in this screenshot");
  await screen.getByRole("button", "Add task").tap();
  await expect(
    screen.getByText("Fix the layout in this screenshot", { exact: true }),
  ).toBeVisible();

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

test("validates media uploads and attachment ids", async ({ app, browser }) => {
  await app.open("/");
  const result = await browser.evaluate(async () => {
    const text = await fetch("/api/media", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "not an image",
    });
    const empty = await fetch("/api/media", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: new Uint8Array(),
    });
    const fake = await fetch("/api/media", {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: "<html>not a png</html>",
    });
    const unknown = await fetch("/api/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi", attachments: [`${"0".repeat(32)}.png`] }),
    });
    const bad = await fetch("/api/message", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "hi", attachments: ["../../etc/passwd"] }),
    });
    const missing = await fetch(`/api/media/${"0".repeat(32)}.png`);
    return [text.status, empty.status, fake.status, unknown.status, bad.status, missing.status];
  });
  expect(result).toEqual([415, 400, 400, 400, 400, 404]);
});
