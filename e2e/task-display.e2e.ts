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
  await browser.route("**/api/state**", async (route) => {
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

test("renders inline markdown in task titles", async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({
      json: snapshotWith([
        {
          id: "t1",
          title: "Ship **bold** and _soft_ `npm run build` ~~old~~ see [docs](https://example.com)",
          status: "open",
          parentId: null,
          blockedBy: [],
          createdAt: at(0),
        },
        {
          id: "t2",
          title: "Waits on *the build*",
          status: "open",
          parentId: null,
          blockedBy: ["t1"],
          createdAt: at(1),
        },
      ]),
    });
  });
  await app.open("/?page=tasks");
  await expect(
    screen.getByRole("button", "Done Ship bold and soft npm run build old see docs"),
  ).toBeVisible();
  const rendered = await browser.evaluate(() => {
    const card = document.querySelector('[data-testid="task-t1"] [data-task-card]');
    const blocked = document.querySelector('[data-testid="task-t2"] [data-task-card]');
    if (card === null || blocked === null) return null;
    return {
      strong: card.querySelector("strong")?.textContent ?? null,
      em: card.querySelector("em")?.textContent ?? null,
      code: card.querySelector("code")?.textContent ?? null,
      del: card.querySelector("del")?.textContent ?? null,
      anchors: card.querySelectorAll("a").length,
      link: [...card.querySelectorAll("span")].some(
        (span) =>
          span.textContent === "docs" && getComputedStyle(span).textDecorationLine === "underline",
      ),
      raw: card.textContent?.includes("**") ?? true,
      blockedBy: blocked.textContent ?? "",
      emBlocked: blocked.querySelector("em")?.textContent ?? null,
      overflow: card.scrollWidth > card.clientWidth,
    };
  });
  expect(rendered).toEqual({
    strong: "bold",
    em: "soft",
    code: "npm run build",
    del: "old",
    anchors: 0,
    link: true,
    raw: false,
    blockedBy: expect.stringContaining("blocked ← Ship bold and soft npm run build old see docs"),
    emBlocked: "the build",
    overflow: false,
  });
});
