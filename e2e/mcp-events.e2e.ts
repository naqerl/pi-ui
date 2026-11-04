import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { burstNotices, chipCount, hubSubscription, mcpEvents } from "./mcp-events-helpers.js";

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
            (node) => node.querySelector('[data-testid="chat-notice-summary"]')?.textContent ?? "",
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

  // Unsubscribe so the shared server's later specs see no live stream.
  await screen.getByRole("tab", "Chat").tap();
  const id = (await hubSubscription(browser))?.id;
  expect(id).toBeTruthy();
  await send([{ name: "mcp_events", arguments: { action: "unsubscribe", subscription_id: id } }]);
  await expect
    .poll(async () => (await hubSubscription(browser))?.status, { timeout: 60_000 })
    .toBe("stopped");
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

  await send([{ name: "tool_search", arguments: { query: "mcp_events" } }]);
  await expect
    .poll(
      () =>
        browser.evaluate(async () => {
          const res = await fetch("/api/state");
          const state = (await res.json()) as { run?: string };
          return state.run === "idle";
        }),
      { timeout: 20_000 },
    )
    .toBe(true);

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
            [...document.querySelectorAll<HTMLElement>('[data-testid="queued-notice-chip"]')].some(
              (node) => (node.textContent ?? "").includes("3 queued"),
            ),
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
  if (subscription !== undefined && subscription.id.length > 0) {
    await send([
      {
        name: "mcp_events",
        arguments: { action: "unsubscribe", subscription_id: subscription.id },
      },
    ]);
    await expect
      .poll(
        async () =>
          (await mcpEvents(browser)).subscriptions.find((item) => item.name === "stub-burst")
            ?.status,
        { timeout: 20_000 },
      )
      .toBe("stopped");
  }
});

test("a typed message between two bursts stays between their notices", async ({
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
  await send([{ name: "tool_search", arguments: { query: "mcp_events" } }]);
  await expect
    .poll(
      () =>
        browser.evaluate(async () => {
          const res = await fetch("/api/state");
          const state = (await res.json()) as { run?: string };
          return state.run === "idle";
        }),
      { timeout: 20_000 },
    )
    .toBe(true);

  const tag = Date.now();
  const human = `between bursts ${tag}`;
  const earlyPrefix = `early-${tag}`;
  const latePrefix = `late-${tag}`;
  const earlyIds = [1, 2, 3].map((index) => `${earlyPrefix}-${index}`);
  const lateIds = [1, 2, 3].map((index) => `${latePrefix}-${index}`);
  const release = join(tmpdir(), `pi-ui-mcp-between-${tag}`);
  const lateRelease = join(tmpdir(), `pi-ui-mcp-between-late-${tag}`);
  const wait = `for i in $(seq 600); do [ -e '${release}' ] && break; sleep 0.1; done; echo released`;
  try {
    await send([
      {
        name: "mcp_events",
        arguments: {
          action: "subscribe",
          server: "stub",
          name: "stub-burst-early",
          arguments: { prefix: earlyPrefix },
        },
      },
      {
        name: "mcp_events",
        arguments: {
          action: "subscribe",
          server: "stub",
          name: "stub-burst-late",
          arguments: { release: lateRelease, prefix: latePrefix },
        },
      },
      { name: "bash", arguments: { command: wait } },
    ]);

    // The early burst queues first; the late stream is still waiting for its release file.
    await expect.poll(() => chipCount(browser, "3 queued"), { timeout: 20_000 }).toBe(1);
    const queued = await browser.evaluate(async (text) => {
      const response = await fetch("/api/message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, mode: "queue" }),
      });
      return response.ok;
    }, human);
    expect(queued).toBe(true);
    await expect(
      browser.locator('[data-pending-queue="true"]').filter({ hasText: human }),
    ).toHaveCount(1);

    // The human message is visibly between the runs before the late burst exists.
    writeFileSync(lateRelease, "");
    await expect.poll(() => chipCount(browser, "3 queued"), { timeout: 20_000 }).toBe(2);
  } finally {
    writeFileSync(release, "");
  }

  await expect
    .poll(
      async () => {
        const state = await browser.evaluate(async () => {
          const res = await fetch("/api/state");
          const value = (await res.json()) as {
            run?: string;
            messages?: Array<{
              role?: string;
              text?: string;
              notice?: { kind?: string; events?: Array<{ id?: string | null }> };
            }>;
          };
          return { run: value.run ?? "", messages: value.messages ?? [] };
        });
        const ids = (message: (typeof state.messages)[number]) =>
          (message.notice?.events ?? []).map((event) => event.id ?? "");
        const early = state.messages.findIndex((message) =>
          ids(message).includes(`${earlyPrefix}-1`),
        );
        const late = state.messages.findIndex((message) =>
          ids(message).includes(`${latePrefix}-1`),
        );
        const humanAt = state.messages.findIndex(
          (message) => message.role === "user" && message.text === human,
        );
        return {
          run: state.run,
          early: early < 0 ? [] : ids(state.messages[early] ?? {}),
          late: late < 0 ? [] : ids(state.messages[late] ?? {}),
          between: early >= 0 && humanAt > early && late > humanAt,
          notices: state.messages.filter(
            (message) =>
              message.notice?.kind === "mcp" &&
              ids(message).some(
                (id) => id.startsWith(`${earlyPrefix}-`) || id.startsWith(`${latePrefix}-`),
              ),
          ).length,
        };
      },
      { timeout: 30_000 },
    )
    .toEqual({
      run: "idle",
      early: earlyIds,
      late: lateIds,
      between: true,
      notices: 2,
    });

  for (const name of ["stub-burst-early", "stub-burst-late"]) {
    const subscription = (await mcpEvents(browser)).subscriptions.find(
      (item) => item.name === name,
    );
    if (subscription === undefined || subscription.id.length === 0) continue;
    await send([
      {
        name: "mcp_events",
        arguments: { action: "unsubscribe", subscription_id: subscription.id },
      },
    ]);
    await expect
      .poll(
        async () =>
          (await mcpEvents(browser)).subscriptions.find((item) => item.name === name)?.status,
        { timeout: 20_000 },
      )
      .toBe("stopped");
  }
});
