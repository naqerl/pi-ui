import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("resets the composer to one line with the caret at the start after send", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  const initial = await composer.boundingBox();
  expect(initial).not.toBeNull();

  await composer.fill("hello timeline");
  await screen.getByRole("button", "Send").tap();

  await expect(screen.getByText("hello timeline", { exact: true })).toBeVisible();
  await expect(screen.getByText("Echo: hello timeline", { exact: false })).toBeVisible({
    timeout: 15_000,
  });
  await expect(composer).toHaveValue("");

  const after = await composer.boundingBox();
  expect(after).not.toBeNull();
  expect(after?.height ?? 0).toBeCloseTo(initial?.height ?? 0, 0);
  expect(after?.height ?? 0).toBeLessThanOrEqual(38);

  const state = await browser.evaluate(() => {
    const element = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
    if (element === null) return null;
    return {
      height: element.getBoundingClientRect().height,
      overflowY: getComputedStyle(element).overflowY,
      selectionStart: element.selectionStart,
      selectionEnd: element.selectionEnd,
    };
  });
  expect(state).not.toBeNull();
  expect(state?.overflowY).toBe("hidden");
  expect(state?.selectionStart).toBe(0);
  expect(state?.selectionEnd).toBe(0);
});

test("resets a multi-line draft to one line after send", async ({ app, browser, screen }) => {
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  const initial = await composer.boundingBox();
  expect(initial).not.toBeNull();

  await composer.fill("line one\nline two\nline three");
  const expanded = await composer.boundingBox();
  expect(expanded).not.toBeNull();
  expect(expanded?.height ?? 0).toBeGreaterThan(initial?.height ?? 0);

  await screen.getByRole("button", "Send").tap();
  await expect(composer).toHaveValue("");

  const state = await browser.evaluate(() => {
    const element = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
    if (element === null) return null;
    return {
      height: element.getBoundingClientRect().height,
      overflowY: getComputedStyle(element).overflowY,
      scrollTop: element.scrollTop,
      selectionStart: element.selectionStart,
      selectionEnd: element.selectionEnd,
    };
  });
  expect(state).not.toBeNull();
  expect(state?.height ?? 0).toBeLessThanOrEqual(38);
  expect(state?.overflowY).toBe("hidden");
  expect(state?.scrollTop).toBe(0);
  expect(state?.selectionStart).toBe(0);
  expect(state?.selectionEnd).toBe(0);
});

test("keeps the draft when a send is rejected", async ({ app, browser, screen }) => {
  await browser.route("**/api/message", async (route) => {
    await route.fulfill({ status: 409, body: "conflict" });
  });
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  await composer.fill("keep this draft\nwith two lines");
  const before = await composer.boundingBox();
  expect(before).not.toBeNull();

  await screen.getByRole("button", "Send").tap();
  await expect(composer).toHaveValue("keep this draft\nwith two lines");
  await expect(browser.locator('[data-pending-send="true"]')).toHaveCount(0);

  const after = await composer.boundingBox();
  expect(after?.height ?? 0).toBeCloseTo(before?.height ?? 0, 0);
});

test("paints the pending bubble before the message request returns", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  await browser.route("**/api/message", async (route) => {
    requests += 1;
    // Hold the request open: a client that waits for 202 cannot paint this bubble.
    await gate;
    await route.continue();
  });

  const text = `painted before 202 ${Date.now()}`;
  await composer.fill(text);
  try {
    await screen.getByRole("button", "Send").tap();
    const pending = browser.locator('[data-pending-send="true"]').filter({ hasText: text });
    await expect(pending).toBeVisible({ timeout: 1_500 });
    expect(requests).toBe(1);
    // The gate is still closed, so the bubble above was painted before any response.
    await expect(pending).toBeVisible();
  } finally {
    release();
  }

  await expect(screen.getByText(`Echo: ${text}`, { exact: false })).toBeVisible({
    timeout: 15_000,
  });
  await expect(browser.locator('[data-pending-send="true"]')).toHaveCount(0);
  await expect(browser.locator('[data-role="user"]').filter({ hasText: text })).toHaveCount(1);
});

test("renders assistant markdown without unsafe HTML", async ({ app, browser, screen }) => {
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  await composer.fill("MARKDOWN please");
  await screen.getByRole("button", "Send").tap();

  await expect(screen.getByRole("heading", { name: "Markdown heading", level: 1 })).toBeVisible({
    timeout: 15_000,
  });
  await expect(screen.getByText("bold", { exact: true })).toBeVisible();
  await expect(browser.locator("pre code").filter({ hasText: "const answer = 42;" })).toHaveCount(
    1,
  );
  const link = screen.getByRole("link", "Example");
  await expect(link).toHaveAttribute("href", "https://example.com/docs");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noreferrer noopener");
});

test("keeps the composer geometry stable across run start and stop", async ({ app, screen }) => {
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  const initial = await composer.boundingBox();
  expect(initial).not.toBeNull();

  await composer.fill("SLOW response please");
  await screen.getByRole("button", "Send").tap();
  await expect(screen.getByRole("button", "Stop")).toBeVisible();

  const running = await composer.boundingBox();
  expect(running).not.toBeNull();
  expect(running?.width ?? 0).toBeCloseTo(initial?.width ?? 0, 0);
  expect(running?.height ?? 0).toBeCloseTo(initial?.height ?? 0, 0);

  await composer.fill("draft while running");
  const typed = await composer.boundingBox();
  expect(typed?.width ?? 0).toBeCloseTo(initial?.width ?? 0, 0);
  await composer.fill("");

  const cleared = await composer.boundingBox();
  expect(cleared?.width ?? 0).toBeCloseTo(initial?.width ?? 0, 0);
  expect(cleared?.height ?? 0).toBeCloseTo(initial?.height ?? 0, 0);

  await screen.getByRole("button", "Stop").tap();
  await expect(screen.getByRole("button", "Send")).toBeVisible();

  const idle = await composer.boundingBox();
  expect(idle?.width ?? 0).toBeCloseTo(initial?.width ?? 0, 0);
  expect(idle?.height ?? 0).toBeCloseTo(initial?.height ?? 0, 0);
});
