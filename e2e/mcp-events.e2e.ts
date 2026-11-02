import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { MCP_EVENTS_HEAD, MCP_EVENTS_TRAILER } from "../src/shared/notices";

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

const chipCount = (browser: Page, label: string) =>
  browser.evaluate((text) => {
    return [...document.querySelectorAll<HTMLElement>('[data-testid="queued-notice-chip"]')].filter(
      (node) => (node.textContent ?? "").includes(text),
    ).length;
  }, label);

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

test("cancelling the merged chip removes every queued id", async ({ app, browser, screen }) => {
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
  const prefix = `cancel-${tag}`;
  const release = join(tmpdir(), `pi-ui-mcp-cancel-${tag}`);
  const wait = `for i in $(seq 600); do [ -e '${release}' ] && break; sleep 0.1; done; echo released`;
  try {
    await send([
      {
        name: "mcp_events",
        arguments: {
          action: "subscribe",
          server: "stub",
          name: "stub-burst-cancel",
          arguments: { prefix },
        },
      },
      { name: "bash", arguments: { command: wait } },
    ]);
    await expect.poll(() => chipCount(browser, "3 queued"), { timeout: 20_000 }).toBe(1);
    await browser
      .locator('[data-testid="queued-notice-chip"]')
      .filter({ hasText: "3 queued" })
      .getByRole("button", { name: "cancel" })
      .tap();
    await expect
      .poll(
        () =>
          browser.evaluate(async () => {
            const res = await fetch("/api/state");
            const state = (await res.json()) as { queue?: unknown[] };
            return {
              queue: (state.queue ?? []).length,
              chips: document.querySelectorAll('[data-testid="queued-notice-chip"]').length,
            };
          }),
        { timeout: 20_000 },
      )
      .toEqual({ queue: 0, chips: 0 });
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
              notice?: { kind?: string; events?: Array<{ id?: string | null }> };
            }>;
          };
          return { run: value.run ?? "", messages: value.messages ?? [] };
        });
        return state.messages.filter(
          (message) =>
            message.notice?.kind === "mcp" &&
            (message.notice?.events ?? []).some((event) =>
              (event.id ?? "").startsWith(`${prefix}-`),
            ),
        ).length;
      },
      { timeout: 30_000 },
    )
    .toBe(0);

  const subscription = (await mcpEvents(browser)).subscriptions.find(
    (item) => item.name === "stub-burst-cancel",
  );
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
          (await mcpEvents(browser)).subscriptions.find((item) => item.name === "stub-burst-cancel")
            ?.status,
        { timeout: 20_000 },
      )
      .toBe("stopped");
  }
});

test("a single queued MCP event stays one message with one event", async ({
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
  const prefix = `single-${tag}`;
  const release = join(tmpdir(), `pi-ui-mcp-single-${tag}`);
  const wait = `for i in $(seq 600); do [ -e '${release}' ] && break; sleep 0.1; done; echo released`;
  try {
    await send([
      {
        name: "mcp_events",
        arguments: {
          action: "subscribe",
          server: "stub",
          name: "stub-single",
          arguments: { prefix },
        },
      },
      { name: "bash", arguments: { command: wait } },
    ]);
    await expect.poll(() => chipCount(browser, "1 queued"), { timeout: 20_000 }).toBe(1);
  } finally {
    writeFileSync(release, "");
  }

  await expect
    .poll(
      async () => {
        const state = await burstNotices(browser);
        const single = state.notices.filter((notice) => notice.ids.includes(`${prefix}-1`));
        return {
          run: state.run,
          count: single.length,
          ids: single[0]?.ids ?? [],
        };
      },
      { timeout: 30_000 },
    )
    .toEqual({ run: "idle", count: 1, ids: [`${prefix}-1`] });

  const subscription = (await mcpEvents(browser)).subscriptions.find(
    (item) => item.name === "stub-single",
  );
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
          (await mcpEvents(browser)).subscriptions.find((item) => item.name === "stub-single")
            ?.status,
        { timeout: 20_000 },
      )
      .toBe("stopped");
  }
});

