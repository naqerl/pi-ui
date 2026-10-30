import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

const seededTexts = [
  "\n\nThe tracer panel has four collectors.",
  "\u00a0\nHello there",
  "   \nHello there",
  "Hello there  ",
  "  \nHello there  \n",
];

const messages = [
  ...seededTexts,
  "Just one paragraph.",
  "First paragraph.\n\nSecond paragraph.",
].map((text, index) => ({
  id: `markdown-seed-${index}`,
  role: "assistant",
  text,
  timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
  order: index + 1,
}));

const snapshot = {
  conversationId: "markdown-e2e",
  messages,
  activity: [],
  run: "idle",
  queue: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
  context: { tokens: 0, window: null, percent: null },
};

const codeBlockSnapshot = (code: string) => ({
  ...snapshot,
  messages: [
    {
      id: "copy-bot",
      role: "assistant",
      text: `Here:\n\n\`\`\`ts\n${code}\n\`\`\``,
      timestamp: new Date(Date.UTC(2026, 0, 1)).toISOString(),
      order: 1,
    },
  ],
});

function readCopyButton(browser: Browser) {
  return browser.evaluate(() => {
    const pre = document.querySelector<HTMLElement>("main pre");
    const button = pre?.parentElement?.querySelector<HTMLElement>("button") ?? null;
    if (pre === null || button === null) return null;
    const box = pre.getBoundingClientRect();
    return {
      opacity: Number.parseFloat(getComputedStyle(button).opacity),
      height: box.height,
      scrollWidth: pre.scrollWidth,
      clientWidth: pre.clientWidth,
      label: button.getAttribute("aria-label"),
      text: button.textContent,
    };
  });
}

test("does not let whitespace-only lines inflate assistant markdown bubbles", async ({
  app,
  browser,
  screen,
}) => {
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: snapshot });
  });
  await app.open("/");

  await expect(screen.getByText("Just one paragraph.", { exact: true })).toBeVisible();
  await expect(browser.locator("main .space-y-2")).toHaveCount(7);

  const boxes = await browser.evaluate(() => {
    const roots = Array.from(document.querySelectorAll<HTMLElement>("main .space-y-2"));
    return roots.map((root) => {
      const box = root.getBoundingClientRect();
      const lineHeight = Number.parseFloat(getComputedStyle(root).lineHeight) || 0;
      const lines: Array<{ top: number; bottom: number }> = [];
      const addLine = (rect: DOMRect) => {
        if (rect.width <= 0 || rect.height <= 0) return;
        const leading = Math.max(0, lineHeight - rect.height) / 2;
        const top = rect.top - leading;
        const bottom = rect.bottom + leading;
        const line = lines.find((candidate) => Math.abs(candidate.top - top) <= 1);
        if (line === undefined) {
          lines.push({ top, bottom });
        } else {
          line.top = Math.min(line.top, top);
          line.bottom = Math.max(line.bottom, bottom);
        }
      };
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node = walker.nextNode();
      while (node !== null) {
        const value = node.nodeValue ?? "";
        let lineStart = 0;
        for (const part of value.split("\n")) {
          if (part.trim().length > 0) {
            const range = document.createRange();
            range.setStart(node, lineStart);
            range.setEnd(node, lineStart + part.length);
            for (const rect of Array.from(range.getClientRects())) addLine(rect);
          }
          lineStart += part.length + 1;
        }
        node = walker.nextNode();
      }
      lines.sort((a, b) => a.top - b.top);
      return {
        html: root.outerHTML,
        paragraphs: root.querySelectorAll(":scope > p").length,
        contentTop: box.top,
        contentBottom: box.bottom,
        contentHeight: box.height,
        firstLineTop: lines[0]?.top ?? box.top,
        lastLineBottom: lines.at(-1)?.bottom ?? box.bottom,
        lineRectsHeight: lines.reduce((sum, line) => sum + (line.bottom - line.top), 0),
      };
    });
  });

  expect(boxes).toHaveLength(7);
  for (const box of boxes.slice(0, seededTexts.length)) {
    expect(box.lineRectsHeight).toBeGreaterThan(0);
    expect(Math.abs(box.contentTop - box.firstLineTop)).toBeLessThanOrEqual(1);
    expect(box.contentHeight - box.lineRectsHeight).toBeLessThanOrEqual(2);
    expect(Math.abs(box.lastLineBottom - box.contentBottom)).toBeLessThanOrEqual(1);
  }

  expect(boxes[5]?.html).toBe(
    '<div class="min-w-0 max-w-full space-y-2 [overflow-wrap:anywhere]"><p class="whitespace-pre-wrap break-words">Just one paragraph.</p></div>',
  );
  expect(boxes[6]?.paragraphs).toBe(2);
  expect(boxes[6]?.html).toBe(
    '<div class="min-w-0 max-w-full space-y-2 [overflow-wrap:anywhere]"><p class="whitespace-pre-wrap break-words">First paragraph.</p><p class="whitespace-pre-wrap break-words">Second paragraph.</p></div>',
  );
});

