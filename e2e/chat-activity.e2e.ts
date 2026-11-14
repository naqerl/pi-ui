import { beforeEach, describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

const activityAt = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second)).toISOString();
const activitySnapshot = {
  conversationId: "activity-modal-e2e",
  messages: [
    { id: "ask", role: "user", text: "Restart the hub job", timestamp: activityAt(0), order: 1 },
    { id: "answer", role: "assistant", text: "Done.", timestamp: activityAt(40), order: 100 },
  ],
  activity: [
    {
      kind: "tool",
      id: "tool-1",
      name: "bash",
      arguments: JSON.stringify({ command: "echo hi" }),
      output: "hi",
      isError: false,
      durationMs: 1200,
      timestamp: activityAt(2),
      order: 20,
    },
    {
      kind: "thinking",
      id: "thinking-1",
      name: "thinking",
      text: "Considering the next step.",
      timestamp: activityAt(3),
      order: 21,
    },
  ],
  run: "idle",
  queue: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
  context: { tokens: 0, window: null, percent: null },
};
describe("activity surface against one shared app", { serial: true }, () => {
  beforeEach(async ({ browser }) => {
    await browser.unrouteAll();
  });

  test("opens run activity in a modal without navigating or unmounting the chat", async ({
    app,
    browser,
    screen,
  }) => {
    await browser.route("**/api/state**", async (route) => {
      await route.fulfill({ json: JSON.parse(JSON.stringify(activitySnapshot)) });
    });
    await app.open("/");
    await expect(screen.getByText("Done.", { exact: true })).toBeVisible();
    const composer = screen.getByRole("textbox", "Message");
    const before = await composer.boundingBox();
    const info = screen.getByTestId("run-info");
    await expect(info).toHaveAttribute("aria-haspopup", "dialog");
    expect(
      await browser.evaluate(
        () => document.querySelector('[data-testid="run-info"]')?.getAttribute("aria-label") ?? "",
      ),
    ).toMatch(/^Run activity: 1 tool call/);
    const transcriptBefore = await browser.evaluate(() => {
      const main = document.querySelector<HTMLElement>("main");
      return {
        messages: document.querySelectorAll("[data-message-id]").length,
        scrollTop: main?.scrollTop ?? -1,
      };
    });

    await info.tap();
    await expect(screen.getByTestId("activity-dialog")).toBeVisible();
    await expect(screen.getByRole("heading", { name: "Activity", level: 1 })).toBeVisible();
    await expect(screen.getByText("bash · 1.2s · ok", { exact: true })).toBeVisible();

    const during = await browser.evaluate(() => {
      const dialog = document.querySelector<HTMLDialogElement>('[data-testid="activity-dialog"]');
      const main = document.querySelector<HTMLElement>("main");
      return {
        path: window.location.pathname,
        open: dialog?.open ?? false,
        messages: document.querySelectorAll("[data-message-id]").length,
        answerMounted: document.querySelector('[data-message-id="answer"]') !== null,
        scrollTop: main?.scrollTop ?? -1,
        bodyOverflow: document.body.style.overflow,
        htmlOverflow: document.documentElement.style.overflow,
      };
    });
    expect(during.path).toBe("/");
    expect(during.open).toBe(true);
    expect(during.messages).toBe(transcriptBefore.messages);
    expect(during.answerMounted).toBe(true);
    expect(during.scrollTop).toBe(transcriptBefore.scrollTop);
    expect(during.bodyOverflow).toBe("hidden");
    expect(during.htmlOverflow).toBe("hidden");

    const after = await composer.boundingBox();
    expect(after?.width ?? 0).toBeCloseTo(before?.width ?? -1, 0);
    expect(after?.height ?? 0).toBeCloseTo(before?.height ?? -1, 0);
  });
  test("opens a run activity deep link over the chat and keeps /events a page", async ({
    app,
    browser,
    screen,
  }) => {
    await browser.route("**/api/state**", async (route) => {
      await route.fulfill({ json: JSON.parse(JSON.stringify(activitySnapshot)) });
    });
    await app.open("/activity?run=activity-message-ask-0");
    await expect(screen.getByTestId("activity-dialog")).toBeVisible();
    await expect(screen.getByText("bash · 1.2s · ok", { exact: true })).toBeVisible();
    expect(
      await browser.evaluate(
        () => document.querySelector('[data-testid="composer-dock"]') !== null,
      ),
    ).toBe(true);

    await app.open("/activity?run=missing");
    await expect(screen.getByTestId("activity-dialog")).toBeVisible();
    await expect(screen.getByText("No activity in this run.", { exact: true })).toBeVisible();

    await app.open("/events");
    await expect(
      screen.getByRole("heading", { name: "MCP subscriptions", level: 1 }),
    ).toBeVisible();
    await expect(screen.getByTestId("activity-dialog")).toHaveCount(0);
  });
});
