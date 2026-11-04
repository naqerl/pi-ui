import type { Browser } from "@e2e-dev/web";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { memoryUndoPrompt } from "../src/shared/notices";

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

test("removes the Activity link from the settings chrome and leaves the events page alone", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  await expect(screen.getByRole("link", "Activity")).toHaveCount(0);
  await screen.getByRole("button", "Settings").tap();
  await expect(screen.getByRole("menuitem", { name: /^Theme/ })).toBeVisible();
  const menuEdge = await browser.evaluate(() => {
    const menu = document.querySelector('[role="menu"]');
    if (menu === null) return null;
    const style = getComputedStyle(menu);
    return {
      width: style.borderTopWidth,
      border: style.borderTopColor,
      background: style.backgroundColor,
    };
  });
  expect(menuEdge?.width).toBe("1px");
  expect(menuEdge?.border).not.toBe(menuEdge?.background);

  await app.open("/events");
  await expect(screen.getByRole("heading", { name: "MCP subscriptions", level: 1 })).toBeVisible();
  await expect(screen.getByRole("link", "Back to chat")).toBeVisible();
  await expect(screen.getByRole("button", "Settings")).toBeVisible();
  await expect(screen.getByTestId("activity-dialog")).toHaveCount(0);
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

test("closes activity with Escape, the close button and the backdrop, restoring focus", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: JSON.parse(JSON.stringify(activitySnapshot)) });
  });
  await app.open("/");
  const info = screen.getByTestId("run-info");
  const focusedInfo = () =>
    browser.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "");

  await info.tap();
  await expect(screen.getByTestId("activity-dialog")).toBeVisible();
  await expect(screen.getByTestId("activity-scroll")).toBeVisible();
  const sheet = await browser.evaluate(() => {
    const dialog = document.querySelector<HTMLDialogElement>('[data-testid="activity-dialog"]');
    const scroll = document.querySelector<HTMLElement>('[data-testid="activity-scroll"]');
    if (dialog === null || scroll === null) return null;
    const box = dialog.getBoundingClientRect();
    return {
      open: dialog.open,
      bottom: Math.abs(box.bottom - window.innerHeight) < 2,
      fullWidth: Math.abs(box.width - window.innerWidth) < 2,
      maxHeight: box.height <= window.innerHeight * 0.85 + 1,
      overflow: getComputedStyle(scroll).overflowY,
    };
  });
  expect(sheet).toEqual({
    open: true,
    bottom: true,
    fullWidth: true,
    maxHeight: true,
    overflow: "auto",
  });

  await browser.keyboard.press("Escape");
  await expect(screen.getByTestId("activity-dialog")).toHaveCount(0);
  await expect.poll(focusedInfo).toBe("run-info");

  await info.tap();
  await expect(screen.getByTestId("activity-dialog")).toBeVisible();
  await screen.getByRole("button", "Close").tap();
  await expect(screen.getByTestId("activity-dialog")).toHaveCount(0);
  await expect.poll(focusedInfo).toBe("run-info");

  await info.tap();
  await expect(screen.getByTestId("activity-dialog")).toBeVisible();
  await browser.evaluate(() => {
    const dialog = document.querySelector<HTMLDialogElement>('[data-testid="activity-dialog"]');
    dialog?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return null;
  });
  await expect(screen.getByTestId("activity-dialog")).toHaveCount(0);
  await expect.poll(focusedInfo).toBe("run-info");
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
    await browser.evaluate(() => document.querySelector('[data-testid="composer-dock"]') !== null),
  ).toBe(true);

  await app.open("/activity?run=missing");
  await expect(screen.getByTestId("activity-dialog")).toBeVisible();
  await expect(screen.getByText("No activity in this run.", { exact: true })).toBeVisible();

  await app.open("/events");
  await expect(screen.getByRole("heading", { name: "MCP subscriptions", level: 1 })).toBeVisible();
  await expect(screen.getByTestId("activity-dialog")).toHaveCount(0);
});

/** Sends one BULK prompt straight to the API and waits for its whole reply. */
async function sendBulk(turn: number) {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const response = await fetch("/api/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: `BULK ${turn} please`, mode: "queue" }),
  });
  if (!response.ok) return false;
  for (let attempt = 0; attempt < 300; attempt++) {
    await sleep(50);
    const state = await (await fetch("/api/state?limit=4")).json();
    if (
      state.run === "idle" &&
      state.messages.some((message: { text: string }) => message.text.includes(`Bulk end ${turn}`))
    ) {
      return true;
    }
  }
  return false;
}

/** The transcript ids currently rendered, in DOM order. */
function renderedMessageIds() {
  return [...document.querySelectorAll<HTMLElement>("[data-message-id]")].map(
    (element) => element.dataset.messageId ?? "",
  );
}

/** The chat transcript in server order, without the job results the chat moves to activity. */
async function transcriptMessageIds() {
  const response = await fetch("/api/state?from=0");
  const state = (await response.json()) as {
    messages: { id: string; notice?: { kind?: string; label?: unknown } | null }[];
  };
  return state.messages
    .filter((message) => {
      const notice = message.notice;
      if (notice === null || notice === undefined) return true;
      const queued = "label" in notice && typeof notice.label === "string";
      return queued || notice.kind !== "job";
    })
    .map((message) => message.id);
}

function scrollToTop() {
  const main = document.querySelector<HTMLElement>("main");
  if (main === null) return false;
  main.scrollTop = 0;
  return true;
}

