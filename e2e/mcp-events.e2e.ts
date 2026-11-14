import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

type Page = { evaluate: <T, A = undefined>(fn: (arg: A) => T | Promise<T>, arg?: A) => Promise<T> };

interface EventsRead {
  events: Array<{ id: string; server: string; name: string }>;
  subscriptions: Array<{
    id: string;
    stableId: string;
    name: string;
    status: string;
    cursor: string | null;
  }>;
  notice: string | null;
}

const mcpEvents = (browser: Page) =>
  browser.evaluate(async () => {
    const res = await fetch("/api/state");
    return ((await res.json()) as { mcpEvents: EventsRead }).mcpEvents;
  });

const hubSubscription = async (browser: Page) =>
  (await mcpEvents(browser)).subscriptions.find((item) => item.name === "stub-hub");

/**
 * Stops a subscription by its durable id. Cancelling by adapter id can be
 * defeated by a late status or a replacement row, which is exactly what the
 * shared feed does after several members; the durable id covers every alias.
 */
async function stopSubscription(browser: Page, name: string) {
  const subscription = (await mcpEvents(browser)).subscriptions.find((item) => item.name === name);
  if (subscription === undefined) return;
  const result = await browser.evaluate(async (stableId) => {
    const response = await fetch(`/api/mcp/subscriptions/${encodeURIComponent(stableId)}`, {
      method: "DELETE",
    });
    return { ok: response.ok, status: response.status, body: await response.text() };
  }, subscription.stableId);
  if (!result.ok) throw new Error(`cancel ${name} failed: ${result.status} ${result.body}`);
  await expect
    .poll(
      async () =>
        (await mcpEvents(browser)).subscriptions.find(
          (item) => item.stableId === subscription.stableId,
        )?.status,
      { timeout: 20_000 },
    )
    .toBe("cancelled");
}

/** The highest activity order a completed tool_search already has. */
async function toolSearchOrder(browser: Page): Promise<number> {
  return browser.evaluate(async () => {
    const res = await fetch("/api/state");
    const state = (await res.json()) as { activity?: Array<{ name?: string; order?: number }> };
    return Math.max(
      0,
      ...(state.activity ?? [])
        .filter((item) => item.name === "tool_search")
        .map((item) => item.order ?? 0),
    );
  });
}

/** Waits for a tool_search entry newer than the previous member's, then idle. */
async function awaitToolSearch(browser: Page, previousOrder: number) {
  await expect
    .poll(
      () =>
        browser.evaluate(async (before) => {
          const res = await fetch("/api/state");
          const state = (await res.json()) as {
            run?: string;
            activity?: Array<{ name?: string; order?: number }>;
          };
          const fresh = (state.activity ?? []).some(
            (item) => item.name === "tool_search" && (item.order ?? 0) > before,
          );
          return fresh && state.run === "idle";
        }, previousOrder),
      { timeout: 20_000 },
    )
    .toBe(true);
}

describe("MCP events against one shared app", { serial: true }, () => {
  beforeEach(async ({ browser }) => {
    await browser.unrouteAll();
    await browser.setViewport({ width: 1280, height: 900 });
  });

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
        { timeout: 60_000 },
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
              (node) =>
                node.querySelector('[data-testid="chat-notice-summary"]')?.textContent ?? "",
            ),
          ),
        { timeout: 60_000 },
      )
      .toContain("MCP stub: stub-hub.job event");

    await screen.getByRole("tab", "Stats").tap();
    await expect(screen.getByTestId("widget-mcp-events")).toBeVisible();
    const widgets = () =>
      browser.evaluate(() => ({
        event: document.querySelector('[data-testid="stat-mcp-event-510"] dt')?.textContent ?? null,
        stub: document.querySelector('[data-testid="stat-mcp-stub"]')?.textContent ?? null,
      }));
    await expect.poll(widgets, { timeout: 60_000 }).toEqual({
      event: "stub · stub-hub.job",
      stub: expect.stringContaining("subscribed: stub-hub"),
    });
    await app.screenshot("mcp-subscription-widgets");

    // Stop the stream by its durable id so a replaced adapter row cannot revive it.
    await screen.getByRole("tab", "Chat").tap();
    const subscription = await hubSubscription(browser);
    expect(subscription?.stableId).toBeTruthy();
    await stopSubscription(browser, "stub-hub");
  });

  const burstNotices = (browser: Page) =>
    browser.evaluate(async () => {
      const res = await fetch("/api/state");
      const state = (await res.json()) as {
        run?: string;
        messages?: Array<{
          notice?: { kind?: string; summary?: string; events?: Array<{ id?: string | null }> };
        }>;
      };
      return {
        run: state.run ?? "",
        notices: (state.messages ?? [])
          .filter((message) => message.notice?.kind === "mcp")
          .map((message) => ({
            summary: message.notice?.summary ?? "",
            ids: (message.notice?.events ?? []).map((event) => event.id ?? ""),
          })),
      };
    });

  test("a burst of queued MCP events is delivered as one notice", async ({
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

    const searchOrder = await toolSearchOrder(browser);
    await send([{ name: "tool_search", arguments: { query: "mcp_events" } }]);
    await awaitToolSearch(browser, searchOrder);

    // Subscribe and hold the tool round open until all three events have queued.
    const tag = Date.now();
    const prefix = `burst-${tag}`;
    const ids = [1, 2, 3].map((index) => `${prefix}-${index}`);
    const release = join(tmpdir(), `pi-ui-mcp-burst-${tag}`);
    const wait = `for i in $(seq 600); do [ -e '${release}' ] && break; sleep 0.1; done; echo released`;
    try {
      await send([
        {
          name: "mcp_events",
          arguments: {
            action: "subscribe",
            server: "stub",
            name: "stub-burst",
            arguments: { prefix },
          },
        },
        { name: "bash", arguments: { command: wait } },
      ]);

      await expect
        .poll(
          () =>
            browser.evaluate(() =>
              [
                ...document.querySelectorAll<HTMLElement>('[data-testid="queued-notice-chip"]'),
              ].some((node) => (node.textContent ?? "").includes("3 queued")),
            ),
          { timeout: 20_000 },
        )
        .toBe(true);
    } finally {
      writeFileSync(release, "");
    }

    await expect
      .poll(
        async () => {
          const state = await burstNotices(browser);
          const burst = state.notices.filter((notice) =>
            notice.ids.some((id) => id.startsWith(`${prefix}-`)),
          );
          return {
            run: state.run,
            count: burst.length,
            ids: burst[0]?.ids ?? [],
            summary: burst[0]?.summary ?? "",
          };
        },
        { timeout: 30_000 },
      )
      .toEqual({
        run: "idle",
        count: 1,
        ids,
        summary: "MCP stub: 3 stub-burst.event events",
      });

    const subscription = (await mcpEvents(browser)).subscriptions.find(
      (item) => item.name === "stub-burst",
    );
    expect(subscription?.id).toBeTruthy();
    if (subscription !== undefined) await stopSubscription(browser, "stub-burst");
  });
});
