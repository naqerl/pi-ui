import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("switches the model from the pi menu", async ({ app, browser, screen }) => {
  await app.open("/");
  const before = await browser.evaluate(async () => {
    const response = await fetch("/api/models", { cache: "no-store" });
    return (await response.json()) as {
      current: { id: string } | null;
      models: Array<{ id: string }>;
    };
  });
  expect(before.current?.id).toBe("e2e-model");
  expect(before.models.map((item) => item.id).sort()).toEqual(["e2e-model", "e2e-other"]);

  await screen.getByRole("button", "Settings").tap();
  await expect(screen.getByRole("menuitem", { name: /^Model/ })).toBeVisible();
  await screen.getByRole("menuitem", { name: /^Model/ }).tap();
  await expect(screen.getByRole("menuitemradio", { name: /E2E Other/ })).toBeVisible();
  await screen.getByRole("menuitemradio", { name: /E2E Other/ }).tap();

  await expect
    .poll(async () =>
      browser.evaluate(async () => {
        const body = (await (await fetch("/api/models", { cache: "no-store" })).json()) as {
          current: { id: string } | null;
        };
        return body.current?.id ?? "";
      }),
    )
    .toBe("e2e-other");

  const contextWindow = await browser.evaluate(async () => {
    const state = (await (await fetch("/api/state", { cache: "no-store" })).json()) as {
      context: { window: number | null };
    };
    return state.context.window;
  });
  expect(contextWindow).toBe(8192);

  await app.open("/");
  await screen.getByRole("button", "Settings").tap();
  await expect(screen.getByRole("menuitem", { name: /e2e-other/ })).toBeVisible();

  const restored = await browser.evaluate(async () => {
    const response = await fetch("/api/model", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "e2e", id: "e2e-model" }),
    });
    return response.ok;
  });
  expect(restored).toBe(true);
});

test("hydrates the chat after a failed first fetch and refreshes on focus", async ({
  app,
  browser,
  screen,
}) => {
  const timestamp = new Date().toISOString();
  let version = 0;
  let stateRequests = 0;
  const snapshot = (text: string) => ({
    conversationId: "hydrate-e2e",
    messages: [{ id: `hydrate-${version}`, role: "assistant", text, timestamp, order: 1 }],
    activity: [],
    run: "idle",
    queue: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    context: { tokens: 0, window: null, percent: null },
  });

  // No stream to rescue the first load: the retry has to fetch the state again.
  await browser.route("**/api/stream", async (route) => route.abort());
  await browser.route("**/api/state**", async (route) => {
    stateRequests += 1;
    if (stateRequests === 1) {
      await route.fulfill({ status: 503, body: "starting" });
      return;
    }
    await route.fulfill({
      json: snapshot(version === 0 ? "First hydration" : "Refreshed on focus"),
    });
  });

  await app.open("/");
  await expect(screen.getByText("First hydration", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  expect(stateRequests).toBeGreaterThan(1);

  version = 1;
  await browser.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(screen.getByText("Refreshed on focus", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
});