for (const width of [390, 1280]) {
  test(`loads the latest page first and older pages on scroll up at ${width}px`, {
    timeout: 240_000,
  }, async ({ app, browser, screen }) => {
    await browser.setViewport({ width, height: 844 });
    await app.open("/");
    const base = width * 1000;
    for (let turn = 1; turn <= 24; turn++) {
      expect(await browser.evaluate(sendBulk, base + turn)).toBe(true);
    }

    await app.open("/");
    await expect(screen.getByText("Earlier messages", { exact: true })).toBeVisible({
      timeout: 15_000,
    });
    const first = await browser.evaluate(renderedMessageIds);
    const transcript = await browser.evaluate(transcriptMessageIds);
    // The first paint is the newest window, not the whole transcript.
    expect(first.length).toBeGreaterThan(0);
    expect(first.length).toBeLessThan(transcript.length);
    expect(first).toEqual(transcript.slice(-first.length));
    expect(new Set(first).size).toBe(first.length);

    expect(await browser.evaluate(scrollToTop)).toBe(true);
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await browser.evaluate(renderedMessageIds)).length > first.length) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
      // Nudge the sentinel again in case the first scroll landed before it observed.
      if (attempt % 20 === 19) await browser.evaluate(scrollToTop);
    }
    const loaded = await browser.evaluate(renderedMessageIds);
    expect(loaded.length).toBeGreaterThan(first.length);
    const full = await browser.evaluate(transcriptMessageIds);
    // The older page is prepended: what is loaded stays an ordered suffix of the
    // transcript, keeps the newest page at the end, and has no duplicate ids.
    expect(loaded).toEqual(full.slice(-loaded.length));
    expect(loaded.slice(-first.length)).toEqual(first);
    expect(new Set(loaded).size).toBe(loaded.length);
  });
}

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second)).toISOString();

const tools = Array.from({ length: 9 }, (_, index) => ({
  kind: "tool",
  id: `tool-${index}`,
  name: "bash",
  arguments: JSON.stringify({ command: `echo ${index}` }),
  output: String(index),
  isError: false,
  durationMs: 1200,
  timestamp: at(2 + index * 2),
  order: 20 + index * 2,
  ...(index === 0 ? { usage: { input: 7100, output: 4700 } } : {}),
}));
const thinking = Array.from({ length: 7 }, (_, index) => ({
  kind: "thinking",
  id: `thinking-${index}`,
  name: "thinking",
  text: "Considering the next step.",
  timestamp: at(3 + index * 2),
  order: 21 + index * 2,
}));

const runInfoSnapshot = {
  conversationId: "run-info-e2e",
  messages: [
    { id: "ask", role: "user", text: "Restart the hub job", timestamp: at(0), order: 1 },
    { id: "answer", role: "assistant", text: "Done.", timestamp: at(40), order: 100 },
  ],
  activity: [...tools, ...thinking],
  run: "idle",
  queue: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
  context: { tokens: 0, window: null, percent: null },
};

test("puts the run info on a card that is not the page background", async ({ app, browser }) => {
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: runInfoSnapshot });
  });
  await app.open("/");
  const info = browser.locator('[data-testid="run-info"]');
  await expect(info).toBeVisible();
  const paint = await browser.evaluate(() => {
    const element = document.querySelector<HTMLElement>('[data-testid="run-info"]');
    if (element === null) return null;
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      page: getComputedStyle(document.body).backgroundColor,
      border: style.borderTopWidth,
    };
  });
  expect(paint).not.toBeNull();
  expect(paint?.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(paint?.background).not.toBe("transparent");
  expect(paint?.background).not.toBe(paint?.page);
  expect(paint?.border).toBe("1px");
});

test("fits the run info on a phone without naming thinking", async ({ app, browser }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: runInfoSnapshot });
  });
  await app.open("/");
  const info = browser.locator('[data-testid="run-info"]');
  await expect(info).toBeVisible();
  const box = await browser.evaluate(() => {
    const element = document.querySelector<HTMLElement>('[data-testid="run-info"]');
    if (element === null) return null;
    const rect = element.getBoundingClientRect();
    return {
      text: element.textContent ?? "",
      right: rect.right,
      left: rect.left,
      height: rect.height,
      page: document.documentElement.clientWidth,
      clipped: element.scrollWidth > element.clientWidth,
    };
  });
  expect(box).not.toBeNull();
  expect(box?.text).toContain("9 tool calls");
  expect(box?.text).toContain("7.1k in");
  expect(box?.text).toContain("4.7k out");
  expect(box?.text).not.toContain("thinking");
  expect(box?.text).not.toContain("…");
  expect(box?.clipped).toBe(false);
  expect(box?.left ?? -1).toBeGreaterThanOrEqual(0);
  expect(box?.right ?? 9999).toBeLessThanOrEqual(box?.page ?? 0);
  // A comfortable touch target on a phone.
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(36);
});

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
  let sent: { text?: string; mode?: string; queueKey?: string } | null = null;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await browser.route("**/api/message", async (route) => {
    sent = JSON.parse(route.request.postData ?? "null");
    // Hold the response so the optimistic steer bubble stays on screen for the assertion.
    await gate;
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
  const prompt = memoryUndoPrompt(path);
  const pending = browser.locator('[data-pending-steer="true"]').filter({ hasText: prompt });
  try {
    await expect(pending).toBeVisible();
    // The generated queueKey reconciles the optimistic bubble; only the prompt and mode are ours.
    await expect.poll(() => sent).toMatchObject({ text: prompt, mode: "steer" });
  } finally {
    release();
  }
});

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
