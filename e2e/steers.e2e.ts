import { test } from "@e2e-dev/web";
import { expect } from "e2e";

type Bubble = { text: string; pending: boolean; role: string };
type Browser = { evaluate: <T>(fn: () => T) => Promise<T> };

/** The page's visible text runs in document order. */
async function textRuns(browser: Browser): Promise<string[]> {
  return browser.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const runs: string[] = [];
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      if (text) runs.push(text);
    }
    return runs;
  });
}

/** Where the last answer starts; markdown can split it over several text nodes. */
function lastEcho(runs: string[]): number {
  for (let index = runs.length - 1; index >= 0; index -= 1) {
    if (runs[index]?.startsWith("Echo")) return index;
  }
  return -1;
}

async function bubbles(browser: { evaluate: <T>(fn: () => T) => Promise<T> }): Promise<Bubble[]> {
  return browser.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>("[data-message-id]")].map((element) => ({
      text: element.textContent ?? "",
      pending: element.dataset.pendingSteer === "true",
      role: element.dataset.role ?? "",
    })),
  );
}

// Steers sent during a tool call go in together right after it, in the order sent, and show in
// the transcript where they went in. Before, durable placed one per turn boundary, so the second
// steer started a run of its own after the answer to the first.
test("steers sent during a tool call all arrive right after it, in order", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const tag = Date.now();
  const calls = [{ name: "bash", arguments: { command: "sleep 4; echo slept" } }];
  const composer = screen.getByRole("textbox", "Message");
  await composer.fill(`TOOLCALLS ${JSON.stringify(calls)}`);
  await screen.getByRole("button", "Send").tap();
  await expect(screen.getByRole("button", "Stop")).toBeVisible();

  await composer.fill(`alpha ${tag}`);
  await composer.press("Enter");
  await composer.fill(`beta ${tag}`);
  await composer.press("Enter");

  // Waiting for the tool: both show as pending steers below the run's work.
  await expect
    .poll(async () => (await bubbles(browser)).filter((item) => item.pending).length)
    .toBe(2);
  const pending = (await bubbles(browser)).slice(-2);
  expect(pending[0]?.text).toContain(`alpha ${tag}`);
  expect(pending[1]?.text).toContain(`beta ${tag}`);
  expect(pending[0]?.text).toContain("steer · pending");

  // Both go in after the tool round; the model answers them in the same run.
  await expect(screen.getByText(`Echo: beta ${tag}`, { exact: false })).toBeVisible({
    timeout: 20_000,
  });
  await expect(screen.getByRole("button", "Send")).toBeVisible({ timeout: 15_000 });
  await expect(screen.getByText(`Echo: alpha ${tag}`, { exact: false })).toHaveCount(0);
  const final = await bubbles(browser);
  expect(final.some((item) => item.pending)).toBe(false);
  const alpha = final.find((item) => item.text.includes(`alpha ${tag}`));
  expect(alpha?.text).toContain("steer");
  expect(alpha?.text).not.toContain("pending");
  const runs = await textRuns(browser);
  const index = (needle: string) => runs.findIndex((run) => run.startsWith(needle));
  expect(index("1 tool call")).toBeGreaterThan(-1);
  expect(index("1 tool call")).toBeLessThan(index(`alpha ${tag}`));
  expect(index(`alpha ${tag}`)).toBeLessThan(index(`beta ${tag}`));
  expect(index(`beta ${tag}`)).toBeLessThan(lastEcho(runs));

  // A reload shows the same order from the server.
  await app.open("/");
  await expect(screen.getByText(`Echo: beta ${tag}`, { exact: false })).toBeVisible();
  const reloaded = await textRuns(browser);
  const at = (needle: string) => reloaded.findIndex((run) => run.startsWith(needle));
  expect(at(`alpha ${tag}`)).toBeGreaterThan(-1);
  expect(at(`alpha ${tag}`)).toBeLessThan(at(`beta ${tag}`));
  expect(at(`beta ${tag}`)).toBeLessThan(lastEcho(reloaded));
});

test("ArrowUp in an empty composer takes back the newest pending steer", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const tag = Date.now();
  const composer = screen.getByRole("textbox", "Message");
  await composer.fill("SLOW response please");
  await screen.getByRole("button", "Send").tap();
  await expect(screen.getByRole("button", "Stop")).toBeVisible();

  try {
    await composer.fill(`first ${tag}`);
    await composer.press("Enter");
    await composer.fill(`second ${tag}`);
    await composer.press("Enter");
    await expect
      .poll(async () => (await bubbles(browser)).filter((item) => item.pending).length)
      .toBe(2);

    await composer.press("ArrowUp");
    await expect(composer).toHaveValue(`second ${tag}`);
    await expect
      .poll(async () => (await bubbles(browser)).filter((item) => item.pending).length)
      .toBe(1);
    const left = (await bubbles(browser)).filter((item) => item.pending);
    expect(left[0]?.text).toContain(`first ${tag}`);

    // With text in the composer ArrowUp is the caret's again.
    await composer.press("ArrowUp");
    await expect(composer).toHaveValue(`second ${tag}`);
    await expect
      .poll(async () => (await bubbles(browser)).filter((item) => item.pending).length)
      .toBe(1);

    await composer.fill("");
    await composer.press("ArrowUp");
    await expect(composer).toHaveValue(`first ${tag}`);
    await expect
      .poll(async () => (await bubbles(browser)).filter((item) => item.pending).length)
      .toBe(0);

    // The server dropped them too: another tab sees none.
    const state = await browser.evaluate(async () => {
      const response = await fetch("/api/state");
      const snapshot = (await response.json()) as { steers?: unknown[] };
      return { steers: snapshot.steers?.length ?? -1 };
    });
    expect(state.steers).toBe(0);

    // Sending it again makes it pending again.
    await composer.press("Enter");
    await expect(composer).toHaveValue("");
    await expect
      .poll(async () => (await bubbles(browser)).filter((item) => item.pending).length)
      .toBe(1);
  } finally {
    const stop = screen.getByRole("button", "Stop");
    if ((await stop.count()) > 0) await stop.tap();
  }
  await expect(screen.getByRole("button", "Send")).toBeVisible();
  await expect(screen.getByText(`Echo: second ${tag}`, { exact: false })).toHaveCount(0);
});
