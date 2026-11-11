import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { isTaskChatUrl } from "./tasks-helpers";

const at = new Date(Date.UTC(2026, 0, 1, 12, 0, 0)).toISOString();

const ledger = {
  revision: 1,
  tasks: [
    {
      id: "p1",
      title: "Clean the cache",
      status: "proposed",
      parentId: null,
      blockedBy: [],
      createdAt: at,
      proposedAt: at,
      rationale: "The cache keeps stale entries for a whole day.",
      completedAt: null,
      completion: null,
    },
  ],
};

const snapshot = {
  conversationId: "haptics-e2e",
  messages: [],
  activity: [],
  run: "idle",
  queue: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
  context: { tokens: 0, window: null, percent: null },
  tasks: ledger,
};

test("vibrates once for an approval and not for the selected tab", async ({
  app,
  browser,
  screen,
}) => {
  await browser.addInitScript(() => {
    let calls = 0;
    Object.defineProperty(navigator, "vibrate", {
      configurable: true,
      value: () => {
        calls += 1;
        (window as unknown as { __vibrationCalls?: number }).__vibrationCalls = calls;
        return true;
      },
    });
  });
  await browser.emulateMedia({ reducedMotion: "no-preference" });
  await browser.route("**/api/tasks/**", async (route) => {
    if (isTaskChatUrl(route.request.url)) {
      await route.continue();
      return;
    }
    await route.fulfill({ json: ledger });
  });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: snapshot });
  });
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks");

  const calls = () =>
    browser.evaluate(
      () => (window as unknown as { __vibrationCalls?: number }).__vibrationCalls ?? 0,
    );
  expect(await calls()).toBe(0);

  await screen.getByRole("button", { name: "Approve Clean the cache" }).tap();
  await expect.poll(calls).toBe(1);

  await screen.getByRole("tab", "Tasks").tap();
  await browser.evaluate(async () => {
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 80);
    });
    return true;
  });
  expect(await calls()).toBe(1);
});
