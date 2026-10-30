import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  browser,
  screen,
}) => {
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  const sendMark = await browser.evaluate(() => {
    const button = document.querySelector('button[aria-label="Send"]');
    const mark = button?.querySelector("svg");
    if (button == null || mark == null) return null;
    const box = mark.getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      background: getComputedStyle(button).backgroundColor,
    };
  });
  expect(sendMark).not.toBeNull();
  expect(sendMark?.width).toBeGreaterThan(0);
  expect(sendMark?.width).toBeCloseTo(sendMark?.height ?? -1, 0);
  expect(
    sendMark?.background === "transparent" || sendMark?.background === "rgba(0, 0, 0, 0)",
  ).toBe(true);
  await composer.fill("SLOW response please");
  await screen.getByRole("button", "Send").tap();

  await expect(screen.getByRole("button", "Stop")).toHaveCount(1);
  await expect(screen.getByRole("button", "Stop")).toBeVisible();
  await expect(screen.getByRole("button", "Steer")).toHaveCount(0);
  const stopMark = await browser.evaluate(() => {
    const button = document.querySelector('button[aria-label="Stop"]');
    const mark = button?.querySelector("svg");
    const circle = mark?.querySelector("circle");
    const square = mark?.querySelector("rect");
    if (mark === null || mark === undefined || circle === null || circle === undefined) return null;
    if (square === null || square === undefined) return null;
    return {
      circle: getComputedStyle(circle).fill,
      ink: getComputedStyle(mark).color,
      square: getComputedStyle(square).fill,
    };
  });
  expect(stopMark).not.toBeNull();
  expect(stopMark?.circle).toBe(stopMark?.ink);
  expect(stopMark?.square).toBe("rgb(255, 255, 255)");
  const stopSize = await browser.evaluate(() => {
    const mark = document.querySelector('button[aria-label="Stop"] svg');
    if (mark == null) return null;
    const box = mark.getBoundingClientRect();
    return { width: box.width, height: box.height };
  });
  expect(stopSize?.width).toBeCloseTo(sendMark?.width ?? -1, 0);
  expect(stopSize?.height).toBeCloseTo(sendMark?.height ?? -1, 0);

  await expect(composer).toHaveAttribute("placeholder", "Message pi");
  await expect(screen.getByTestId("header-activity")).toHaveText("working");
  await expect(screen.getByTestId("working-detail")).toHaveCount(0);
  await expect(screen.getByTestId("working-status")).toHaveAttribute("data-open", "true");
  const status = await browser.evaluate(() => {
    const header = document.querySelector("header");
    const dock = document.querySelector("[data-testid=composer-dock]");
    const working = document.querySelector("[data-testid=working-status]");
    const dots = document.querySelector("[data-testid=page-dots]");
    const gear = document.querySelector("[data-pi-menu]");
    if (
      !(dock instanceof HTMLElement) ||
      !(working instanceof HTMLElement) ||
      !(dots instanceof HTMLElement) ||
      !(gear instanceof HTMLElement)
    ) {
      return null;
    }
    return {
      noHeader: header === null,
      inDock: dock.contains(working) && dock.contains(dots) && dock.contains(gear),
      statusLeftOfDots: working.getBoundingClientRect().right <= dots.getBoundingClientRect().left,
      gearRightOfDots: gear.getBoundingClientRect().left >= dots.getBoundingClientRect().right,
      gearLabel: gear.getAttribute("aria-label"),
    };
  });
  expect(status).not.toBeNull();
  expect(status?.noHeader).toBe(true);
  expect(status?.inDock).toBe(true);
  expect(status?.statusLeftOfDots).toBe(true);
  expect(status?.gearRightOfDots).toBe(true);
  expect(status?.gearLabel).toBe("Settings");

  await composer.fill("typed while running");
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
  await expect(screen.getByTestId("working-status")).toHaveAttribute("data-open", "false");
  await expect(screen.getByTestId("working-status")).toHaveText("idle");
});

