import { beforeEach, describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

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
const longRunSnapshot = {
  conversationId: "activity-chip-paint-e2e",
  messages: [
    { id: "ask", role: "user", text: "Run the long job", timestamp: activityAt(0), order: 1 },
    {
      id: "answer",
      role: "assistant",
      text: Array.from(
        { length: 60 },
        (_, index) => `Filler line ${index + 1} keeps the transcript scrollable.`,
      ).join("\n"),
      timestamp: activityAt(600),
      order: 1000,
    },
  ],
  activity: Array.from({ length: 55 }, (_, index) => ({
    kind: "tool" as const,
    id: `tool-${index}`,
    name: "bash",
    arguments: JSON.stringify({ command: `echo step ${index}` }),
    output: `step ${index}`,
    isError: false,
    durationMs: index === 0 ? 1_234_567_000 : 0,
    timestamp: activityAt(0),
    order: 20 + index,
    usage: {
      input: index === 0 ? 12_345_678 : 0,
      output: index === 0 ? 9_876_543 : 0,
    },
  })),
  run: "idle",
  queue: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
  context: { tokens: 0, window: null, percent: null },
};
describe("activity surface against one shared app", { serial: true }, () => {
  beforeEach(async ({ browser }) => {
    await browser.unrouteAll();
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
    await expect(screen.getByText("bash · ok", { exact: true })).toBeVisible();
    expect(
      await browser.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('[data-testid="activity-duration"]')].map(
          (row) => row.textContent,
        ),
      ),
    ).toEqual(["1.2s", "1.0s"]);

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
    await expect(screen.getByText("bash · ok", { exact: true })).toBeVisible();
    expect(
      await browser.evaluate(
        () => document.querySelector('[data-testid="composer-dock"]') !== null,
      ),
    ).toBe(true);

    await app.open("/activity?run=missing");
    await expect(screen.getByTestId("activity-dialog")).toBeVisible();
    await expect(screen.getByText("No activity in this run.", { exact: true })).toBeVisible();

    await app.open("/events");
    await expect(
      screen.getByRole("heading", { name: "MCP subscriptions", level: 1 }),
    ).toBeVisible();
    await expect(screen.getByTestId("activity-dialog")).toHaveCount(0);
  });

  test("the transcript activity chip is one box that contains every summary line", async ({
    app,
    browser,
    screen,
  }) => {
    await browser.route("**/api/state**", async (route) => {
      await route.fulfill({ json: JSON.parse(JSON.stringify(longRunSnapshot)) });
    });
    const measure = () =>
      browser.evaluate(() => {
        const button = document.querySelector<HTMLElement>('[data-testid="run-info"]');
        const summary = document.querySelector<HTMLElement>('[data-testid="run-info-summary"]');
        if (button === null || summary === null) return null;
        const box = button.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(summary);
        const lines = [...range.getClientRects()].filter(
          (rect) => rect.width > 0 && rect.height > 0,
        );
        if (lines.length === 0) return null;
        const ink = {
          top: Math.min(...lines.map((rect) => rect.top)),
          right: Math.max(...lines.map((rect) => rect.right)),
          bottom: Math.max(...lines.map((rect) => rect.bottom)),
          left: Math.min(...lines.map((rect) => rect.left)),
        };
        const group = button.closest<HTMLElement>('[data-testid="activity-group"]');
        return {
          button: { top: box.top, right: box.right, bottom: box.bottom, left: box.left },
          ink,
          lines: new Set(lines.map((rect) => Math.round(rect.top * 2) / 2)).size,
          overflows:
            button.scrollWidth > button.clientWidth + 1 ||
            summary.scrollWidth > summary.clientWidth + 1,
          summaryDisplay: getComputedStyle(summary).display,
          isolation: getComputedStyle(group ?? button).isolation,
          insideGroup: group !== null,
        };
      });
    const expectContained = async () => {
      const geometry = await measure();
      expect(geometry).not.toBeNull();
      expect(geometry?.button.top).toBeLessThanOrEqual((geometry?.ink.top ?? 0) + 0.5);
      expect(geometry?.button.right).toBeGreaterThanOrEqual((geometry?.ink.right ?? 0) - 0.5);
      expect(geometry?.button.bottom).toBeGreaterThanOrEqual((geometry?.ink.bottom ?? 0) - 0.5);
      expect(geometry?.button.left).toBeLessThanOrEqual((geometry?.ink.left ?? 0) + 0.5);
      expect(geometry?.lines).toBeGreaterThanOrEqual(2);
      expect(geometry?.overflows).toBe(false);
      expect(geometry?.summaryDisplay).not.toBe("flex");
      expect(geometry?.insideGroup).toBe(true);
      expect(geometry?.isolation).toBe("isolate");
    };

    for (const scheme of ["light", "dark"] as const) {
      await browser.emulateMedia({ colorScheme: scheme });
      await app.open("/");
      for (const width of [320, 390]) {
        await browser.setViewport({ width, height: 844 });
        await browser.evaluate(() => {
          document
            .querySelector<HTMLElement>('[data-testid="run-info"]')
            ?.scrollIntoView({ block: "center" });
          return null;
        });
        await expect(screen.getByTestId("run-info")).toBeVisible();
        await expectContained();
      }
      await browser.evaluate(async () => {
        const scroller = document.querySelector<HTMLElement>('[data-testid="chat-scroller"]');
        const chip = document.querySelector<HTMLElement>('[data-testid="run-info"]');
        if (scroller === null || chip === null) return false;
        const offset =
          chip.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop;
        scroller.scrollTop = Math.max(0, offset - 120);
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );
        return true;
      });
      await expectContained();
      await app.screenshot(`activity-chip-390-${scheme}-after`);
    }
  });

  test("an expanded /activity row is a four-sided panel with a gap to the next row", async ({
    app,
    browser,
    screen,
  }) => {
    await browser.route("**/api/state**", async (route) => {
      await route.fulfill({ json: JSON.parse(JSON.stringify(activitySnapshot)) });
    });
    await app.open("/activity?run=activity-message-ask-0");
    await expect(screen.getByTestId("activity-dialog")).toBeVisible();
    await screen.getByTestId("activity-row").nth(0).tap();
    const panel = screen.getByTestId("activity-panel");
    await expect(panel).toBeVisible();

    const geometry = await browser.evaluate(() => {
      const node = document.querySelector<HTMLElement>('[data-testid="activity-panel"]');
      const rows = document.querySelectorAll<HTMLElement>('[data-testid="activity-row"]');
      if (node === null) return null;
      const style = getComputedStyle(node);
      const box = node.getBoundingClientRect();
      const nextRow = rows[1]?.getBoundingClientRect();
      const content = [...node.children].map((child) => child.getBoundingClientRect());
      return {
        borders: [
          style.borderTopWidth,
          style.borderRightWidth,
          style.borderBottomWidth,
          style.borderLeftWidth,
        ],
        paddingLeft: style.paddingLeft,
        paddingRight: style.paddingRight,
        background: style.backgroundColor,
        gapBelow: nextRow === undefined ? null : nextRow.top - box.bottom,
        contentCovered: content.every((rect) => rect.top >= box.top && rect.bottom <= box.bottom),
        notClipped:
          node.scrollHeight <= node.clientHeight + 1 && node.scrollWidth <= node.clientWidth + 1,
      };
    });
    expect(geometry).not.toBeNull();
    expect(geometry?.borders.map((width) => Number.parseFloat(width) > 0)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(geometry?.paddingLeft).toBe(geometry?.paddingRight);
    expect(geometry?.paddingLeft).not.toBe("0px");
    expect(geometry?.background).not.toBe("rgba(0, 0, 0, 0)");
    expect(geometry?.gapBelow ?? 0).toBeGreaterThan(0);
    expect(geometry?.contentCovered).toBe(true);
    expect(geometry?.notClipped).toBe(true);
    await app.screenshot("activity-expanded-after");
  });
});
