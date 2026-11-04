import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

import { removeTasks } from "./tasks-helpers.js";

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

async function blur(browser: Browser) {
  await browser.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    return true;
  });
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
  // The done list keys groups by calendar day and only opens today's group, so
  // anchor the close inside today instead of letting "two hours ago" fall into
  // a collapsed yesterday group around midnight.
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 1, 0, 0);
  const closedToday = new Date(Math.min(startOfToday.getTime(), now)).toISOString();
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
          completedAt: closedToday,
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

test("edits a task title in place, grows to two lines, and refuses an empty one", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 800 });
  let patches = 0;
  await browser.route("**/api/tasks/**", async (route) => {
    if (route.request.method === "PATCH") patches += 1;
    await route.continue();
  });
  await app.open("/?page=tasks");
  const id = await browser.evaluate(async () => {
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Draft title", parentId: null }),
    });
    const ledger = (await response.json()) as { tasks: Array<{ id: string; title: string }> };
    return ledger.tasks.find((task) => task.title === "Draft title")?.id ?? "";
  });
  await app.open("/?page=tasks");
  await screen.getByRole("button", { name: "Open Draft title" }).click();
  const detail = screen.getByTestId("task-detail");
  await expect(screen.getByTestId("task-title-edit")).toHaveCount(0);
  await expect(screen.getByTestId("task-body-edit")).toHaveCount(0);
  await expect(detail.getByRole("button", { name: /Edit title/ })).toHaveCount(0);

  await detail.getByText("Draft title", { exact: true }).click();
  const title = screen.getByRole("textbox", "Task title");
  const single = await title.boundingBox();
  await title.fill("Long first line\nCorrected title");
  const grown = await title.boundingBox();
  expect(grown?.height ?? 0).toBeGreaterThan((single?.height ?? 0) + 10);
  const sizing = await browser.evaluate(() => {
    const field = document.querySelector<HTMLTextAreaElement>('[data-testid="task-title-input"]');
    if (field === null) return null;
    return {
      rows: field.rows,
      value: field.value,
      scrolls: field.scrollHeight > field.clientHeight + 1,
    };
  });
  expect(sizing).toEqual({ rows: 2, value: "Long first line\nCorrected title", scrolls: false });

  await blur(browser);
  await expect
    .poll(() =>
      browser.evaluate(async (taskId) => {
        const ledger = (await (await fetch("/api/tasks")).json()) as {
          tasks: Array<{ id: string; title: string }>;
        };
        return ledger.tasks.find((task) => task.id === taskId)?.title ?? null;
      }, id),
    )
    .toBe("Long first line\nCorrected title");

  await browser.reload();
  await screen.getByRole("button", { name: /Open Long first line\s+Corrected title/ }).click();
  expect(
    await browser.evaluate(
      () => document.querySelector('[data-testid="task-title"]')?.textContent ?? null,
    ),
  ).toBe("Long first line\nCorrected title");

  await screen.getByTestId("task-title").click();
  const escaped = screen.getByRole("textbox", "Task title");
  await escaped.fill("Should not save");
  const beforeEscape = patches;
  await escaped.press("Escape");
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(patches).toBe(beforeEscape);
  expect(
    await browser.evaluate(
      () => document.querySelector('[data-testid="task-title"]')?.textContent ?? null,
    ),
  ).toBe("Long first line\nCorrected title");

  await screen.getByTestId("task-title").click();
  const again = screen.getByRole("textbox", "Task title");
  await again.fill("   ");
  await blur(browser);
  await expect(screen.getByText("Title must not be empty")).toBeVisible();
  await expect
    .poll(() =>
      browser.evaluate(async (taskId) => {
        const ledger = (await (await fetch("/api/tasks")).json()) as {
          tasks: Array<{ id: string; title: string }>;
        };
        return ledger.tasks.find((task) => task.id === taskId)?.title ?? null;
      }, id),
    )
    .toBe("Long first line\nCorrected title");

  await removeTasks(browser, ["Long first line\nCorrected title"]);
});

