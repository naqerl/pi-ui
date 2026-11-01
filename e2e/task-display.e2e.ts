import { test } from "@e2e-dev/web";
import { expect } from "e2e";

type SeedTask = {
  id: string;
  title: string;
  status: string;
  parentId: string | null;
  blockedBy: string[];
  createdAt: string;
  completedAt?: string | null;
  completion?: { evidence: string } | null;
  lastWorkedAt?: string | null;
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

test("shows the empty task list as plain muted text", async ({ app, browser, screen }) => {
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: snapshotWith([]) });
  });
  await app.open("/?page=tasks");
  const empty = screen.getByText("No tasks yet.", { exact: true });
  await expect(empty).toBeVisible();
  const paint = await browser.evaluate(() => {
    const label = [...document.querySelectorAll("p")].find(
      (item) => item.textContent === "No tasks yet.",
    );
    if (!(label instanceof HTMLElement)) return null;
    const style = getComputedStyle(label);
    const root = getComputedStyle(document.documentElement);
    const probe = document.createElement("span");
    probe.style.color = root.getPropertyValue("--muted-foreground");
    document.body.append(probe);
    const theme = getComputedStyle(probe);
    const result = {
      color: style.color,
      muted: theme.color,
      font: style.fontFamily,
      transform: style.textTransform,
    };
    probe.remove();
    return result;
  });
  expect(paint).not.toBeNull();
  expect(paint?.color).toBe(paint?.muted);
  expect(paint?.transform).toBe("none");
  expect(paint?.font).not.toContain("mono");
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
    screen.getByRole("button", "Open Ship bold and soft npm run build old see docs"),
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
    blockedBy: expect.stringContaining("Blocked by Ship bold and soft npm run build old see docs"),
    emBlocked: "the build",
    overflow: false,
  });
});

test("a working task untouched for an hour is stale, while blockers and done still win", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  const now = Date.now();
  const ago = (ms: number) => new Date(now - ms).toISOString();
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({
      json: snapshotWith([
        {
          id: "fresh",
          title: "Fresh work",
          status: "open",
          parentId: null,
          blockedBy: [],
          createdAt: ago(3 * 60 * 60_000),
          lastWorkedAt: ago(60_000),
        },
        {
          id: "stale",
          title: "Abandoned work",
          status: "open",
          parentId: null,
          blockedBy: [],
          createdAt: ago(3 * 60 * 60_000),
          lastWorkedAt: ago(2 * 60 * 60_000),
        },
        {
          id: "gated",
          title: "Gated work",
          status: "open",
          parentId: null,
          blockedBy: ["fresh"],
          createdAt: ago(3 * 60 * 60_000),
          lastWorkedAt: ago(2 * 60 * 60_000),
        },
        {
          id: "closed",
          title: "Closed work",
          status: "done",
          parentId: null,
          blockedBy: [],
          createdAt: ago(3 * 60 * 60_000),
          completedAt: ago(2 * 60 * 60_000),
          completion: { evidence: "e2e/task-display.e2e.ts" },
          lastWorkedAt: ago(2 * 60 * 60_000),
        },
      ]),
    });
  });
  await app.open("/?page=tasks");

  await expect(screen.getByTestId("task-fresh")).toHaveAttribute("data-state", "working");
  await expect(screen.getByTestId("task-stale-fresh")).toHaveCount(0);
  await expect(screen.getByTestId("task-stale")).toHaveAttribute("data-state", "working");
  await expect(screen.getByTestId("task-stale-stale")).toBeVisible();
  await expect(screen.getByTestId("task-stale-stale")).toHaveText("stale");
  // A live blocker and a closed task are ledger facts, not stale work.
  await expect(screen.getByTestId("task-gated")).toHaveAttribute("data-state", "blocked");
  await expect(screen.getByTestId("task-stale-gated")).toHaveCount(0);
  await expect(screen.getByTestId("task-closed")).toHaveAttribute("data-state", "done");
  await expect(screen.getByTestId("task-stale-closed")).toHaveCount(0);

  const marker = await browser.evaluate(() => {
    const stale = document.querySelector('[data-testid="task-stale-stale"]');
    const card = document.querySelector('[data-testid="task-stale"] [data-task-card]');
    if (!(stale instanceof HTMLElement) || !(card instanceof HTMLElement)) return null;
    const probe = document.createElement("span");
    probe.className = "text-muted-foreground";
    document.body.append(probe);
    const result = {
      text: stale.textContent,
      color: getComputedStyle(stale).color,
      muted: getComputedStyle(probe).color,
      afterWorking: stale.previousElementSibling?.textContent === "Working",
      card: getComputedStyle(card).backgroundColor,
    };
    probe.remove();
    return result;
  });
  expect(marker?.text).toBe("stale");
  expect(marker?.color).toBe(marker?.muted);
  expect(marker?.afterWorking).toBe(true);
  expect(marker?.card).not.toBe("rgba(0, 0, 0, 0)");
});
