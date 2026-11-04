import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import type { McpEventsState, McpSubscriptionView } from "../src/shared/types";

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

test("the events page names each event's subscription and filters by topic", async ({
  app,
  browser,
  screen,
}) => {
  const eventsAt = (second: number) => new Date(Date.UTC(2026, 0, 2, 12, 0, second)).toISOString();
  const subscriptions: McpSubscriptionView[] = [
    {
      id: "sub-hub",
      stableId: "stub-hub",
      server: "stub",
      name: "hub-stream",
      title: "Hub topic",
      status: "active",
      state: "active",
      arguments: { topic: "hub" },
      cursor: "hub:1",
    },
    {
      id: "sub-alerts",
      stableId: "stub-alerts",
      server: "stub",
      name: "alerts-stream",
      title: "Alerts topic",
      status: "active",
      state: "active",
      arguments: { topic: "alerts" },
      cursor: "alerts:1",
    },
  ];
  const initialEvents: McpEventsState = {
    subscriptions,
    events: [
      {
        id: "hub-1",
        server: "stub",
        name: "hub.job",
        timestamp: eventsAt(1),
        summary: "hub update",
        subscriptionId: "sub-hub",
        topic: "hub",
      },
      {
        id: "alerts-1",
        server: "stub",
        name: "alerts.event",
        timestamp: eventsAt(2),
        summary: "alerts update",
        subscriptionId: "sub-alerts",
        topic: "alerts",
      },
    ],
    notice: "new event from stub",
    revision: 41,
  };
  let snapshot = {
    ...activitySnapshot,
    mcp: { servers: [], unavailable: [] },
    mcpEvents: initialEvents,
  };
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: JSON.parse(JSON.stringify(snapshot)) });
  });
  await app.open("/events");
  await expect(screen.getByRole("heading", { name: "Updates", level: 2 })).toBeVisible();

  const cards = () =>
    browser.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-testid="mcp-event-card"]')].map((card) => {
        const label = card.querySelector<HTMLElement>('[data-testid="mcp-event-label"]');
        return {
          label: label?.textContent?.trim() ?? "",
          name:
            card.querySelector<HTMLElement>('[data-testid="mcp-event-name"]')?.textContent ?? "",
          title: label?.getAttribute("title") ?? null,
        };
      }),
    );
  const chips = () =>
    browser.evaluate(() =>
      [...document.querySelectorAll<HTMLButtonElement>('[data-testid="mcp-topic-filter"]')].map(
        (button) => ({
          text: (button.textContent ?? "").replace(/\s+/g, " ").trim(),
          pressed: button.getAttribute("aria-pressed"),
        }),
      ),
    );

  // Each card names its subscription, and the topic is available on hover.
  await expect.poll(cards).toEqual([
    { label: "Alerts topic", name: "alerts.event", title: "topic: alerts" },
    { label: "Hub topic", name: "hub.job", title: "topic: hub" },
  ]);
  const groups = await browser.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid="mcp-event-group"]')].map((group) => ({
      label:
        group
          .querySelector<HTMLElement>('[data-testid="mcp-event-group-label"]')
          ?.textContent?.trim() ?? "",
      count: group.querySelectorAll('[data-testid="mcp-event-card"]').length,
    })),
  );
  expect(groups).toEqual([
    { label: "Alerts topic", count: 1 },
    { label: "Hub topic", count: 1 },
  ]);
  expect(await chips()).toEqual([
    { text: "All 2", pressed: "true" },
    { text: "Hub topic 1", pressed: "false" },
    { text: "Alerts topic 1", pressed: "false" },
  ]);

  // Filtering is local: one chip selects its subscription and flips aria-pressed.
  await screen.getByRole("button", { name: "Hub topic 1" }).tap();
  await expect.poll(cards).toEqual([{ label: "Hub topic", name: "hub.job", title: "topic: hub" }]);
  expect(await chips()).toEqual([
    { text: "All 2", pressed: "false" },
    { text: "Hub topic 1", pressed: "true" },
    { text: "Alerts topic 1", pressed: "false" },
  ]);

  // An id that no longer resolves falls back to the event's server name.
  snapshot = {
    ...snapshot,
    mcpEvents: {
      subscriptions: [],
      events: [
        {
          id: "orphan-1",
          server: "stub",
          name: "orphan.event",
          timestamp: eventsAt(3),
          summary: "orphan update",
          subscriptionId: "gone",
        },
      ],
      notice: "new event from stub",
      revision: 42,
    } satisfies McpEventsState,
  };
  await app.open("/events");
  await expect.poll(cards).toEqual([{ label: "stub", name: "orphan.event", title: null }]);
});
