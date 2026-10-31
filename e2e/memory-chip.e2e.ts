import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { memoryUndoPrompt } from "../src/shared/notices";

const path = "topics/projects/widget-cache.md";
const text = "# Widget cache\n\nthe cache keeps 200 responses for one minute.";
const timestamp = new Date(Date.UTC(2026, 0, 1, 12, 0, 0)).toISOString();

const snapshot = {
  conversationId: "memory-chip-e2e",
  messages: [
    {
      id: "m-memory",
      role: "system",
      text: `memory · ${path}`,
      timestamp,
      order: 10_000,
      notice: {
        kind: "memory",
        path,
        text,
        truncated: false,
        summary: `memory · ${path}`,
      },
    },
  ],
  activity: [],
  run: "idle",
  queue: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
  context: { tokens: 0, window: null, percent: null },
};

test("a memory chip opens the written text and steers the undo prompt", async ({
  app,
  browser,
  screen,
}) => {
  let sent: unknown = null;
  await browser.route("**/api/message", async (route) => {
    sent = JSON.parse(route.request.postData ?? "null");
    await route.fulfill({ status: 503, body: "offline" });
  });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: JSON.parse(JSON.stringify(snapshot)) });
  });
  await app.open("/");

  await screen.getByText(`memory · ${path}`, { exact: true }).tap();
  await expect(screen.getByTestId("notice-dialog")).toBeVisible();
  await expect(screen.getByText(path, { exact: true })).toBeVisible();
  await expect(screen.getByText(text, { exact: true })).toBeVisible();

  await screen.getByTestId("memory-undo").tap();
  await expect.poll(() => sent).toEqual({ text: memoryUndoPrompt(path), mode: "steer" });
});