test("a burst over the text cap is delivered over several turns without a false remainder", async ({
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
  const prefix = `huge-${tag}`;
  const expected = [1, 2, 3, 4, 5].map((index) => `${prefix}-${index}`);
  const release = join(tmpdir(), `pi-ui-mcp-huge-${tag}`);
  const wait = `for i in $(seq 600); do [ -e '${release}' ] && break; sleep 0.1; done; echo released`;
  try {
    await send([
      {
        name: "mcp_events",
        arguments: {
          action: "subscribe",
          server: "stub",
          name: "stub-huge",
          arguments: { prefix },
        },
      },
      { name: "bash", arguments: { command: wait } },
    ]);
    await expect.poll(() => chipCount(browser, "5 queued"), { timeout: 20_000 }).toBe(1);
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
              text?: string;
              notice?: { kind?: string; events?: Array<{ id?: string | null }> };
            }>;
          };
          return { run: value.run ?? "", messages: value.messages ?? [] };
        });
        const parts = state.messages
          .filter((message) => message.notice?.kind === "mcp")
          .map((message) => ({
            ids: (message.notice?.events ?? []).map((event) => event.id ?? ""),
            text: message.text ?? "",
          }))
          .filter((part) => part.ids.some((id) => id.startsWith(`${prefix}-`)))
          .map((part) => {
            const summary = /carries (\d+) of (\d+) merged events; (\d+) remain\./.exec(part.text);
            return {
              ids: part.ids,
              carried: summary === null ? 0 : Number(summary[1]),
              total: summary === null ? 0 : Number(summary[2]),
              remain: summary === null ? -1 : Number(summary[3]),
              summaries: (part.text.match(/This notice carries/g) ?? []).length,
            };
          });
        if (state.run !== "idle" || parts.length <= 2) return false;
        let delivered = 0;
        for (const part of parts) {
          if (part.summaries !== 1 || part.total !== expected.length) return false;
          if (part.carried !== part.ids.length) return false;
          delivered += part.ids.length;
          if (part.remain !== expected.length - delivered) return false;
        }
        const ids = parts.flatMap((part) => part.ids);
        return delivered === expected.length && ids.join(",") === expected.join(",");
      },
      { timeout: 120_000 },
    )
    .toBe(true);
});

test("an update for a queued burst subject cannot hide the merged notice", async ({
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
  const prefix = `update-${tag}`;
  const expected = [1, 2, 3].map((index) => `${prefix}-${index}`);
  const release = join(tmpdir(), `pi-ui-mcp-update-${tag}`);
  const wait = `for i in $(seq 600); do [ -e '${release}' ] && break; sleep 0.1; done; echo released`;
  try {
    await send([
      {
        name: "mcp_events",
        arguments: {
          action: "subscribe",
          server: "stub",
          name: "stub-burst-update",
          arguments: { prefix },
        },
      },
      { name: "bash", arguments: { command: wait } },
    ]);
    await expect.poll(() => chipCount(browser, "3 queued"), { timeout: 20_000 }).toBe(1);
    await expect
      .poll(
        async () =>
          (await mcpEvents(browser)).events.some((event) => event.id === `${prefix}-update`),
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
        const merged = state.notices.filter((notice) =>
          expected.every((id) => notice.ids.includes(id)),
        );
        return {
          run: state.run,
          count: merged.length,
          ids: merged[0]?.ids ?? [],
        };
      },
      { timeout: 30_000 },
    )
    .toEqual({ run: "idle", count: 1, ids: expected });

  const subscription = (await mcpEvents(browser)).subscriptions.find(
    (item) => item.name === "stub-burst-update",
  );
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
          (await mcpEvents(browser)).subscriptions.find((item) => item.name === "stub-burst-update")
            ?.status,
        { timeout: 20_000 },
      )
      .toBe("stopped");
  }
});

const chatState = (browser: Page) =>
  browser.evaluate(async () => {
    const res = await fetch("/api/state");
    const state = (await res.json()) as {
      run?: string;
      messages?: Array<{ role?: string; text?: string; notice?: { kind?: string } }>;
    };
    return {
      run: state.run ?? "",
      messages: (state.messages ?? []).map((message) => ({
        role: message.role ?? "",
        text: message.text ?? "",
        noticeKind: message.notice?.kind ?? "",
      })),
    };
  });