test("steers a running turn from the button and from Enter", async ({ app, screen }) => {
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  await composer.fill("SLOW response please");
  await screen.getByRole("button", "Send").tap();
  await expect(screen.getByRole("button", "Stop")).toBeVisible();

  try {
    await composer.fill("steer from the button");
    await expect(composer).toHaveAttribute("placeholder", "Message pi");
    await expect(screen.getByText("Hold Steer to queue without interrupting the run.")).toHaveCount(
      0,
    );
    await screen.getByRole("button", "Steer").tap();

    await expect(composer).toHaveValue("");
    await expect(screen.getByText("steer from the button", { exact: true })).toBeVisible();
    await expect(screen.getByRole("button", "Queue")).toHaveCount(0);
    await expect(screen.getByRole("button", "cancel")).toHaveCount(0);

    await composer.fill("steer from enter");
    await composer.press("Enter");
    await expect(composer).toHaveValue("");
    await expect(screen.getByText("steer from enter", { exact: true })).toBeVisible();
    await expect(screen.getByRole("button", "Queue")).toHaveCount(0);
  } finally {
    const stop = screen.getByRole("button", "Stop");
    if ((await stop.count()) > 0) await stop.tap();
  }
});

test("keeps an accepted steer visible until its transcript entry arrives", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const tag = Date.now();
  const release = join(tmpdir(), `pi-ui-chat-steer-${tag}`);
  const wait = `for i in $(seq 600); do [ -e '${release}' ] && break; sleep 0.1; done; echo released`;
  const calls = [{ name: "bash", arguments: { command: wait } }];
  const composer = screen.getByRole("textbox", "Message");
  await composer.fill(`TOOLCALLS ${JSON.stringify(calls)}`);
  await screen.getByRole("button", "Send").tap();
  await expect(screen.getByRole("button", "Stop")).toBeVisible();

  const text = `chat steer ${tag}`;
  await composer.fill(text);
  await composer.press("Enter");
  const pending = browser.locator('[data-pending-steer="true"]').filter({ hasText: text });
  await expect(pending).toBeVisible();
  const pendingText = await browser.evaluate((needle) => {
    const element = [...document.querySelectorAll<HTMLElement>('[data-pending-steer="true"]')].find(
      (bubble) => (bubble.textContent ?? "").includes(needle),
    );
    return (element?.textContent ?? "").toLowerCase();
  }, text);
  expect(pendingText.includes("steer · pending")).toBe(true);

  // The tool waits for the release file, so the steer cannot be consumed yet.
  await new Promise((resolve) => setTimeout(resolve, 250));
  await expect(pending).toBeVisible();

  // Watch the DOM across the handoff: there must be no moment where neither the pending
  // bubble nor the delivered steer bubble carries the message.
  await browser.evaluate((needle) => {
    const watch = { gap: false };
    const target = window as unknown as {
      __steerWatch?: { gap: boolean };
      __steerObserver?: MutationObserver;
    };
    target.__steerWatch = watch;
    const check = () => {
      const bubbles = [...document.querySelectorAll<HTMLElement>("[data-message-id]")];
      const visible = (isPending: boolean) =>
        bubbles.some(
          (element) =>
            (element.dataset.pendingSteer === "true") === isPending &&
            element.dataset.steerError !== "true" &&
            (element.textContent ?? "").includes(needle),
        );
      if (!visible(true) && !visible(false)) watch.gap = true;
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    target.__steerObserver = observer;
    check();
    return true;
  }, text);

  writeFileSync(release, "");
  await expect(screen.getByText(`Echo: ${text}`, { exact: false })).toBeVisible({
    timeout: 20_000,
  });
  await expect(screen.getByRole("button", "Send")).toBeVisible({ timeout: 15_000 });
  await expect(pending).toHaveCount(0);

  const delivered = browser.locator('[data-role="user"]').filter({ hasText: text });
  await expect(delivered).toBeVisible();
  const deliveredText = await browser.evaluate((needle) => {
    const element = [...document.querySelectorAll<HTMLElement>('[data-role="user"]')].find(
      (bubble) =>
        bubble.dataset.pendingSteer !== "true" && (bubble.textContent ?? "").includes(needle),
    );
    return (element?.textContent ?? "").toLowerCase();
  }, text);
  expect(deliveredText.includes("steer")).toBe(true);
  expect(deliveredText.includes("pending")).toBe(false);
  expect(deliveredText.includes("dropped")).toBe(false);

  const gap = await browser.evaluate(() => {
    const target = window as unknown as {
      __steerWatch?: { gap: boolean };
      __steerObserver?: MutationObserver;
    };
    target.__steerObserver?.disconnect();
    return target.__steerWatch?.gap ?? false;
  });
  expect(gap).toBe(false);
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
    const footer = document.querySelector('[data-testid="composer-dock"]')?.getBoundingClientRect();
    return {
      height: box.height,
      bottom: box.bottom,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      footerLeft: footer?.left ?? null,
      footerRight: footer?.right ?? null,
      endTop: (() => {
        const main = document.querySelector("main");
        const content = main?.firstElementChild;
        if (main == null || content == null) return null;
        return Number.parseFloat(getComputedStyle(content).paddingTop);
      })(),
      endBottom: (() => {
        const main = document.querySelector("main");
        const content = main?.firstElementChild;
        if (main == null || content == null || footer == null) return null;
        const mainBox = main.getBoundingClientRect();
        return (
          Number.parseFloat(getComputedStyle(content).paddingBottom) - (mainBox.bottom - footer.top)
        );
      })(),
    };
  });

  expect(geometry).not.toBeNull();
  expect(geometry?.height ?? 0).toBeCloseTo(before?.height ?? 0, 0);
  expect(geometry?.bottom ?? 0).toBeLessThanOrEqual((geometry?.viewportHeight ?? 0) + 1);
  expect(Math.abs(geometry?.footerLeft ?? 1)).toBeLessThanOrEqual(1);
  expect(
    Math.abs((geometry?.footerRight ?? 0) - (geometry?.viewportWidth ?? 0)),
  ).toBeLessThanOrEqual(1);
  expect(geometry?.endTop ?? 0).toBeCloseTo(16, 0);
  expect(geometry?.endBottom ?? 0).toBeCloseTo(16, 0);
});

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

