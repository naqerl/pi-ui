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

test("summarises a long reply and expands it from the keyboard", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  await composer.fill("LONG answer with a summary please");
  await screen.getByRole("button", "Send").tap();

  const latestReply = browser.locator('[data-role="assistant"]').last();
  await expect(
    latestReply.getByText("Paragraph 40 of a long answer", { exact: false }),
  ).toBeVisible({
    timeout: 15_000,
  });
  const id = await browser.evaluate(() => {
    const bubbles = [...document.querySelectorAll<HTMLElement>('[data-role="assistant"]')];
    return bubbles.at(-1)?.dataset.messageId ?? "";
  });
  expect(id).not.toBe("");
  const bubble = browser.locator(`[data-message-id="${id}"]`);
  const summary = bubble.getByTestId("message-summary");
  await expect(summary).toBeVisible({ timeout: 15_000 });
  await expect(summary).toHaveText("Summary: the assistant answered the request in detail.");

  const toggle = bubble.getByTestId("summary-toggle");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const collapsed = await browser.evaluate((messageId) => {
    const body = document.querySelector<HTMLElement>(
      `[data-message-id="${messageId}"] [data-testid="message-body"]`,
    );
    if (body === null) return null;
    return {
      expanded: body.dataset.expanded ?? "",
      clipped: body.scrollHeight > body.clientHeight + 1,
    };
  }, id);
  expect(collapsed).toEqual({ expanded: "false", clipped: true });

  await toggle.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const expanded = await browser.evaluate((messageId) => {
    const body = document.querySelector<HTMLElement>(
      `[data-message-id="${messageId}"] [data-testid="message-body"]`,
    );
    if (body === null) return null;
    return {
      expanded: body.dataset.expanded ?? "",
      clipped: body.scrollHeight > body.clientHeight + 1,
      controls:
        document
          .querySelector(`[data-message-id="${messageId}"] [data-testid="summary-toggle"]`)
          ?.getAttribute("aria-controls") ?? "",
      bodyId: body.id,
    };
  }, id);
  expect(expanded?.expanded).toBe("true");
  expect(expanded?.clipped).toBe(false);
  expect(expanded?.controls).toBe(expanded?.bodyId);

  await toggle.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(composer).toBeVisible();
});

test("leaves a short reply without a summary or expand control", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  await composer.fill("short reply without a summary");
  await screen.getByRole("button", "Send").tap();

  await expect(
    screen.getByText("Echo: short reply without a summary", { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  const state = await browser.evaluate(() => {
    const bubbles = [...document.querySelectorAll<HTMLElement>('[data-role="assistant"]')];
    const bubble = bubbles.at(-1);
    return {
      summary: bubble?.querySelector('[data-testid="message-summary"]') !== null,
      toggle: bubble?.querySelector('[data-testid="summary-toggle"]') !== null,
    };
  });
  expect(state).toEqual({ summary: false, toggle: false });
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
  await expect(screen.getByTestId("header-activity")).toHaveText(/^working( · |$)/);
  await expect(screen.getByTestId("working-status")).toHaveAttribute("data-open", "true");
  const status = await browser.evaluate(() => {
    const header = document.querySelector("header");
    const footer = document.querySelector("textarea")?.closest("form")?.parentElement ?? null;
    const working = document.querySelector("[data-testid=working-status]");
    if (header === null || footer === null || working === null) return null;
    const slide = working.querySelector(".working-strip-slide");
    return {
      inHeader: header.contains(working),
      inFooter: footer.contains(working),
      firstInFooter: footer.firstElementChild === working,
      headerWidth: header.getBoundingClientRect().width,
      footerWidth: footer.getBoundingClientRect().width,
      transition: getComputedStyle(working).transitionProperty,
      slide: slide === null ? "" : getComputedStyle(slide).transform,
    };
  });
  expect(status).not.toBeNull();
  expect(status?.inHeader).toBe(false);
  expect(status?.inFooter).toBe(true);
  expect(status?.firstInFooter).toBe(true);
  expect(status?.headerWidth ?? 0).toBeCloseTo(status?.footerWidth ?? -1, 0);
  expect(status?.transition ?? "").toContain("grid-template-rows");
  expect(status?.slide ?? "").not.toBe("none");

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
    const header = document.querySelector("header")?.getBoundingClientRect();
    const footer = element.closest("form")?.parentElement?.getBoundingClientRect();
    return {
      height: box.height,
      bottom: box.bottom,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      headerLeft: header?.left ?? null,
      headerRight: header?.right ?? null,
      footerLeft: footer?.left ?? null,
      footerRight: footer?.right ?? null,
      endTop: (() => {
        const main = document.querySelector("main");
        const content = main?.firstElementChild;
        const headerBox = document.querySelector("header")?.getBoundingClientRect();
        if (main == null || content == null || headerBox == null || footer == null) {
          return null;
        }
        const mainBox = main.getBoundingClientRect();
        return (
          Number.parseFloat(getComputedStyle(content).paddingTop) - (headerBox.bottom - mainBox.top)
        );
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
  expect(Math.abs(geometry?.headerLeft ?? 1)).toBeLessThanOrEqual(1);
  expect(
    Math.abs((geometry?.headerRight ?? 0) - (geometry?.viewportWidth ?? 0)),
  ).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry?.footerLeft ?? 1)).toBeLessThanOrEqual(1);
  expect(
    Math.abs((geometry?.footerRight ?? 0) - (geometry?.viewportWidth ?? 0)),
  ).toBeLessThanOrEqual(1);
  expect(geometry?.endTop ?? 0).toBeCloseTo(16, 0);
  expect(geometry?.endBottom ?? 0).toBeCloseTo(16, 0);
});

test("removes the header Activity link while keeping the activity route", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/");
  await expect(screen.getByRole("link", "Activity")).toHaveCount(0);
  await screen.getByRole("button", "pi").tap();
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

  await app.open("/activity");
  await expect(screen.getByRole("heading", { name: "Activity", level: 1 })).toBeVisible();
  await expect(screen.getByRole("link", "Back to chat")).toBeVisible();
  const card = await browser.evaluate(() => {
    const frame = document.querySelector("[data-testid=activity-card]");
    const scroll = document.querySelector("[data-testid=activity-scroll]");
    const heading = document.querySelector("h1");
    if (frame === null || scroll === null || heading === null) return null;
    const box = frame.getBoundingClientRect();
    return {
      top: box.top,
      left: box.left,
      right: window.innerWidth - box.right,
      bottom: window.innerHeight - box.bottom,
      headingOutside: !scroll.contains(heading),
      overflow: getComputedStyle(scroll).overflowY,
    };
  });
  expect(card).not.toBeNull();
  expect(card?.top ?? 0).toBeGreaterThan(8);
  expect(card?.left ?? 0).toBeGreaterThan(8);
  expect(card?.right ?? 0).toBeGreaterThan(8);
  expect(card?.bottom ?? 0).toBeGreaterThan(8);
  expect(card?.headingOutside).toBe(true);
  expect(card?.overflow).toBe("auto");

  await app.open("/events");
  await expect(screen.getByRole("heading", { name: "MCP subscriptions", level: 1 })).toBeVisible();
  await expect(screen.getByRole("link", "Back to chat")).toBeVisible();
  await expect(screen.getByRole("button", "pi")).toBeVisible();
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

  await screen.getByRole("button", "pi").tap();
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
  await screen.getByRole("button", "pi").tap();
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
