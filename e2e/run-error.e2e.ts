import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const at = new Date(Date.UTC(2026, 0, 1, 12, 0, 0)).toISOString();

const queuedWhileIdle = {
  conversationId: "idle-queued-e2e",
  messages: [],
  activity: [],
  run: "idle",
  queue: [{ id: "queue-1", text: "waiting for a turn", createdAt: at }],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
  context: { tokens: 0, window: null, percent: null },
};

/** The service worker would otherwise bypass request fixtures on a repeat visit. */
async function disableServiceWorker(browser: {
  addInitScript: (script: () => void) => Promise<void>;
}) {
  await browser.addInitScript(() => {
    if (!("serviceWorker" in navigator)) return;
    Object.defineProperty(navigator.serviceWorker, "register", {
      configurable: true,
      value: async () => undefined,
    });
  });
}

test("a queued message on an idle agent leaves the indicator idle", async ({
  app,
  browser,
  screen,
}) => {
  await disableServiceWorker(browser);
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: queuedWhileIdle });
  });
  // The fixture is the whole state; keep a real stream from replacing it.
  await browser.route("**/api/stream", async (route) => {
    await route.fulfill({
      status: 200,
      headers: { "content-type": "text/event-stream" },
      body: "event: liveness\ndata: {}\n\n: fixture\n\n",
    });
  });

  await app.open("/");
  await expect(screen.getByText("waiting for a turn", { exact: true })).toBeVisible();
  await expect(screen.getByTestId("working-status")).toHaveText("idle");
});

test("a transient model failure that retries successfully leaves no error header", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const marker = `FAIL_ONCE_${Date.now()}`;
  const composer = screen.getByRole("textbox", "Message");
  await composer.fill(marker);
  await screen.getByRole("button", "Send").tap();
  await expect(screen.getByText(`Echo: ${marker}`, { exact: false })).toBeVisible({
    timeout: 30_000,
  });

  // The failed attempt is retried transparently; the completed run has no error.
  await expect
    .poll(
      async () =>
        browser.evaluate(async () => {
          const state = (await (await fetch("/api/state", { cache: "no-store" })).json()) as {
            run?: string;
            runError?: unknown;
          };
          return state.run === "idle" && (state.runError ?? null) === null;
        }),
      { timeout: 15_000 },
    )
    .toBe(true);
  await expect(screen.getByTestId("run-error-header")).toHaveCount(0);
});

test("a failed run shows a thin dismissible error header without another action", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  await composer.fill("DELEGATE_FAIL");
  await screen.getByRole("button", "Send").tap();

  const header = screen.getByTestId("run-error-header");
  await expect(header).toBeVisible({ timeout: 30_000 });
  await expect(screen.getByTestId("run-error-class")).toHaveText(/Error$/);
  const placement = await browser.evaluate(() => {
    const element = document.querySelector<HTMLElement>('[data-testid="run-error-header"]');
    if (element === null) return null;
    return {
      position: getComputedStyle(element).position,
      height: element.getBoundingClientRect().height,
      color: getComputedStyle(element.querySelector<HTMLElement>("div") ?? element).color,
    };
  });
  expect(placement?.position).toBe("absolute");
  expect(placement?.height ?? 99).toBeLessThan(40);
  // The danger token supplies the colour; the literal red is not in the header.
  expect(placement?.color).not.toBe("rgb(255, 0, 0)");

  await screen.getByTestId("run-error-open").tap();
  await expect(screen.getByTestId("run-error-dialog")).toBeVisible();
  await expect(screen.getByTestId("run-error-dialog")).toContainText(/DELEGATE_FAIL|failure/i);
  await browser.keyboard.press("Escape");
  await expect(screen.getByTestId("run-error-dialog")).toHaveCount(0);

  // It stays until acknowledged, then the server clears it and no refresh brings it back.
  await screen.getByTestId("run-error-dismiss").tap();
  await expect(header).toHaveCount(0);
  await expect.poll(async () => screen.getByTestId("run-error-header").count()).toBe(0);
});