test("switches the model from the pi menu", async ({ app, browser, screen }) => {
  await app.open("/");
  const before = await browser.evaluate(async () => {
    const response = await fetch("/api/models", { cache: "no-store" });
    return (await response.json()) as {
      current: { id: string } | null;
      models: Array<{ id: string }>;
    };
  });
  expect(before.current?.id).toBe("e2e-model");
  expect(before.models.map((item) => item.id).sort()).toEqual(["e2e-model", "e2e-other"]);

  await screen.getByRole("button", "Settings").tap();
  await expect(screen.getByRole("menuitem", { name: /^Model/ })).toBeVisible();
  await screen.getByRole("menuitem", { name: /^Model/ }).tap();
  await expect(screen.getByRole("menuitemradio", { name: /E2E Other/ })).toBeVisible();
  await screen.getByRole("menuitemradio", { name: /E2E Other/ }).tap();

  await expect
    .poll(async () =>
      browser.evaluate(async () => {
        const body = (await (await fetch("/api/models", { cache: "no-store" })).json()) as {
          current: { id: string } | null;
        };
        return body.current?.id ?? "";
      }),
    )
    .toBe("e2e-other");

  const contextWindow = await browser.evaluate(async () => {
    const state = (await (await fetch("/api/state", { cache: "no-store" })).json()) as {
      context: { window: number | null };
    };
    return state.context.window;
  });
  expect(contextWindow).toBe(8192);

  await app.open("/");
  await screen.getByRole("button", "Settings").tap();
  await expect(screen.getByRole("menuitem", { name: /e2e-other/ })).toBeVisible();

  const restored = await browser.evaluate(async () => {
    const response = await fetch("/api/model", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "e2e", id: "e2e-model" }),
    });
    return response.ok;
  });
  expect(restored).toBe(true);
});
