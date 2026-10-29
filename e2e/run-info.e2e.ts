import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second)).toISOString();

const tools = Array.from({ length: 9 }, (_, index) => ({
  kind: "tool",
  id: `tool-${index}`,
  name: "bash",
  arguments: JSON.stringify({ command: `echo ${index}` }),
  output: String(index),
  isError: false,
  durationMs: 1200,
  timestamp: at(2 + index * 2),
  order: 20 + index * 2,
  ...(index === 0 ? { usage: { input: 7100, output: 4700 } } : {}),
}));
const thinking = Array.from({ length: 7 }, (_, index) => ({
  kind: "thinking",
  id: `thinking-${index}`,
  name: "thinking",
  text: "Considering the next step.",
  timestamp: at(3 + index * 2),
  order: 21 + index * 2,
}));

const snapshot = {
  conversationId: "run-info-e2e",
  messages: [
    { id: "ask", role: "user", text: "Restart the hub job", timestamp: at(0), order: 1 },
    { id: "answer", role: "assistant", text: "Done.", timestamp: at(40), order: 100 },
  ],
  activity: [...tools, ...thinking],
  run: "idle",
  queue: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
  context: { tokens: 0, window: null, percent: null },
};

test("puts the run info on a card that is not the page background", async ({ app, browser }) => {
  await browser.route("**/api/state", async (route) => {
    await route.fulfill({ json: snapshot });
  });
  await app.open("/");
  const info = browser.locator('[data-testid="run-info"]');
  await expect(info).toBeVisible();
  const paint = await browser.evaluate(() => {
    const element = document.querySelector<HTMLElement>('[data-testid="run-info"]');
    if (element === null) return null;
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      page: getComputedStyle(document.body).backgroundColor,
      border: style.borderTopWidth,
    };
  });
  expect(paint).not.toBeNull();
  expect(paint?.background).not.toBe("rgba(0, 0, 0, 0)");
  expect(paint?.background).not.toBe("transparent");
  expect(paint?.background).not.toBe(paint?.page);
  expect(paint?.border).toBe("1px");
});
