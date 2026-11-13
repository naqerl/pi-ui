import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createOpenTask, openTaskChatTab } from "./tasks-helpers";

/** The main chat's one-off top gap: 16px of content padding, unchanged by this fix. */
const MAIN_CHAT_TOP_GAP = 16;

interface TranscriptGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  scrollerTop: number;
  chatTop: number;
  headerBottom: number | null;
  firstTop: number;
  firstToScroller: number;
  firstToSecond: number | null;
  composerTop: number;
}

function readTranscript(browser: Browser): Promise<TranscriptGeometry | null> {
  return browser.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="task-agent-transcript"]');
    const content = scroller?.firstElementChild;
    const rows = [...(content?.querySelectorAll<HTMLElement>("[data-message-id]") ?? [])];
    const first = rows[0];
    const second = rows[1];
    const chat = document.querySelector<HTMLElement>('[data-testid="task-agent-chat"]');
    const header = document.querySelector<HTMLElement>('[data-testid="task-header"]');
    const composer = document.querySelector<HTMLElement>('[data-testid="composer-dock"]');
    if (
      scroller === null ||
      scroller === undefined ||
      first === undefined ||
      chat === null ||
      composer === null
    ) {
      return null;
    }
    const scrollerRect = scroller.getBoundingClientRect();
    const firstRect = first.getBoundingClientRect();
    return {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      scrollerTop: scrollerRect.top,
      chatTop: chat.getBoundingClientRect().top,
      headerBottom: header?.getBoundingClientRect().bottom ?? null,
      firstTop: firstRect.top,
      firstToScroller: firstRect.top - scrollerRect.top,
      firstToSecond: second ? second.getBoundingClientRect().top - firstRect.bottom : null,
      composerTop: composer.getBoundingClientRect().top,
    };
  });
}

async function scrollTranscriptToTop(browser: Browser) {
  await browser.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="task-agent-transcript"]');
    if (scroller !== null) scroller.scrollTop = 0;
    return true;
  });
  await expect
    .poll(async () => (await readTranscript(browser))?.scrollTop ?? 99)
    .toBeLessThanOrEqual(1);
}

