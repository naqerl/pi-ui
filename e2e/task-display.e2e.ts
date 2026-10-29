import { test } from "@e2e-dev/web";
import { expect } from "e2e";

type SeedTask = {
  id: string;
  title: string;
  status: string;
  parentId: string | null;
  blockedBy: string[];
  createdAt: string;
};

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second)).toISOString();

function snapshotWith(tasks: SeedTask[]) {
  return {
    conversationId: "task-display-e2e",
    messages: [],
    activity: [],
    run: "idle",
    queue: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    context: { tokens: 0, window: null, percent: null },
    // A revision far ahead of the live server so its stream does not replace this ledger.
    tasks: { tasks, revision: 1_000_000 },
  };
}

test("shows the empty task list in the latest-indicator style", async ({
  app,
  browser,
  screen,
}) => {
  await browser.route("**/api/state", async (route) => {
    await route.fulfill({ json: snapshotWith([]) });
  });
  await app.open("/?page=tasks");
  const empty = screen.getByText("No tasks yet.", { exact: true });
  await expect(empty).toBeVisible();
  const paint = await browser.evaluate(() => {
    const label = [...document.querySelectorAll("span")].find(
      (item) => item.textContent === "No tasks yet.",
    );
    if (!(label instanceof HTMLElement)) return null;
    const style = getComputedStyle(label);
    const root = getComputedStyle(document.documentElement);
    const probe = document.createElement("span");
    probe.style.color = root.getPropertyValue("--foreground");
    probe.style.backgroundColor = root.getPropertyValue("--background");
    document.body.append(probe);
    const theme = getComputedStyle(probe);
    const result = {
      background: style.backgroundColor,
      color: style.color,
      foreground: theme.color,
      pageBackground: theme.backgroundColor,
      font: style.fontFamily,
      size: style.fontSize,
    };
    probe.remove();
    return result;
  });
  expect(paint).not.toBeNull();
  expect(paint?.background).toBe(paint?.foreground);
  expect(paint?.color).toBe(paint?.pageBackground);
  expect(paint?.size).toBe("11px");
  expect(paint?.font).toContain("mono");
});
