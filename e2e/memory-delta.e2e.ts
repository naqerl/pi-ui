import type { Browser } from "@e2e-dev/web";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";

type DeltaTopic = { path?: string; title?: string; chars?: number; updated?: string };
type DeltaNotice = { kind?: string; topics?: DeltaTopic[]; summary?: string };
type State = {
  run?: string;
  messages?: Array<{ text?: string; notice?: DeltaNotice }>;
  activity?: Array<{ name?: string; isError?: boolean }>;
  instructions?: string;
};

const state = (browser: Browser) =>
  browser.evaluate(async () => {
    return (await (await fetch("/api/state", { cache: "no-store" })).json()) as State;
  });

const deltas = async (browser: Browser) =>
  (await state(browser)).messages?.filter((message) => message.notice?.kind === "memory-delta") ??
  [];

const liveInstructions = async (browser: Browser) => (await state(browser)).instructions ?? "";

async function waitForIdle(browser: Browser): Promise<void> {
  await expect.poll(async () => (await state(browser)).run ?? "", { timeout: 60_000 }).toBe("idle");
}

async function sendCalls(browser: Browser, calls: unknown[]): Promise<void> {
  const status = await browser.evaluate(async (toolCalls) => {
    const response = await fetch("/api/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `TOOLCALLS ${JSON.stringify(toolCalls)}` }),
    });
    return response.status;
  }, calls as never);
  expect(status).toBe(202);
}

async function waitForMemoryTools(browser: Browser, count: number): Promise<void> {
  await expect
    .poll(
      async () =>
        ((await state(browser)).activity ?? []).filter(
          (item) => item.name === "memory_write" && item.isError !== true,
        ).length,
      { timeout: 60_000 },
    )
    .toBeGreaterThanOrEqual(count);
}

test("two long-term writes in one turn publish one delta naming both topics", async ({
  app,
  browser,
}) => {
  const stamp = Date.now();
  const first = `topics/projects/delta-alpha-${stamp}.md`;
  const second = `topics/forge/delta-beta-${stamp}.md`;
  await app.open("/");
  await sendCalls(browser, [
    {
      name: "memory_write",
      arguments: {
        target: "long_term",
        topic: first,
        body: "# Delta alpha\n\nthe first topic body is long enough to report a size.",
      },
    },
    {
      name: "memory_write",
      arguments: {
        target: "long_term",
        topic: second,
        body: "# Delta beta\n\nthe second topic body is also counted.",
      },
    },
  ]);

  await expect.poll(async () => (await deltas(browser)).length, { timeout: 60_000 }).toBe(1);
  await waitForIdle(browser);
  const [delta] = await deltas(browser);
  const text = delta?.text ?? "";
  expect(text.match(/Memory updated:/g)).toHaveLength(1);
  expect(text).toContain(first);
  expect(text).toContain("Delta alpha");
  expect(text).toContain(second);
  expect(text).toContain("Delta beta");
  expect(text).toMatch(/\d+ chars, updated \d{4}-\d{2}-\d{2}/);
  expect(text).toContain("memory_read");
  expect(delta?.notice?.topics?.map((topic) => topic.path).sort()).toEqual([first, second].sort());
});

test("a long-term write leaves the live instructions byte-identical", async ({ app, browser }) => {
  const stamp = Date.now();
  const path = `topics/projects/stable-${stamp}.md`;
  await app.open("/");
  const before = await liveInstructions(browser);
  expect(before.length).toBeGreaterThan(0);

  await sendCalls(browser, [
    {
      name: "memory_write",
      arguments: {
        target: "long_term",
        topic: path,
        body: "# Stable topic\n\nthe system prompt must not change for this write.",
      },
    },
  ]);
  await expect.poll(async () => (await deltas(browser)).length, { timeout: 60_000 }).toBe(1);
  await waitForIdle(browser);
  expect(await liveInstructions(browser)).toBe(before);

  // A later ordinary turn refreshes the checkpoint without rewriting the prompt.
  await sendCalls(browser, [{ name: "memory_read", arguments: { path } }]);
  await waitForIdle(browser);
  expect(await liveInstructions(browser)).toBe(before);
});

test("daily and scratchpad writes publish no delta and keep instructions stable", async ({
  app,
  browser,
}) => {
  await app.open("/");
  const before = await liveInstructions(browser);
  await sendCalls(browser, [
    { name: "memory_write", arguments: { target: "daily", body: "a daily note" } },
    { name: "memory_write", arguments: { target: "scratchpad", body: "an open item" } },
  ]);
  await waitForMemoryTools(browser, 2);
  await waitForIdle(browser);
  expect(await deltas(browser)).toHaveLength(0);
  expect(await liveInstructions(browser)).toBe(before);
});
