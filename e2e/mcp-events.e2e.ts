import { test } from "@e2e-dev/web";
import { expect } from "e2e";

type Page = { evaluate: <T, A = undefined>(fn: (arg: A) => T | Promise<T>, arg?: A) => Promise<T> };

interface EventsRead {
  events: Array<{ id: string; server: string; name: string }>;
  subscriptions: Array<{ id: string; name: string; status: string; cursor: string | null }>;
  notice: string | null;
}

const mcpEvents = (browser: Page) =>
  browser.evaluate(async () => {
    const res = await fetch("/api/state");
    return ((await res.json()) as { mcpEvents: EventsRead }).mcpEvents;
  });

const hubSubscription = async (browser: Page) =>
  (await mcpEvents(browser)).subscriptions.find((item) => item.name === "stub-hub");

// Regression for #3: events from a live subscription, not only `mcp_events`
// tool results, must reach the feed behind /api/state, the inline notice, the
// `MCP events` widget and the mcp widget. The stub's `stub-hub` stream sends
// what a hub sends: events named after the stream with a `stub-hub.job` kind
// in data.kind, which the notice and widgets show.
test("a subscription's events reach the feed, the chat notice and both MCP widgets", async ({
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

  // mcp_events is deferred behind tool_search.
  await send([{ name: "tool_search", arguments: { query: "mcp_events" } }]);
  await expect
    .poll(
      () =>
        browser.evaluate(async () => {
          const res = await fetch("/api/state");
          const state = (await res.json()) as {
            run?: string;
            activity?: Array<{ name?: string; output?: string }>;
          };
          const loaded = (state.activity ?? []).some(
            (item) => item.name === "tool_search" && (item.output ?? "").includes("mcp_events"),
          );
          return loaded && state.run === "idle";
        }),
      { timeout: 20_000 },
    )
    .toBe(true);

  await send([
    {
      name: "mcp_events",
      arguments: { action: "subscribe", server: "stub", name: "stub-hub" },
    },
  ]);
  await expect
    .poll(
      async () => (await mcpEvents(browser)).events.find((event) => event.id === "510") ?? null,
      {
        timeout: 30_000,
      },
    )
    .toEqual(expect.objectContaining({ server: "stub", name: "stub-hub.job" }));
  expect((await mcpEvents(browser)).notice).toBe("new event from stub");
  expect(await hubSubscription(browser)).toEqual(
    expect.objectContaining({ status: "active", cursor: "hub:510" }),
  );

  // The follow-up lands in the chat as an MCP notice, not a raw bubble.
  await expect
    .poll(
      () =>
        browser.evaluate(() =>
          [
            ...document.querySelectorAll<HTMLElement>(
              '[data-testid="chat-notice"][data-notice-kind="mcp"]',
            ),
          ].map(
            (node) => node.querySelector('[data-testid="chat-notice-summary"]')?.textContent ?? "",
          ),
        ),
      { timeout: 20_000 },
    )
    .toContain("MCP stub: stub-hub.job event");

  await screen.getByRole("tab", "Stats").tap();
  await expect(screen.getByTestId("widget-mcp-events")).toBeVisible();
  const widgets = () =>
    browser.evaluate(() => ({
      event: document.querySelector('[data-testid="stat-mcp-event-510"] dt')?.textContent ?? null,
      stub: document.querySelector('[data-testid="stat-mcp-stub"]')?.textContent ?? null,
    }));
  await expect.poll(widgets, { timeout: 10_000 }).toEqual({
    event: "stub · stub-hub.job",
    stub: expect.stringContaining("subscribed: stub-hub"),
  });
  await app.screenshot("mcp-subscription-widgets");

  // Unsubscribe so the shared server's later specs see no live stream.
  await screen.getByRole("tab", "Chat").tap();
  const id = (await hubSubscription(browser))?.id;
  expect(id).toBeTruthy();
  await send([{ name: "mcp_events", arguments: { action: "unsubscribe", subscription_id: id } }]);
  await expect
    .poll(async () => (await hubSubscription(browser))?.status, { timeout: 20_000 })
    .toBe("stopped");
});
