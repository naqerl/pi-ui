import { test } from "@e2e-dev/web";
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

test("does not let whitespace-only lines inflate assistant markdown bubbles", async ({
  app,
  browser,
  screen,
}) => {
  await browser.route("**/api/state", async (route) => {
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
  'Cancelled `hub_force_stop {job:"hj_57af322b37f14e7cda5e09d6f0d1eb4f"}` and reran it.',
  "",
  "See https://example.com/a/very/long/path/that/keeps/going/without/any/spaces/at/all/9f8e7d6c5b4a3f2e1d0c",
  "",
  "Supercalifragilisticexpialidociousandthensomemorelettersthatnevertakeabreath.",
  "",
  "1. New daemon confirmed (`pid 1771245`).",
  '2. `hub_force_stop {job:"hj_57af322b37f14e7cda5e09d6f0d1eb4f"}` — the call hung.',
  "3. Rerun `hj_4003e6a19daf43e347271b2e06147eae` on https://example.com/v1/hub/jobs/01a18973-93d3-7ef0-9eb4-38da457bf679",
  "",
  "```",
  "const wide = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';",
  "```",
  "",
  "| job | run | pin | status |",
  "| --- | --- | --- | --- |",
  "| hj_4003e6a19daf43e347271b2e06147eae | 01a18973-93d3-7ef0-9eb4-38da457bf679 | b6d648f7 | running |",
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
  await browser.route("**/api/state", async (route) => {
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
  await browser.route("**/api/state", async (route) => {
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