test("the plan transcript's first-row gap scrolls with the content, with no fixed band", {
  timeout: 240_000,
}, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks");
  const title = `Plan top gap ${Date.now()}`;
  await createOpenTask(screen, title, { project: "pi-ui" });
  await openTaskChatTab(screen);
  await expect(screen.getByTestId("task-agent-chat")).toBeVisible();
  await expect(
    screen.getByTestId("task-agent-transcript").getByText(title, { exact: true }),
  ).toBeVisible();
  await expect(
    browser.locator('[data-testid="task-agent-chat"] [data-role="assistant"]'),
  ).toBeVisible({ timeout: 30_000 });
  await expect(screen.getByTestId("task-agent-status")).toHaveText("idle", { timeout: 30_000 });

  const taskId = await browser.evaluate(async (taskTitle) => {
    const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
      tasks: Array<{ id: string; title: string }>;
    };
    return ledger.tasks.find((task) => task.title === taskTitle)?.id ?? null;
  }, title);
  expect(taskId).not.toBeNull();
  if (taskId === null) return;

  await scrollTranscriptToTop(browser);
  const short = await readTranscript(browser);
  expect(short).not.toBeNull();
  if (short === null) return;

  // One turn already has a top gap: it is the same 12px the rows use between them.
  expect(short.firstToSecond).not.toBeNull();
  expect(short.firstToScroller).toBeGreaterThanOrEqual((short.firstToSecond ?? 12) - 1);
  expect(short.firstToScroller).toBeLessThanOrEqual((short.firstToSecond ?? 12) + 2);
  // The scroller starts under the tabs, not after a pane-level strip.
  expect(short.headerBottom).not.toBeNull();
  if (short.headerBottom !== null) {
    expect(short.scrollerTop - short.headerBottom).toBeLessThanOrEqual(1);
    expect(short.chatTop - short.headerBottom).toBeLessThanOrEqual(1);
  }

  // A second user turn must not move the composer: the gap lives in the transcript,
  // so it cannot collapse when another row arrives.
  const input = screen.getByTestId("task-agent-input");
  await input.fill(`Second plan turn ${title}`);
  await screen.getByTestId("task-agent-send").tap();
  await expect(
    screen.getByTestId("task-agent-transcript").getByText(`Second plan turn ${title}`, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(screen.getByTestId("task-agent-status")).toHaveText("idle", { timeout: 30_000 });
  const second = await readTranscript(browser);
  expect(second).not.toBeNull();
  if (second === null) return;
  expect(Math.abs(second.composerTop - short.composerTop)).toBeLessThanOrEqual(1);

  // Grow the transcript until it scrolls, then return to its top.
  for (let index = 0; index < 6; index += 1) {
    const status = await browser.evaluate(
      async ({ id, text }) => {
        const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        return response.status;
      },
      { id: taskId, text: `Plan top row ${index} ${title}` },
    );
    expect(status).toBe(202);
  }
  await expect
    .poll(
      () =>
        browser.evaluate(
          () =>
            document.querySelectorAll('[data-testid="task-agent-transcript"] [data-message-id]')
              .length,
        ),
      { timeout: 60_000 },
    )
    .toBeGreaterThanOrEqual(14);
  await expect(screen.getByTestId("task-agent-status")).toHaveText("idle", { timeout: 60_000 });

  await scrollTranscriptToTop(browser);
  const long = await readTranscript(browser);
  expect(long).not.toBeNull();
  if (long === null) return;
  expect(long.scrollHeight).toBeGreaterThan(long.clientHeight);
  expect(long.scrollTop).toBeLessThanOrEqual(1);

  // Scrolled to the top, the first row still sits one normal gap below the scroller's
  // edge, and no strip of pane padding remains above the transcript.
  expect(long.firstToSecond).not.toBeNull();
  expect(Math.abs(long.firstToScroller - short.firstToScroller)).toBeLessThanOrEqual(1);
  expect(long.firstTop - long.scrollerTop).toBeLessThanOrEqual((long.firstToSecond ?? 12) + 2);
  if (long.headerBottom !== null) {
    expect(long.scrollerTop - long.headerBottom).toBeLessThanOrEqual(1);
    expect(long.chatTop - long.headerBottom).toBeLessThanOrEqual(1);
  }
  // Scrolling the transcript never moves the composer.
  expect(Math.abs(long.composerTop - short.composerTop)).toBeLessThanOrEqual(1);
});

const mainThread = {
  conversationId: "plan-chat-top-main",
  messages: [
    {
      id: "main-first",
      role: "user",
      text: "The first main-chat message.",
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString(),
      order: 1,
    },
    {
      id: "main-second",
      role: "assistant",
      text: "The second main-chat message.",
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 1)).toISOString(),
      order: 2,
    },
  ],
  activity: [],
  run: "idle",
  queue: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
  context: { tokens: 0, window: null, percent: null },
};

test("the main chat keeps its own first-message gap", { timeout: 180_000 }, async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await browser.addInitScript(() => {
    if (!("serviceWorker" in navigator)) return;
    Object.defineProperty(navigator.serviceWorker, "register", {
      configurable: true,
      value: async () => undefined,
    });
  });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: mainThread });
  });
  await app.open("/");
  await expect(screen.getByText("The first main-chat message.", { exact: true })).toBeVisible();

  const geometry = await browser.evaluate(() => {
    const content = document.querySelector<HTMLElement>('[data-testid="chat-content"]');
    const rows = [...(content?.querySelectorAll<HTMLElement>("[data-message-id]") ?? [])];
    const first = rows[0];
    const second = rows[1];
    if (content === null || first === undefined) return null;
    const contentRect = content.getBoundingClientRect();
    const firstRect = first.getBoundingClientRect();
    return {
      contentTop: contentRect.top,
      firstTop: firstRect.top,
      firstToContent: firstRect.top - contentRect.top,
      firstToSecond: second ? second.getBoundingClientRect().top - firstRect.bottom : null,
    };
  });
  expect(geometry).not.toBeNull();
  if (geometry === null) return;
  expect(geometry.firstToContent).toBe(MAIN_CHAT_TOP_GAP);
  expect(geometry.firstToSecond).toBe(MAIN_CHAT_TOP_GAP);
});