test("an MCP notice is not a message and an assistant echo is dropped", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 900 });
  await app.open("/");
  const send = async (text: string) => {
    await screen.getByRole("textbox", "Message").fill(text);
    await screen.getByRole("button", "Send").tap();
  };

  // A normal answer gives the conversation a visible message before the notice.
  const keep = `KEEP previous ${Date.now()}`;
  await send(keep);
  await expect
    .poll(
      async () =>
        (await chatState(browser)).messages.some(
          (message) => message.role === "assistant" && message.text.includes(keep),
        ),
      { timeout: 20_000 },
    )
    .toBe(true);

  await send(
    `TOOLCALLS ${JSON.stringify([{ name: "tool_search", arguments: { query: "mcp_events" } }])}`,
  );
  await expect.poll(async () => (await chatState(browser)).run, { timeout: 20_000 }).toBe("idle");

  const tag = Date.now();
  const prefix = `ECHO_MCP_NOTICE-${tag}`;
  const release = join(tmpdir(), `pi-ui-mcp-echo-${tag}`);
  try {
    // Hold the stream closed until the subscription turn is fully idle, so the
    // notice starts its own turn and the model's verbatim echo is the only reply.
    await send(
      `TOOLCALLS ${JSON.stringify([
        {
          name: "mcp_events",
          arguments: {
            action: "subscribe",
            server: "stub",
            name: "stub-burst-late",
            arguments: { release, prefix },
          },
        },
      ])}`,
    );
    await expect
      .poll(
        async () =>
          (await mcpEvents(browser)).subscriptions.find((item) => item.name === "stub-burst-late")
            ?.status,
        { timeout: 20_000 },
      )
      .toBe("active");
    await expect.poll(async () => (await chatState(browser)).run, { timeout: 20_000 }).toBe("idle");

    writeFileSync(release, "");
    await expect
      .poll(
        async () => {
          const state = await chatState(browser);
          const notice = state.messages.find(
            (message) => message.noticeKind === "mcp" && message.text.includes(prefix),
          );
          const noticeText = notice?.text.trim() ?? "";
          const last = state.messages.at(-1);
          return {
            run: state.run,
            hasHead: notice?.text.startsWith(MCP_EVENTS_HEAD) ?? false,
            hasTrailer: notice?.text.includes(MCP_EVENTS_TRAILER) ?? false,
            echoed: state.messages.some(
              (message) =>
                message.role === "assistant" &&
                (message.text.trim().startsWith(MCP_EVENTS_HEAD) ||
                  (noticeText.length > 0 && message.text.trim() === noticeText)),
            ),
            lastRole: last?.role ?? "",
            lastNotice: last?.noticeKind ?? "",
          };
        },
        { timeout: 30_000 },
      )
      .toEqual({
        run: "idle",
        hasHead: true,
        hasTrailer: true,
        echoed: false,
        lastRole: "user",
        lastNotice: "mcp",
      });
  } finally {
    writeFileSync(release, "");
  }

  // Mentioning MCP events in a normal answer is not an echo and still appears.
  const mention = `MCP events are useful ${tag}`;
  await send(mention);
  await expect
    .poll(
      async () => {
        const state = await chatState(browser);
        return {
          run: state.run,
          visible: state.messages.some(
            (message) => message.role === "assistant" && message.text.includes(mention),
          ),
        };
      },
      { timeout: 20_000 },
    )
    .toEqual({ run: "idle", visible: true });

  const subscription = (await mcpEvents(browser)).subscriptions.find(
    (item) => item.name === "stub-burst-late",
  );
  if (subscription !== undefined && subscription.id.length > 0) {
    await send(
      `TOOLCALLS ${JSON.stringify([
        {
          name: "mcp_events",
          arguments: { action: "unsubscribe", subscription_id: subscription.id },
        },
      ])}`,
    );
    await expect
      .poll(
        async () =>
          (await mcpEvents(browser)).subscriptions.find((item) => item.name === "stub-burst-late")
            ?.status,
        { timeout: 20_000 },
      )
      .toBe("stopped");
  }
});
