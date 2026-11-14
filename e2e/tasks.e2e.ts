import { type Browser, beforeEach, describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { IdleNudge } from "../src/server/idle-nudge.js";
import { backToTaskList, setPlanDraft } from "./tasks-helpers";

/** The built app registers /sw.js, and a worker's requests bypass Playwright routes. */
async function disableServiceWorker(browser: Browser) {
  await browser.addInitScript(() => {
    if (!("serviceWorker" in navigator)) return;
    Object.defineProperty(navigator.serviceWorker, "register", {
      configurable: true,
      value: async () => undefined,
    });
  });
}

beforeEach(async ({ browser }) => {
  await disableServiceWorker(browser);
});
describe("trimmed task ledger against one shared app", { serial: true }, () => {
  beforeEach(async ({ browser }) => {
    await browser.unrouteAll();
  });

  test("paints a task card before the create response and reconciles it to the ledger id", async ({
    app,
    browser,
    screen,
  }) => {
    await app.open("/?page=tasks");
    const list = screen.getByTestId("task-list");
    await expect(list).toBeVisible();
    await expect(screen.getByRole("textbox", "New task")).toBeVisible();
    await setPlanDraft(screen, false);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requests = 0;
    await browser.route("**/api/tasks", async (route) => {
      if (route.request.method !== "POST") {
        await route.continue();
        return;
      }
      requests += 1;
      // Hold the request open: the card below must be painted before the response exists.
      await gate;
      await route.continue();
    });

    const composer = screen.getByRole("textbox", "New task");
    const title = `Painted task ${Date.now()}`;
    await composer.fill(title);
    try {
      await screen.getByRole("button", "Add task").tap();
      await expect(list.getByText(title, { exact: true })).toBeVisible({ timeout: 1_500 });
      // The card is painted first; the POST that carries it may be dispatched a tick
      // later, so poll for it instead of reading the counter once.
      await expect.poll(() => requests, { timeout: 1_500 }).toBe(1);
      // Still no response, so the visible card is the optimistic one.
      await expect(
        browser.locator('[data-pending-task="true"]').filter({ hasText: title }),
      ).toBeVisible();
    } finally {
      release();
    }

    await expect(composer).toHaveValue("");
    const final = await browser.evaluate(async (needle) => {
      const deadline = performance.now() + 10_000;
      while (performance.now() < deadline) {
        const ledger = (await (await fetch("/api/tasks")).json()) as {
          tasks: Array<{ id: string; title: string }>;
        };
        const task = ledger.tasks.find((item) => item.title === needle);
        const card = [...document.querySelectorAll("[data-task-card]")].find((item) =>
          item.textContent?.includes(needle),
        );
        const id = card?.closest("li")?.getAttribute("data-testid") ?? null;
        if (task !== undefined && id === `task-${task.id}`) return id;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return null;
    }, title);
    expect(final).toMatch(/^task-[a-z0-9]+$/);
    await expect(browser.locator('[data-pending-task="true"]')).toHaveCount(0);
  });

  test("keeps a failed create as a visible row with Retry and keeps the draft", async ({
    app,
    browser,
    screen,
  }) => {
    await app.open("/?page=tasks");
    await expect(screen.getByRole("textbox", "New task")).toBeVisible();
    await setPlanDraft(screen, false);
    let attempts = 0;
    await browser.route("**/api/tasks", async (route) => {
      if (route.request.method !== "POST") {
        await route.continue();
        return;
      }
      attempts += 1;
      if (attempts === 1) {
        await route.fulfill({ status: 500, body: "Task list is full" });
        return;
      }
      await route.continue();
    });
    const composer = screen.getByRole("textbox", "New task");
    const title = `Rejected task ${Date.now()}`;
    await composer.fill(title);
    await screen.getByRole("button", "Add task").tap();

    await expect(screen.getByTestId("composer-error")).toHaveText("Task list is full");
    await expect(composer).toHaveValue(title);
    const failed = browser.locator('[data-create-failed="true"]').filter({ hasText: title });
    await expect(failed).toBeVisible();
    await expect(failed.getByTestId("task-error")).toHaveText("Task list is full");
    const retry = failed.getByRole("button", { name: `Retry ${title}` });
    await expect(retry).toBeVisible();
    // A pending id has no detail endpoint; tapping the failed card must not open one.
    await failed.getByRole("button", { name: `Open ${title}` }).tap();
    await expect(screen.getByTestId("task-detail")).toHaveCount(0);
    await expect(composer).toBeVisible();

    await retry.tap();
    await expect(browser.locator('[data-create-failed="true"]')).toHaveCount(0);
    await expect(browser.locator('[data-pending-task="true"]')).toHaveCount(0);
    await expect(screen.getByTestId("composer-error")).toHaveCount(0);
    // The successful retry consumes the draft it restored, so Add cannot duplicate it.
    await backToTaskList(screen);
    await expect(screen.getByRole("textbox", "New task")).toHaveValue("");
    expect(attempts).toBe(2);
    expect(
      await browser.evaluate(async (needle) => {
        const ledger = (await (await fetch("/api/tasks")).json()) as {
          tasks: Array<{ title: string }>;
        };
        return ledger.tasks.some((task) => task.title === needle);
      }, title),
    ).toBe(true);
  });

  test("Retry clears only the raw draft that failed, never another target's draft", async ({
    app,
    browser,
    screen,
  }) => {
    await app.open("/?page=tasks");
    await expect(screen.getByRole("textbox", "New task")).toBeVisible();
    await setPlanDraft(screen, false);

    const tag = Date.now();
    const existingTitle = `Existing draft ${tag}`;
    const existingId = await browser.evaluate(async (title) => {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      const ledger = (await response.json()) as { tasks: Array<{ id: string; title: string }> };
      return ledger.tasks.find((task) => task.title === title)?.id ?? null;
    }, existingTitle);
    expect(existingId).not.toBeNull();
    await expect(screen.getByTestId(`task-${existingId}`)).toBeVisible();

    // Park the same raw text in another target's draft: the task-chat composer.
    await screen.getByRole("button", { name: `Open ${existingTitle}` }).tap();
    const taskChat = screen.getByTestId("task-agent-input");
    await expect(taskChat).toBeVisible();
    const raw = `@draftproj${tag} Retry  draft ${tag} `;
    await taskChat.fill(raw);
    await backToTaskList(screen);

    let attempts = 0;
    await browser.route("**/api/tasks", async (route) => {
      if (route.request.method !== "POST") {
        await route.continue();
        return;
      }
      attempts += 1;
      if (attempts === 1) {
        await route.fulfill({ status: 500, body: "Task list is full" });
        return;
      }
      await route.continue();
    });
    const composer = screen.getByRole("textbox", "New task");
    await composer.fill(raw);
    await screen.getByTestId("add-task").tap();
    await expect(screen.getByTestId("composer-error")).toHaveText("Task list is full");
    // Failure restores the raw text, which differs from the parsed title and a bare trim.
    await expect(composer).toHaveValue(raw);
    const failed = browser
      .locator('[data-create-failed="true"]')
      .filter({ hasText: "Retry draft" });
    await failed.getByRole("button", { name: /^Retry / }).tap();
    await expect(browser.locator('[data-create-failed="true"]')).toHaveCount(0);
    await backToTaskList(screen);
    await expect(screen.getByRole("textbox", "New task")).toHaveValue("");

    // The retry created one task, not a second copy when Add is pressed again.
    const parsedTitle = `Retry draft ${tag}`;
    const copies = await browser.evaluate(async (title) => {
      const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
        tasks: Array<{ title: string }>;
      };
      return ledger.tasks.filter((task) => task.title === title).length;
    }, parsedTitle);
    expect(copies).toBe(1);
    expect(attempts).toBe(2);

    // The unrelated draft survived the retry's cleanup.
    await screen.getByRole("button", { name: `Open ${existingTitle}` }).tap();
    await expect(screen.getByTestId("task-agent-input")).toHaveValue(raw);
  });

  test("the plan toggle is first, on by default, and keeps the composer focused", async ({
    app,
    browser,
    screen,
  }) => {
    const title = `SLOW plan the launch ${Date.now()}`;
    await browser.setViewport({ width: 390, height: 844 });
    await app.open("/?page=tasks");
    await browser.evaluate(() => {
      sessionStorage.removeItem("pi-ui:plan-task-draft");
      return null;
    });
    await app.open("/?page=tasks");

    const toggle = screen.getByRole("button", { name: "Plan this task" });
    // A fresh session starts with planning enabled.
    await expect(toggle).toHaveAttribute("aria-pressed", "true");

    // The plan control is the first focusable control in the status row: before
    // the live counts, the run word, the page tabs and the menu.
    expect(
      await browser.evaluate(() => {
        const button = document.querySelector<HTMLElement>('[data-testid="plan-task-toggle"]');
        const row = button?.parentElement;
        if (button === null || row === null || row === undefined) return false;
        return (
          row.querySelector(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
          ) === button
        );
      }),
    ).toBe(true);

    const statusRowHeight = () =>
      browser.evaluate(() => {
        const button = document.querySelector<HTMLElement>('[data-testid="plan-task-toggle"]');
        return button?.parentElement?.getBoundingClientRect().height ?? -1;
      });
    const focusedInput = () =>
      browser.evaluate(() => {
        const active = document.activeElement;
        return active instanceof HTMLTextAreaElement
          ? (active.getAttribute("aria-label") ?? active.tagName)
          : (active?.tagName ?? "");
      });

    const initialHeight = await statusRowHeight();
    const composer = screen.getByRole("textbox", "New task");
    await composer.fill("keep this draft");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await expect.poll(focusedInput).toBe("New task");
    await expect(composer).toHaveValue("keep this draft");
    // The state change only recolours the control; the row keeps its height.
    expect(Math.abs((await statusRowHeight()) - initialHeight)).toBeLessThan(0.5);

    // A reload in the same browser session keeps the off choice over the default.
    await app.open("/?page=tasks");
    const offToggle = screen.getByRole("button", { name: "Plan this task" });
    await expect(offToggle).toHaveAttribute("aria-pressed", "false");

    // A tap keeps the draft focused too and turns planning back on.
    const tapComposer = screen.getByRole("textbox", "New task");
    await tapComposer.fill("keep this tapped draft");
    await offToggle.tap();
    await expect(offToggle).toHaveAttribute("aria-pressed", "true");
    await expect.poll(focusedInput).toBe("New task");
    await expect(tapComposer).toHaveValue("keep this tapped draft");
    expect(Math.abs((await statusRowHeight()) - initialHeight)).toBeLessThan(0.5);

    // The on choice is remembered, and the submission starts a plan draft.
    await app.open("/?page=tasks");
    await expect(screen.getByRole("button", { name: "Plan this task" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    const draft = screen.getByRole("textbox", "New task");
    await draft.fill(title);
    await screen.getByTestId("add-task").tap();

    await expect(screen.getByTestId("task-detail")).toBeVisible();
    await expect(screen.getByTestId("task-agent-input")).toBeVisible();
    const created = await browser.evaluate(async (needle) => {
      const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
        tasks: Array<{ id: string; title: string; status: string; body?: string }>;
      };
      const task = ledger.tasks.find((item) => item.title === needle);
      return task === undefined
        ? null
        : { id: task.id, status: task.status, body: task.body ?? "" };
    }, title);
    expect(created?.status).toBe("planning");
    expect(created?.body).toContain(title);
    if (created === null) throw new Error("the plan draft is missing");
    await expect(screen.getByTestId(`task-detail-planning-${created.id}`)).toBeVisible();

    // The create itself started the plan run, with the composer text as its first message.
    await expect
      .poll(
        () =>
          browser.evaluate(
            async ({ id, needle }) => {
              const chat = (await (
                await fetch(`/api/tasks/${encodeURIComponent(id)}/chat`, { cache: "no-store" })
              ).json()) as { messages: Array<{ role: string; text: string }> };
              return chat.messages.some(
                (message) => message.role === "user" && message.text.includes(needle),
              );
            },
            { id: created.id, needle: title },
          ),
        { timeout: 20_000 },
      )
      .toBe(true);

    try {
      expect(
        await browser.evaluate(async (taskId) => {
          const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
            tasks: Array<{ id: string; status: string }>;
          };
          return ledger.tasks.find((task) => task.id === taskId)?.status ?? null;
        }, created.id),
      ).toBe("planning");
    } finally {
      await browser.evaluate(async (taskId) => {
        await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
        sessionStorage.removeItem("pi-ui:plan-task-draft");
        return null;
      }, created.id);
      // Leave the default viewport for the specs that follow this one.
      await browser.setViewport({ width: 1280, height: 720 });
    }
  });

  test("a failed plan create stays retryable instead of becoming a phantom draft", async ({
    app,
    browser,
    screen,
  }) => {
    const title = `Retry the plan draft ${Date.now()}`;
    await app.open("/?page=tasks");
    await browser.evaluate(() => {
      sessionStorage.removeItem("pi-ui:plan-task-draft");
      return null;
    });
    await app.open("/?page=tasks");
    // A fresh session is already planning.
    await expect(screen.getByRole("button", { name: "Plan this task" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    let attempts = 0;
    await browser.route("**/api/tasks", async (route) => {
      if (route.request.method !== "POST") {
        await route.continue();
        return;
      }
      attempts += 1;
      if (attempts === 1) {
        await route.fulfill({ status: 500, body: "Task list is full" });
        return;
      }
      await route.continue();
    });

    const composer = screen.getByRole("textbox", "New task");
    await composer.fill(title);
    await screen.getByTestId("add-task").tap();

    await expect(screen.getByTestId("composer-error")).toHaveText("Task list is full");
    const failed = browser.locator('[data-create-failed="true"]').filter({ hasText: title });
    await expect(failed).toBeVisible();
    await expect(failed.getByTestId("task-error")).toHaveText("Task list is full");
    await expect(browser.locator('[data-testid^="draft-"]').filter({ hasText: title })).toHaveCount(
      0,
    );

    await failed.getByRole("button", { name: `Retry ${title}` }).tap();
    await expect(browser.locator('[data-create-failed="true"]')).toHaveCount(0);
    await expect(screen.getByTestId("task-detail")).toBeVisible();
    await expect(screen.getByTestId("task-agent-input")).toBeVisible();

    const copies = await browser.evaluate(async (needle) => {
      const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
        tasks: Array<{ id: string; title: string; status: string }>;
      };
      const matching = ledger.tasks.filter((task) => task.title === needle);
      for (const task of matching) {
        await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
      }
      sessionStorage.removeItem("pi-ui:plan-task-draft");
      return matching.map((task) => task.status);
    }, title);
    expect(copies).toEqual(["planning"]);
    expect(attempts).toBe(2);
  });

  test("concurrent plan creates start the run for their own draft", async ({ app, browser }) => {
    const titles = [`Parallel plan one ${Date.now()}`, `Parallel plan two ${Date.now()}`];
    await app.open("/?page=tasks");
    const ids = await browser.evaluate(async (names) => {
      const responses = await Promise.all(
        names.map((title) =>
          fetch("/api/tasks", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title, plan: true }),
          }),
        ),
      );
      const ledgers = (await Promise.all(responses.map((response) => response.json()))) as Array<{
        tasks: Array<{ id: string; title: string; status: string }>;
      }>;
      return names.map(
        (title) =>
          ledgers.flatMap((ledger) => ledger.tasks).find((task) => task.title === title)?.id ??
          null,
      );
    }, titles);
    expect(ids.every((id) => typeof id === "string")).toBe(true);
    const taskIds = ids.filter((id): id is string => typeof id === "string");
    try {
      await expect
        .poll(
          () =>
            browser.evaluate(
              async ({ ids: taskIdsToRead, titles: expected }) => {
                const checks = await Promise.all(
                  taskIdsToRead.map(async (id, index) => {
                    const chat = (await (
                      await fetch(`/api/tasks/${encodeURIComponent(id)}/chat`, {
                        cache: "no-store",
                      })
                    ).json()) as { messages: Array<{ role: string; text: string }> };
                    return chat.messages.some(
                      (message) =>
                        message.role === "user" && message.text.includes(expected[index] ?? ""),
                    );
                  }),
                );
                return checks.every(Boolean);
              },
              { ids: taskIds, titles },
            ),
          { timeout: 20_000 },
        )
        .toBe(true);
      expect(
        await browser.evaluate(async (expected) => {
          const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
            tasks: Array<{ id: string; title: string; status: string }>;
          };
          return expected.map(
            (title) => ledger.tasks.find((task) => task.title === title)?.status ?? null,
          );
        }, titles),
      ).toEqual(["planning", "planning"]);
    } finally {
      await browser.evaluate(async (taskIdsToDelete) => {
        for (const id of taskIdsToDelete) {
          await fetch(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
        }
        return null;
      }, taskIds);
    }
  });

  type ReopenTaskRead = {
    id: string;
    title: string;
    status: "open" | "working" | "done" | "proposed" | "backlog";
    completedAt: string | null;
    completion: { evidence: string } | null;
    reopens?: { at: string; reason: string; by: "operator" | "agent" }[];
    reopenedAt?: string | null;
    project?: string;
  };

  async function deleteReopenTasks(browser: Browser, titles: readonly string[]) {
    const left = await browser.evaluate(async (names) => {
      const matching = async () =>
        (
          (await (await fetch("/api/tasks")).json()).tasks as Array<{ id: string; title: string }>
        ).filter((task) => names.includes(task.title));
      for (const task of await matching()) {
        await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
      }
      return (await matching()).length;
    }, titles);
    expect(left).toBe(0);
  }

  async function createReopenTask(
    browser: Browser,
    title: string,
    options: { done?: boolean; project?: string; propose?: boolean; backlog?: boolean } = {},
  ): Promise<string> {
    return browser.evaluate(
      async (args) => {
        const response = await fetch("/api/tasks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: args.title,
            ...(args.project === undefined ? {} : { project: args.project }),
            ...(args.propose === true
              ? {
                  propose: true,
                  rationale: "A proposal cannot be reopened because it is not finished.",
                }
              : {}),
            ...(args.backlog === true ? { backlog: true } : {}),
          }),
        });
        const ledger = (await response.json()) as { tasks: ReopenTaskRead[] };
        const task = ledger.tasks.find((item) => item.title === args.title);
        if (task === undefined) return "";
        if (args.done === true) {
          await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              status: "done",
              completion: { evidence: `e2e/tasks.e2e.ts ${args.title}` },
            }),
          });
        }
        return task.id;
      },
      { ...options, title },
    );
  }

  async function readReopenTask(browser: Browser, id: string): Promise<ReopenTaskRead | null> {
    return browser.evaluate(async (taskId) => {
      const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
        tasks: ReopenTaskRead[];
      };
      return ledger.tasks.find((task) => task.id === taskId) ?? null;
    }, id);
  }

  async function runToolCalls(
    browser: Browser,
    calls: Array<{ name: string; arguments: Record<string, string> }>,
  ) {
    await browser.evaluate(async (toolCalls) => {
      await fetch("/api/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `TOOLCALLS ${JSON.stringify(toolCalls)}` }),
      });
      return null;
    }, calls);
  }

  async function toolOutputs(browser: Browser, name: string): Promise<string[]> {
    return browser.evaluate(async (toolName) => {
      const state = (await (await fetch("/api/state", { cache: "no-store" })).json()) as {
        activity?: Array<{ name?: string; output?: string }>;
      };
      return (state.activity ?? [])
        .filter((entry) => entry.name === toolName && typeof entry.output === "string")
        .map((entry) => entry.output as string);
    }, name);
  }

  test("hides the plan toggle when the tasks composer is collapsed", async ({
    app,
    browser,
    screen,
  }) => {
    const title = `Collapsed composer ${Date.now()}`;
    await app.open("/?page=tasks");
    const id = await createReopenTask(browser, title, { done: true });
    expect(id).not.toBe("");

    try {
      await app.open("/?page=tasks");
      await expect(screen.getByTestId("plan-task-toggle")).toBeVisible();
      await screen.getByRole("button", { name: `Open ${title}` }).tap();
      await expect(screen.getByTestId("task-detail")).toBeVisible();
      await expect(screen.getByTestId("composer-body")).toHaveAttribute("data-collapsed", "true");
      await expect(screen.getByTestId("plan-task-toggle")).toHaveCount(0);
    } finally {
      await deleteReopenTasks(browser, [title]);
    }
  });

  test("reopens a done task with a reason and keeps the old completion", async ({
    app,
    browser,
    screen,
  }) => {
    const tag = Date.now();
    const title = `Reopen the regression ${tag}`;
    const project = `Zr${tag}`;
    const reason = "The operator says the fix regressed on the next run";
    await app.open("/?page=tasks");
    const id = await createReopenTask(browser, title, { done: true, project });
    expect(id).not.toBe("");

    try {
      await runToolCalls(browser, [{ name: "task_reopen", arguments: { id, reason } }]);
      await expect
        .poll(
          async () => {
            const outputs = await toolOutputs(browser, "task_reopen");
            return outputs.some((output) => output.includes(id) && output.includes("reopen #1"));
          },
          { timeout: 20_000 },
        )
        .toBe(true);
      const output = (await toolOutputs(browser, "task_reopen")).find((text) => text.includes(id));
      expect(output).toContain(`${id} open ${title}`);
      expect(output).toContain(`reopened: ${reason}`);
      expect(output).toContain("reopen #1");

      const reopened = await readReopenTask(browser, id);
      expect(reopened?.status).toBe("open");
      expect(reopened?.completedAt).toBeNull();
      expect(reopened?.completion?.evidence).toContain("e2e/tasks.e2e.ts");
      expect(reopened?.reopens?.length).toBe(1);
      expect(reopened?.reopens?.[0]?.reason).toBe(reason);
      expect(reopened?.reopens?.[0]?.by).toBe("agent");
      expect(reopened?.reopenedAt).toBe(reopened?.reopens?.[0]?.at);

      // The nudge selector sees the reopened ledger task as open work, without a synthetic copy.
      if (reopened === null) throw new Error("the reopened task is missing");
      const nudge = new IdleNudge(1_000, 0, "");
      const prompt = nudge.maybeNudge({ active: false, queued: 0, tasks: [reopened] }, Date.now());
      expect(prompt).toContain(id);

      await app.open("/?page=tasks");
      const card = screen.getByTestId(`task-${id}`);
      await expect(card).toHaveAttribute("data-state", "ready");
      await expect(screen.getByTestId(`task-reopens-${id}`)).toHaveText("1");
      await screen.getByRole("button", { name: `Open ${title}` }).tap();
      await expect(screen.getByTestId(`task-detail-reopens-${id}`)).toHaveText("1");
      const reopenBlock = screen.getByTestId("task-reopen");
      await expect(reopenBlock).toContainText(reason);
      await expect(screen.getByTestId("task-modal-completion")).toHaveCount(0);
    } finally {
      await deleteReopenTasks(browser, [title]);
    }
  });

  test("refuses a reopen without a reason and counts the second reopen", async ({
    app,
    browser,
    screen,
  }) => {
    const tag = Date.now();
    const title = `Reopen twice ${tag}`;
    await app.open("/?page=tasks");
    const id = await createReopenTask(browser, title, { done: true });
    expect(id).not.toBe("");

    try {
      await runToolCalls(browser, [{ name: "task_reopen", arguments: { id, reason: "   " } }]);
      await expect
        .poll(
          async () => {
            const outputs = await toolOutputs(browser, "task_reopen");
            return outputs.some((output) => output.includes("A reopen needs a reason"));
          },
          { timeout: 20_000 },
        )
        .toBe(true);
      expect((await readReopenTask(browser, id))?.status).toBe("done");

      const firstReason = "The first report was not the whole problem";
      await runToolCalls(browser, [
        { name: "task_reopen", arguments: { id, reason: firstReason } },
      ]);
      await expect
        .poll(async () => (await readReopenTask(browser, id))?.reopens?.length ?? 0, {
          timeout: 20_000,
        })
        .toBe(1);

      await browser.evaluate(async (taskId) => {
        await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            status: "done",
            completion: { evidence: "e2e/tasks.e2e.ts second close" },
          }),
        });
        return null;
      }, id);

      await app.open("/?page=tasks");
      await expect(screen.getByRole("button", { name: `Open ${title}` })).toBeVisible();
      await browser.evaluate((taskTitle) => {
        const card = [...document.querySelectorAll("[data-task-card]")].find((item) =>
          item.textContent?.includes(taskTitle),
        );
        if (!(card instanceof HTMLElement)) return null;
        const box = card.getBoundingClientRect();
        card.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: box.left + 16,
            clientY: box.top + box.height / 2,
          }),
        );
        return null;
      }, title);
      await expect(screen.getByTestId("task-menu")).toBeVisible();
      await screen.getByRole("menuitem", { name: `Reopen ${title}` }).tap();
      const prompt = screen.getByTestId("task-reopen-prompt");
      await expect(prompt).toBeVisible();
      const submit = screen.getByTestId("task-reopen-submit");
      expect(
        await browser.evaluate(() => {
          const button = document.querySelector<HTMLButtonElement>(
            '[data-testid="task-reopen-submit"]',
          );
          return button?.disabled ?? null;
        }),
      ).toBe(true);
      const secondReason = "It regressed again after the second close";
      await screen.getByRole("textbox", "Reopen reason").fill(secondReason);
      expect(
        await browser.evaluate(() => {
          const button = document.querySelector<HTMLButtonElement>(
            '[data-testid="task-reopen-submit"]',
          );
          return button?.disabled ?? null;
        }),
      ).toBe(false);
      await submit.tap();
      await expect.poll(async () => (await readReopenTask(browser, id))?.status).toBe("open");
      const reopened = await readReopenTask(browser, id);
      expect(reopened?.reopens?.length).toBe(2);
      expect(reopened?.reopens?.[1]?.reason).toBe(secondReason);
      expect(reopened?.reopens?.[1]?.by).toBe("operator");
      await expect(screen.getByTestId(`task-reopens-${id}`)).toHaveText("2");
    } finally {
      await deleteReopenTasks(browser, [title]);
    }
  });
});
