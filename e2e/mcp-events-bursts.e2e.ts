import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { MCP_EVENTS_HEAD, MCP_EVENTS_TRAILER } from "../src/shared/notices";
import { burstNotices, chatState, chipCount, mcpEvents } from "./mcp-events-helpers.js";

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
