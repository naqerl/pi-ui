import type { Browser } from "@e2e-dev/web";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const CACHE_PATH = "topics/projects/zebra-cache.md";
const QUEUE_PATH = "topics/machines/zebra-queue.md";

const seedCalls = [
  {
    name: "memory_write",
    arguments: {
      target: "long_term",
      topic: CACHE_PATH,
      body: "# Alpha note\n\nzebracache keeps responses.",
    },
  },
  {
    name: "memory_write",
    arguments: {
      target: "long_term",
      topic: QUEUE_PATH,
      body: "# Beta note\n\nzebracache drains the queue.",
    },
  },
];

async function waitForIdle(browser: Browser): Promise<void> {
  await expect
    .poll(
      () =>
        browser.evaluate(async () => {
          const response = await fetch("/api/state");
          const state = (await response.json()) as { run?: string };
          return state.run ?? "";
        }),
      { timeout: 60_000 },
    )
    .toBe("idle");
}

async function sendCalls(
  browser: Browser,
  send: (calls: unknown[]) => Promise<void>,
  calls: unknown[],
): Promise<void> {
  await send(calls);
  await waitForIdle(browser);
}

test("two memory searches in one turn render one chip with summed counts", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 900 });
  await app.open("/");
  const send = async (calls: unknown[]) => {
    await screen.getByRole("textbox", "Message").fill(`TOOLCALLS ${JSON.stringify(calls)}`);
    await screen.getByRole("button", "Send").tap();
  };

  await sendCalls(browser, send, seedCalls);
  await sendCalls(browser, send, [
    { name: "memory_find", arguments: { query: "zebracache" } },
    { name: "memory_find", arguments: { query: "zebracache" } },
    { name: "memory_read", arguments: { path: CACHE_PATH } },
  ]);

  const chip = screen.getByTestId("memory-search-chip");
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(chip).toContainText("memory · 4 hits · 2 topics · ×2");
  await expect(chip).toContainText(
    new RegExp(`read ${CACHE_PATH.replaceAll(".", "\\.")} \\(lines 1–\\d+\\)`),
  );
  await expect(screen.getByTestId("memory-chip")).toHaveCount(1);
});

test("expanding the memory chip shows each matched path and its first line", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 900 });
  await app.open("/");
  const send = async (calls: unknown[]) => {
    await screen.getByRole("textbox", "Message").fill(`TOOLCALLS ${JSON.stringify(calls)}`);
    await screen.getByRole("button", "Send").tap();
  };

  await sendCalls(browser, send, seedCalls);
  await sendCalls(browser, send, [{ name: "memory_find", arguments: { query: "zebracache" } }]);

  const chip = screen.getByTestId("memory-search-chip");
  await expect(chip).toBeVisible({ timeout: 30_000 });
  await expect(chip).toHaveAttribute("aria-expanded", "false");
  await chip.tap();

  const details = screen.getByTestId("memory-search-details");
  await expect(details).toBeVisible();
  await expect(screen.getByTestId("memory-search-path")).toHaveCount(2);
  await expect(details).toContainText(CACHE_PATH);
  await expect(details).toContainText("zebracache keeps responses.");
  await expect(details).toContainText(QUEUE_PATH);
  await expect(details).toContainText("zebracache drains the queue.");
  await expect(chip).toHaveAttribute("aria-expanded", "true");

  // The expanded panel carries provenance only: no topic body beyond the first matching line.
  await expect(details).not.toContainText("# Alpha note");
  await expect(details).not.toContainText("# Beta note");
});

test("a memory search with no matches renders no chip", async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 1280, height: 900 });
  await app.open("/");
  const send = async (calls: unknown[]) => {
    await screen.getByRole("textbox", "Message").fill(`TOOLCALLS ${JSON.stringify(calls)}`);
    await screen.getByRole("button", "Send").tap();
  };

  await sendCalls(browser, send, [
    { name: "memory_find", arguments: { query: "nothingmatchesthiszebracache" } },
  ]);

  await expect(screen.getByTestId("memory-search-chip")).toHaveCount(0);
  await expect(screen.getByTestId("memory-chip")).toHaveCount(0);
});

test("unreported counts stay omitted and the run summary keeps every tool call", async ({
  app,
  browser,
  screen,
}) => {
  const at = new Date(Date.UTC(2026, 0, 1, 12, 0, 0)).toISOString();
  await browser.setViewport({ width: 1280, height: 900 });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({
      json: {
        conversationId: "memory-search-fallback-e2e",
        messages: [
          { id: "ask", role: "user", text: "Find the zebra notes", timestamp: at, order: 1 },
          { id: "answer", role: "assistant", text: "Found them.", timestamp: at, order: 100 },
        ],
        activity: [
          {
            kind: "tool",
            id: "memory-tool",
            name: "memory_find",
            arguments: JSON.stringify({ query: "zebracache" }),
            output: "two results",
            memory: {
              kind: "memory",
              paths: [
                { path: CACHE_PATH, line: "zebracache keeps responses." },
                { path: QUEUE_PATH, line: "zebracache drains the queue." },
              ],
              reads: [],
            },
            isError: false,
            timestamp: at,
            order: 10,
          },
          {
            kind: "tool",
            id: "other-tool",
            name: "bash",
            arguments: JSON.stringify({ command: "echo hi" }),
            output: "hi",
            isError: false,
            durationMs: 1200,
            timestamp: at,
            order: 11,
          },
        ],
        run: "idle",
        queue: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
        context: { tokens: 0, window: null, percent: null },
      },
    });
  });
  await app.open("/");

  const chip = screen.getByTestId("memory-search-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("memory · 2 topics");
  await expect(chip).not.toContainText("0 hits");
  await expect(chip).not.toContainText("0 topics");
  expect(
    await browser.evaluate(
      () => document.querySelector('[data-testid="run-info"]')?.getAttribute("aria-label") ?? "",
    ),
  ).toMatch(/^Run activity: 2 tool calls/);
});