test("sets, edits and clears a task body in place that renders as markdown", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 800 });
  let patches = 0;
  await browser.route("**/api/tasks/**", async (route) => {
    if (route.request.method === "PATCH") patches += 1;
    await route.continue();
  });
  await app.open("/?page=tasks");
  const rationale = "The rationale belongs to the proposer and must survive a body edit.";
  const id = await browser.evaluate(async (why) => {
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Body draft", rationale: why, propose: true }),
    });
    const ledger = (await response.json()) as { tasks: Array<{ id: string; title: string }> };
    const task = ledger.tasks.find((item) => item.title === "Body draft");
    if (task === undefined) return "";
    await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "open" }),
    });
    return task.id;
  }, rationale);
  await app.open("/?page=tasks");
  await screen.getByRole("button", { name: "Open Body draft" }).click();
  await expect(screen.getByTestId("task-body-edit")).toHaveCount(0);
  await expect(screen.getByRole("button", { name: "Add body" })).toHaveCount(0);
  await expect(screen.getByRole("button", { name: "Edit body" })).toHaveCount(0);

  await screen.getByTestId("task-body-section").click();
  const body = screen.getByRole("textbox", "Task body");
  await body.fill("# Route plan\n\nUse **tram 4**.\n\nKeep this line.\nAnd this one.");
  const sizing = await browser.evaluate(() => {
    const field = document.querySelector<HTMLTextAreaElement>('[data-testid="task-body-input"]');
    if (field === null) return null;
    return { scrolls: field.scrollHeight > field.clientHeight + 1 };
  });
  expect(sizing).toEqual({ scrolls: false });
  await blur(browser);
  await expect(
    screen.getByTestId("task-body").getByRole("heading", { name: "Route plan" }),
  ).toBeVisible();
  await expect(screen.getByTestId("task-body").getByText("tram 4")).toBeVisible();
  await expect(screen.getByText(rationale)).toBeVisible();

  await app.open("/?page=tasks");
  await screen.getByRole("button", { name: "Open Body draft" }).click();
  await expect(
    screen.getByTestId("task-body").getByRole("heading", { name: "Route plan" }),
  ).toBeVisible();
  await screen.getByTestId("task-body").click();
  const edited = screen.getByRole("textbox", "Task body");
  await edited.fill(
    "# Route plan\n\nUse **tram 4**.\n\nKeep this line.\nAnd this one.\n\nAdded **paragraph**.",
  );
  await blur(browser);
  await expect(
    screen.getByTestId("task-body").getByRole("heading", { name: "Route plan" }),
  ).toBeVisible();
  await expect(
    screen.getByTestId("task-body").getByText("paragraph", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByText(rationale)).toBeVisible();

  await screen.getByTestId("task-body").click();
  const escaped = screen.getByRole("textbox", "Task body");
  await escaped.fill("# Not saved");
  const beforeEscape = patches;
  await escaped.press("Escape");
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(patches).toBe(beforeEscape);
  await expect(
    screen.getByTestId("task-body").getByText("paragraph", { exact: true }),
  ).toBeVisible();
  await expect(screen.getByTestId("task-body").getByText("Not saved")).toHaveCount(0);

  await screen.getByTestId("task-body").click();
  const cleared = screen.getByRole("textbox", "Task body");
  await cleared.fill("");
  await screen.getByTestId("task-project-input").click();
  await expect(screen.getByTestId("task-body")).toHaveCount(0);
  await expect
    .poll(() =>
      browser.evaluate(async (taskId) => {
        const ledger = (await (await fetch("/api/tasks")).json()) as {
          tasks: Array<{ id: string; body?: string; rationale?: string }>;
        };
        const task = ledger.tasks.find((item) => item.id === taskId);
        return { body: task?.body ?? null, rationale: task?.rationale ?? null };
      }, id),
    )
    .toEqual({ body: null, rationale });

  await app.open("/?page=tasks");
  await screen.getByRole("button", { name: "Open Body draft" }).click();
  await expect(screen.getByTestId("task-body")).toHaveCount(0);
  await expect(screen.getByText("Write markdown…")).toBeVisible();
  await expect(screen.getByText(rationale)).toBeVisible();

  await removeTasks(browser, ["Body draft"]);
});

test("shows a failed task action beside the control and keeps a long title", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/?page=tasks");
  const composer = screen.getByRole("textbox", "New task");
  await composer.fill("Write the notice");
  await screen.getByRole("button", "Add task").tap();
  const failNextPatch = (message: string) =>
    browser.evaluate((text) => {
      const original = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const method = (
          init?.method ?? (input instanceof Request ? input.method : "GET")
        ).toUpperCase();
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (method === "PATCH" && url.includes("/api/tasks/")) {
          window.fetch = original;
          return Promise.resolve(new Response(text, { status: 409 }));
        }
        return original(input, init);
      };
      return null;
    }, message);

  await failNextPatch("Open subtasks");
  await screen.getByRole("button", { name: "Open Write the notice" }).tap();
  await screen.getByTestId("task-detail-status").tap();
  await expect(screen.getByTestId("task-detail").getByTestId("task-error")).toHaveText(
    "Open subtasks",
  );
  await expect(screen.getByTestId("task-detail-status")).toHaveText("Mark done");
  const cardError = await browser.evaluate(() => {
    const error = document.querySelector("[data-testid=task-error]");
    const card = [...document.querySelectorAll("[data-task-card]")].find((item) =>
      item
        .getAttribute("aria-describedby")
        ?.split(" ")
        .includes(error?.id ?? ""),
    );
    if (!(error instanceof HTMLElement) || !(card instanceof HTMLElement)) return null;
    const errorBox = error.getBoundingClientRect();
    const cardBox = card.getBoundingClientRect();
    return error.parentElement === card.parentElement && errorBox.top >= cardBox.bottom - 1;
  });
  expect(cardError).toBe(true);

  await screen.getByTestId("task-detail-status").tap();
  await expect(screen.getByTestId("task-state")).toHaveText("Done");
  await expect(screen.getByTestId("task-error")).toHaveCount(0);

  const longTitle = "M".repeat(450);
  await screen.getByRole("textbox", "New task").fill(longTitle);
  await screen.getByRole("button", "Add task").tap();
  await expect(screen.getByText(longTitle, { exact: true })).toBeVisible();
  await expect(screen.getByTestId("composer-error")).toHaveCount(0);
});