const overflowText = [
  'Cancelled `hub_force_stop {job:"job_57af322b37f14e7cda5e09d6f0d1eb4f"}` and reran it.',
  "",
  "See https://example.com/a/very/long/path/that/keeps/going/without/any/spaces/at/all/9f8e7d6c5b4a3f2e1d0c",
  "",
  "Supercalifragilisticexpialidociousandthensomemorelettersthatnevertakeabreath.",
  "",
  "1. New daemon confirmed (`pid 1771245`).",
  '2. `hub_force_stop {job:"job_57af322b37f14e7cda5e09d6f0d1eb4f"}` — the call hung.',
  "3. Rerun `job_4003e6a19daf43e347271b2e06147eae` on https://example.com/v1/hub/jobs/01a18973-93d3-7ef0-9eb4-38da457bf679",
  "",
  "```",
  "const wide = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';",
  "```",
  "",
  "| job | run | pin | status |",
  "| --- | --- | --- | --- |",
  "| job_4003e6a19daf43e347271b2e06147eae | 01a18973-93d3-7ef0-9eb4-38da457bf679 | b6d648f7 | running |",
].join("\n");

test("keeps long tokens, code blocks and tables inside the bubbles at 390px", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  const message = (role: string, order: number) => ({
    id: `overflow-${role}`,
    role,
    text: overflowText,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, order)).toISOString(),
    order,
  });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({
      json: { ...snapshot, messages: [message("user", 1), message("assistant", 2)] },
    });
  });
  await app.open("/");
  await expect(screen.getByText("Cancelled", { exact: false }).first()).toBeVisible();

  const report = await browser.evaluate(() => {
    const bubbles = Array.from(document.querySelectorAll<HTMLElement>("main .max-w-\\[85\\%\\]"));
    const page = document.documentElement.clientWidth;
    return bubbles.map((bubble) => {
      const box = bubble.getBoundingClientRect();
      let worst = 0;
      let culprit = "";
      for (const child of Array.from(bubble.querySelectorAll<HTMLElement>("*"))) {
        // Content inside a horizontal scroller may extend past it; the scroller itself may not.
        let clipped = false;
        for (let up = child.parentElement; up !== null && up !== bubble; up = up.parentElement) {
          if (getComputedStyle(up).overflowX === "auto") clipped = true;
        }
        if (clipped) continue;
        const rects = [child.getBoundingClientRect()];
        for (const node of Array.from(child.childNodes)) {
          if (node.nodeType !== Node.TEXT_NODE) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          rects.push(...Array.from(range.getClientRects()));
        }
        for (const rect of rects) {
          if (rect.width === 0) continue;
          const over = Math.max(rect.right - box.right, box.left - rect.left);
          if (over > worst) {
            worst = over;
            culprit = `${child.tagName}.${child.className} ${child.textContent?.slice(0, 40)}`;
          }
        }
      }
      const scrollers = Array.from(bubble.querySelectorAll<HTMLElement>("pre, table"))
        .map((node) => (node.tagName === "PRE" ? node : node.parentElement))
        .filter((node): node is HTMLElement => node !== null)
        .map((node) => ({
          overflowX: getComputedStyle(node).overflowX,
          scrolls: node.scrollWidth > node.clientWidth,
        }));
      return {
        right: box.right,
        page,
        bubbleScroll: bubble.scrollWidth - bubble.clientWidth,
        worst,
        culprit,
        scrollers,
      };
    });
  });

  expect(report.length).toBe(2);
  for (const bubble of report) {
    expect(bubble.right).toBeLessThanOrEqual(bubble.page);
    expect(bubble.bubbleScroll).toBeLessThanOrEqual(0);
    expect(bubble.worst).toBeLessThanOrEqual(0.5);
  }
  const assistant = report[1];
  expect(assistant.scrollers.length).toBe(2);
  for (const scroller of assistant.scrollers) {
    expect(scroller.overflowX).toBe("auto");
    expect(scroller.scrolls).toBe(true);
  }
});

