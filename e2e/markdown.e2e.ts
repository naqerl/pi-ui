import { type Browser, beforeEach, describe, test } from "@e2e-dev/web";
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
      transitionProperty: getComputedStyle(button).transitionProperty,
      height: box.height,
      scrollWidth: pre.scrollWidth,
      clientWidth: pre.clientWidth,
      label: button.getAttribute("aria-label"),
      text: button.textContent,
    };
  });
}
describe("markdown interaction against one shared app", { serial: true }, () => {
  beforeEach(async ({ browser }) => {
    await browser.unrouteAll();
  });

  test("copies a fenced code block from its copy button", async ({ app, browser, screen }) => {
    const code = "const answer = 42;\nconsole.log(answer);";
    await browser.route("**/api/state**", async (route) => {
      await route.fulfill({ json: codeBlockSnapshot(code) });
    });
    await app.open("/");
    await expect(browser.locator("main pre")).toHaveCount(1, { timeout: 15_000 });
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
    // The copied state resets after 1.5s, so read the label and text together.
    await expect
      .poll(async () => {
        const button = await readCopyButton(browser);
        return { label: button?.label ?? "", text: button?.text ?? "" };
      })
      .toEqual({ label: "Copied", text: "copied" });
    const copied = await browser.evaluate(
      () => (window as unknown as { copied?: string }).copied ?? null,
    );
    expect(copied).toBe(code);
    expect((await readCopyButton(browser))?.opacity).toBe(0.9);
    await expect
      .poll(async () => (await readCopyButton(browser))?.opacity ?? -1, { timeout: 3_000 })
      .toBe(0);
    expect((await readCopyButton(browser))?.label).toBe("Copy code");
  });
  const taskChipSnapshot = {
    ...snapshot,
    conversationId: "task-chip-e2e",
    messages: [
      {
        id: "task-chip-message",
        role: "assistant",
        text: [
          "Open `abc1` now.",
          "",
          "Plain `bash`, `POST`, `1.2.3` and `zzzz` stay code.",
          "",
          "```",
          "abc1",
          "```",
        ].join("\n"),
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString(),
        order: 1,
      },
    ],
    tasks: {
      revision: 1_000_000,
      tasks: [
        {
          id: "abc1",
          title: "Ship the chip",
          status: "open",
          parentId: null,
          blockedBy: [],
          createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString(),
          body: "First line of the body.\n\nLast line of the body.",
          project: "pi-ui",
          completedAt: null,
          completion: null,
        },
      ],
    },
  };

  async function openTaskChip(browser: Browser) {
    await browser.setViewport({ width: 1280, height: 800 });
    await browser.route("**/api/state**", async (route) => {
      await route.fulfill({ json: JSON.parse(JSON.stringify(taskChipSnapshot)) });
    });
  }

  test("previews a task id on hover and opens that task on click", async ({
    app,
    browser,
    screen,
  }) => {
    await openTaskChip(browser);
    await app.open("/");
    const chip = screen.getByTestId("task-chip-abc1");
    await expect(chip).toBeVisible({ timeout: 15_000 });
    await expect(browser.locator("main [data-task-chip]")).toHaveCount(1);

    await chip.hover();
    const preview = screen.getByTestId("task-chip-preview");
    await expect(preview).toBeVisible({ timeout: 2_000 });
    await expect(preview.getByText("Ship the chip", { exact: true })).toBeVisible();
    await expect(preview).toContainText("OPEN");
    await expect(preview).toContainText("pi-ui");
    await expect(preview).toContainText("Last line of the body.");

    await chip.click();
    await expect(browser.locator('[data-testid="pager"]')).toHaveAttribute("data-page", "tasks");
    const detail = screen.getByTestId("task-detail");
    await expect(detail).toHaveAttribute("aria-label", "Ship the chip");
    await expect(screen.getByTestId("task-details-bar")).toContainText("Task details");
    await expect(screen.getByTestId("task-id-abc1")).toHaveText("abc1");
  });
});
