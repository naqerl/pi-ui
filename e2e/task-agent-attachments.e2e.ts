import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createOpenTask, openTaskChatTab } from "./tasks-helpers";

/** Draw a small PNG and hand it to the plan-chat attach input, not the list composer. */
async function attachPlanImage(browser: { evaluate: <T>(fn: () => T | Promise<T>) => Promise<T> }) {
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
    transfer.items.add(new File([blob], `plan-${Math.random()}.png`, { type: "image/png" }));
    const input = document.querySelector<HTMLInputElement>("[data-testid=task-agent-attach]");
    if (input === null) return false;
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  });
}

async function planAttachmentStatuses(browser: {
  evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
}) {
  return browser.evaluate(() => {
    const chat = document.querySelector("[data-testid=task-agent-chat]");
    if (chat === null) return [];
    return [...chat.querySelectorAll("[data-testid=composer-attachments] li")].map(
      (item) => item.getAttribute("data-status") ?? "",
    );
  });
}

async function waitReady(browser: { evaluate: <T>(fn: () => T | Promise<T>) => Promise<T> }) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const statuses = await planAttachmentStatuses(browser);
    if (statuses.length > 0 && statuses.every((status) => status === "ready")) return statuses;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return planAttachmentStatuses(browser);
}

test("sends an image in the plan chat", { timeout: 180_000 }, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 1280, height: 800 });
  await app.open("/?page=tasks");
  const title = `Review this screenshot ${Date.now()}`;
  await createOpenTask(screen, title);
  await expect(screen.getByTestId("task-agent-input")).toBeVisible();

  expect(await attachPlanImage(browser)).toBe(true);
  expect(await waitReady(browser)).toEqual(["ready"]);

  const input = screen.getByTestId("task-agent-input");
  await input.fill("what is in this picture");
  await screen.getByTestId("task-agent-send").tap();
  await expect(
    screen
      .getByTestId("task-agent-transcript")
      .getByText("Echo: what is in this picture [images: 1]", { exact: false }),
  ).toBeVisible({ timeout: 30_000 });

  const shown = await browser.evaluate(async () => {
    const chat = document.querySelector("[data-testid=task-agent-chat]");
    const images = [
      ...(chat?.querySelectorAll<HTMLImageElement>("[data-testid=message-attachments] img") ?? []),
    ];
    const last = images.at(-1);
    if (last === undefined) return null;
    if (!last.complete) await new Promise((resolve) => last.addEventListener("load", resolve));
    return {
      src: new URL(last.src).pathname.startsWith("/api/media/"),
      loaded: last.naturalWidth === 64,
    };
  });
  expect(shown).toEqual({ src: true, loaded: true });
});

test("sends an image in the mobile plan chat", { timeout: 180_000 }, async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks");
  const title = `Mobile screenshot review ${Date.now()}`;
  await createOpenTask(screen, title);
  await openTaskChatTab(screen);
  await expect(screen.getByTestId("task-agent-input")).toBeVisible();

  expect(await attachPlanImage(browser)).toBe(true);
  expect(await waitReady(browser)).toEqual(["ready"]);
  await screen.getByTestId("task-agent-send").tap();
  await expect(
    screen.getByTestId("task-agent-transcript").getByText("Echo:  [images: 1]", { exact: false }),
  ).toBeVisible({ timeout: 30_000 });
});
