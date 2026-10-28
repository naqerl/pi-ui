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
    '<div class="space-y-2"><p class="whitespace-pre-wrap break-words">Just one paragraph.</p></div>',
  );
  expect(boxes[6]?.paragraphs).toBe(2);
  expect(boxes[6]?.html).toBe(
    '<div class="space-y-2"><p class="whitespace-pre-wrap break-words">First paragraph.</p><p class="whitespace-pre-wrap break-words">Second paragraph.</p></div>',
  );
});