test("shows hh:mm at the bottom right of user and assistant messages", async ({
  app,
  browser,
  screen,
}) => {
  const at = new Date(Date.UTC(2026, 0, 1, 7, 5, 0)).toISOString();
  const later = new Date(Date.UTC(2026, 0, 1, 18, 42, 0)).toISOString();
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({
      json: {
        ...snapshot,
        messages: [
          { id: "time-user", role: "user", text: "What time is it?", timestamp: at, order: 1 },
          { id: "time-bot", role: "assistant", text: "Late.", timestamp: later, order: 2 },
        ],
      },
    });
  });
  await app.open("/");
  await expect(screen.getByText("Late.", { exact: true })).toBeVisible();

  const times = await browser.evaluate(() => {
    const expected = (iso: string) => {
      const date = new Date(iso);
      return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    };
    return Array.from(document.querySelectorAll<HTMLTimeElement>("main time")).map((time) => {
      const bubble = time.closest<HTMLElement>(".max-w-\\[85\\%\\]");
      const box = bubble?.getBoundingClientRect();
      const own = time.getBoundingClientRect();
      return {
        text: time.textContent,
        expected: expected(time.dateTime),
        format: /^\d{2}:\d{2}$/.test(time.textContent ?? ""),
        rightGap: box === undefined ? -1 : box.right - own.right,
        bottomGap: box === undefined ? -1 : box.bottom - own.bottom,
      };
    });
  });
  expect(times.length).toBe(2);
  for (const time of times) {
    expect(time.format).toBe(true);
    expect(time.text).toBe(time.expected);
    expect(time.rightGap).toBeLessThan(16);
    expect(time.bottomGap).toBeLessThan(12);
  }
});

test("hides the code copy button until its block is hovered or focused", async ({
  app,
  browser,
  screen,
}) => {
  const code = "const answer = 42;\nconsole.log(answer);";
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: codeBlockSnapshot(code) });
  });
  await app.open("/");
  const button = screen.getByRole("button", "Copy code");
  await expect(button).toBeVisible();
  await expect.poll(async () => (await readCopyButton(browser))?.opacity ?? -1).toBe(0);
  const initial = await readCopyButton(browser);
  expect(initial).not.toBeNull();
  expect(initial?.height ?? 0).toBeGreaterThan(0);
  expect(initial?.scrollWidth ?? 0).toBeLessThanOrEqual(initial?.clientWidth ?? 0);

  await browser.locator("main pre").first().hover();
  await expect.poll(async () => (await readCopyButton(browser))?.opacity ?? -1).toBe(0.9);
  const hovered = await readCopyButton(browser);
  expect(hovered?.height).toBeCloseTo(initial?.height ?? 0, 1);

  await browser.mouse.move(0, 0);
  await expect.poll(async () => (await readCopyButton(browser))?.opacity ?? -1).toBe(0);

  let reached = false;
  for (let index = 0; index < 30; index += 1) {
    await browser.keyboard.press("Tab");
    const focused = await browser.evaluate(
      () => document.activeElement?.getAttribute("aria-label") ?? "",
    );
    if (focused === "Copy code") {
      reached = true;
      break;
    }
  }
  expect(reached).toBe(true);
  await expect.poll(async () => (await readCopyButton(browser))?.opacity ?? -1).toBe(1);
  expect((await readCopyButton(browser))?.height).toBeCloseTo(initial?.height ?? 0, 1);
});

test("copies a fenced code block from its copy button", async ({ app, browser, screen }) => {
  const code = "const answer = 42;\nconsole.log(answer);";
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: codeBlockSnapshot(code) });
  });
  await app.open("/");
  const button = screen.getByRole("button", "Copy code");
  await expect(button).toBeVisible();
  await button.hover();
  await expect.poll(async () => (await readCopyButton(browser))?.opacity ?? -1).toBe(0.9);

  await browser.evaluate(() => {
    const target = window as unknown as { copied?: string };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          target.copied = text;
        },
      },
    });
    return true;
  });
  const box = await button.boundingBox();
  if (box === null) throw new Error("copy button has no box");
  await browser.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await browser.mouse.down();
  await browser.mouse.up();
  await browser.mouse.move(0, 0);
  await expect.poll(async () => (await readCopyButton(browser))?.label ?? "").toBe("Copied");
  const copied = await browser.evaluate(
    () => (window as unknown as { copied?: string }).copied ?? null,
  );
  expect(copied).toBe(code);
  expect((await readCopyButton(browser))?.opacity).toBe(0.9);
  await new Promise((resolve) => setTimeout(resolve, 200));
  expect((await readCopyButton(browser))?.text).toBe("copied");
  await expect
    .poll(async () => (await readCopyButton(browser))?.opacity ?? -1, { timeout: 3_000 })
    .toBe(0);
  expect((await readCopyButton(browser))?.label).toBe("Copy code");
});

test("keeps the code copy button visible on a coarse pointer", async ({ app, browser, screen }) => {
  await browser.addInitScript(`
    (() => {
      const original = window.matchMedia.bind(window);
      window.matchMedia = (query) => {
        if (query !== "(hover: hover) and (pointer: fine)") return original(query);
        return {
          matches: false,
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
  const code = "const answer = 42;\nconsole.log(answer);";
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: codeBlockSnapshot(code) });
  });
  await app.open("/");
  const hoverCapable = await browser.evaluate(
    () => window.matchMedia("(hover: hover) and (pointer: fine)").matches,
  );
  expect(hoverCapable).toBe(false);
  const button = screen.getByRole("button", "Copy code");
  await expect(button).toBeVisible();
  await expect.poll(async () => (await readCopyButton(browser))?.opacity ?? -1).toBe(0.9);
});
