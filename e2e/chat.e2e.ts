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

  const after = await composer.boundingBox();
  expect(after?.height ?? 0).toBeCloseTo(before?.height ?? 0, 0);
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

test("shows one Stop while the field is empty, then one Steer while it has text", async ({
  app,
  screen,
}) => {
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  await composer.fill("SLOW response please");
  await screen.getByRole("button", "Send").tap();

  await expect(screen.getByRole("button", "Stop")).toHaveCount(1);
  await expect(screen.getByRole("button", "Stop")).toBeVisible();
  await expect(screen.getByRole("button", "Steer")).toHaveCount(0);

  await composer.fill("queued while running");
  await expect(screen.getByRole("button", "Stop")).toHaveCount(0);
  await expect(screen.getByRole("button", "Steer")).toHaveCount(1);
  await expect(screen.getByRole("button", "Steer")).toBeVisible();
  await expect(screen.getByRole("button", "Queue")).toHaveCount(0);

  await composer.fill("");
  await expect(screen.getByRole("button", "Stop")).toHaveCount(1);
  await expect(screen.getByRole("button", "Steer")).toHaveCount(0);
  await screen.getByRole("button", "Stop").tap();
  await expect(screen.getByRole("button", "Stop")).toHaveCount(0);
  await expect(screen.getByRole("button", "Send")).toHaveCount(1);
});

test("long-presses Steer to queue the message", async ({ app, browser, screen }) => {
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  await composer.fill("SLOW response please");
  await screen.getByRole("button", "Send").tap();
  await expect(screen.getByRole("button", "Stop")).toBeVisible();

  await browser.evaluate(() => {
    sessionStorage.removeItem("pi-ui:steer-long-press-hint");
    return true;
  });
  await composer.fill("long press queued");
  await expect(screen.getByText("Hold Steer to queue without interrupting the run.")).toBeVisible();

  const steer = screen.getByRole("button", "Steer");
  await expect(steer).toBeVisible();
  await steer.longPress({ duration: 700 });

  await expect(composer).toHaveValue("");
  await expect(screen.getByText("long press queued", { exact: true })).toBeVisible();
  await expect(screen.getByRole("button", "Stop")).toBeVisible();
  await expect(screen.getByText("Hold Steer to queue without interrupting the run.")).toHaveCount(
    0,
  );

  await composer.fill("second draft");
  await expect(screen.getByRole("button", "Steer")).toBeVisible();
  await expect(screen.getByText("Hold Steer to queue without interrupting the run.")).toHaveCount(
    0,
  );
  await composer.fill("");
  await expect(screen.getByRole("button", "Stop")).toBeVisible();

  await screen.getByRole("button", "cancel").tap();
  await expect(screen.getByText("long press queued", { exact: true })).toHaveCount(0);
  await screen.getByRole("button", "Stop").tap();
});

test("announces the steer long-press hint only once across runs", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  await browser.evaluate(() => {
    sessionStorage.removeItem("pi-ui:steer-long-press-hint");
    return true;
  });
  const composer = screen.getByRole("textbox", "Message");

  await composer.fill("SLOW first run");
  await screen.getByRole("button", "Send").tap();
  await expect(screen.getByRole("button", "Stop")).toBeVisible();
  await composer.fill("first draft");
  await expect(screen.getByText("Hold Steer to queue without interrupting the run.")).toBeVisible();
  await composer.fill("");
  await screen.getByRole("button", "Stop").tap();
  await expect(screen.getByRole("button", "Send")).toBeVisible();

  await composer.fill("SLOW second run");
  await screen.getByRole("button", "Send").tap();
  await expect(screen.getByRole("button", "Stop")).toBeVisible();
  await composer.fill("second run draft");
  await expect(screen.getByRole("button", "Steer")).toBeVisible();
  await expect(screen.getByText("Hold Steer to queue without interrupting the run.")).toHaveCount(
    0,
  );
  await composer.fill("");
  await screen.getByRole("button", "Stop").tap();
});

test("cancels a Steer long press when the pointer moves", async ({ app, browser, screen }) => {
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  await composer.fill("SLOW response please");
  await screen.getByRole("button", "Send").tap();
  await expect(screen.getByRole("button", "Stop")).toBeVisible();

  await composer.fill("not queued");
  const steer = screen.getByRole("button", "Steer");
  const box = await steer.boundingBox();
  expect(box).not.toBeNull();
  const x = (box?.x ?? 0) + (box?.width ?? 0) / 2;
  const y = (box?.y ?? 0) + (box?.height ?? 0) / 2;

  await browser.mouse.move(x, y);
  await browser.mouse.down();
  await browser.mouse.move(x + 20, y);
  await new Promise((resolve) => setTimeout(resolve, 650));
  await browser.mouse.up();

  await expect(composer).toHaveValue("not queued");
  await expect(screen.getByRole("button", "Steer")).toBeVisible();
  await expect(screen.getByRole("button", "cancel")).toHaveCount(0);

  await composer.fill("");
  await screen.getByRole("button", "Stop").tap();
});

test("blurs the composer after send on a coarse-pointer mobile viewport", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await browser.addInitScript(`
    (() => {
      const original = window.matchMedia.bind(window);
      window.matchMedia = (query) => {
        if (query !== "(pointer: coarse)") return original(query);
        return {
          matches: true,
          media: query,
          onchange: null,
          addListener() {},
          removeListener() {},
          addEventListener() {},
          removeEventListener() {},
          dispatchEvent() { return false; },
        };
      };
    })();
  `);
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  await composer.fill("MOBILE blur");
  await composer.press("Enter");

  await expect(screen.getByText("Echo: MOBILE blur", { exact: false })).toBeVisible({
    timeout: 15_000,
  });
  const activeTag = await browser.evaluate(() => document.activeElement?.tagName ?? "");
  expect(activeTag).not.toBe("TEXTAREA");
});

test("keeps the composer height and bottom edge when the viewport height changes", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  const before = await composer.boundingBox();
  expect(before).not.toBeNull();

  await browser.setViewport({ width: 390, height: 500 });
  const geometry = await browser.evaluate(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    const element = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
    if (element === null) return null;
    const box = element.getBoundingClientRect();
    return { height: box.height, bottom: box.bottom, viewportHeight: window.innerHeight };
  });

  expect(geometry).not.toBeNull();
  expect(geometry?.height ?? 0).toBeCloseTo(before?.height ?? 0, 0);
  expect(geometry?.bottom ?? 0).toBeLessThanOrEqual((geometry?.viewportHeight ?? 0) + 1);
});

test("removes the header Activity link while keeping the activity route", async ({
  app,
  screen,
}) => {
  await app.open("/");
  await expect(screen.getByRole("link", "Activity")).toHaveCount(0);
  await expect(screen.getByRole("link", "pi")).toBeVisible();

  await app.open("/activity");
  await expect(screen.getByRole("heading", { name: "Activity", level: 1 })).toBeVisible();
  await expect(screen.getByRole("link", "Back to chat")).toBeVisible();
});
