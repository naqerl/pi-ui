import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { IdleNudge } from "../src/server/idle-nudge.js";
import { chooseTaskAction, createOpenTask, openTaskActions } from "./tasks-helpers";

test("keeps a todo with subtasks and blockers on the tasks page", { timeout: 300_000 }, async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 800 });
  await app.open("/");
  await expect(screen.getByRole("textbox", "Message")).toBeVisible();

  await screen.getByRole("tab", "Tasks").tap();
  await expect(screen.getByRole("textbox", "New task")).toBeVisible();
  await createOpenTask(screen, "Write the ledger");
  const list = screen.getByTestId("task-list");
  await expect(list.getByText("Write the ledger", { exact: true })).toBeVisible();
  expect(await browser.evaluate(() => document.querySelector("[data-task-check]") === null)).toBe(
    true,
  );
  await expect(screen.getByTestId("task-agent-input")).toHaveValue("");
  await expect(screen.getByTestId("subtask-progress")).toHaveCount(0);

  const mouseHold = await browser.evaluate(async () => {
    const card = [...document.querySelectorAll("[data-task-card]")].find((item) =>
      item.textContent?.includes("Write the ledger"),
    );
    if (!(card instanceof HTMLElement)) return null;
    const box = card.getBoundingClientRect();
    const fire = (type: string) => {
      card.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 3,
          pointerType: "mouse",
          isPrimary: true,
          clientX: box.left + 24,
          clientY: box.top + box.height / 2,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
        }),
      );
    };
    fire("pointerdown");
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 560);
    });
    fire("pointerup");
    return document.querySelector("[data-testid=task-menu]") !== null;
  });
  expect(mouseHold).toBe(false);

  const selectedBefore = await browser.evaluate(
    () => document.querySelector("[data-testid=task-detail]")?.getAttribute("aria-label") ?? null,
  );
  const longPress = await browser.evaluate(async () => {
    const card = [...document.querySelectorAll("[data-task-card]")].find((item) =>
      item.textContent?.includes("Write the ledger"),
    );
    if (!(card instanceof HTMLElement)) return null;
    const box = card.getBoundingClientRect();
    const x = box.left + 24;
    const y = box.top + box.height / 2;
    const fire = (type: string) => {
      card.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 4,
          pointerType: "touch",
          isPrimary: true,
          clientX: x,
          clientY: y,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
        }),
      );
    };
    fire("pointerdown");
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 560);
    });
    fire("pointerup");
    card.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    return document.querySelector("[data-testid=task-detail]")?.getAttribute("aria-label") ?? null;
  });
  // The long press leaves the desktop's selected task alone instead of opening another one.
  expect(longPress).toBe(selectedBefore);
  await expect(screen.getByTestId("task-menu")).toBeVisible();
  await expect(list.getByRole("button", { name: /Done Write the ledger/ })).toHaveCount(0);

  // Structure now comes from the ledger tools, so seed the child through the API instead.
  const seeded = await browser.evaluate(async () => {
    const ledger = (await (await fetch("/api/tasks")).json()) as {
      tasks: Array<{ id: string; title: string }>;
    };
    const parentId = ledger.tasks.find((task) => task.title === "Write the ledger")?.id;
    if (parentId === undefined) return false;
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Store tasks.json", parentId }),
    });
    return response.ok;
  });
  expect(seeded).toBe(true);
  await app.open("/?page=tasks");
  await expect(list.getByText("Store tasks.json", { exact: true })).toBeVisible();
  await expect(list.getByText("0 of 1 subtasks done", { exact: true })).toBeVisible();
  const cards = await browser.evaluate(() => {
    const page = getComputedStyle(document.body).backgroundColor;
    const read = (title: string) => {
      const card = [...document.querySelectorAll("[data-task-card]")].find((item) =>
        item.textContent?.includes(title),
      );
      if (!(card instanceof HTMLElement)) return null;
      const background = getComputedStyle(card).backgroundColor;
      const match = background.match(/^rgba?\(([^)]+)\)$/);
      const parts = match?.[1]?.split(/[,\s/]+/).filter(Boolean) ?? [];
      const alpha = parts.length === 4 ? Number(parts[3]) : 1;
      return { background, alpha, page };
    };
    return {
      parent: read("Write the ledger"),
      child: read("Store tasks.json"),
    };
  });
  expect(cards?.parent?.background).not.toBe(cards?.parent?.page);
  expect(cards?.parent?.alpha).toBe(1);
  expect(cards?.child?.background).toBe(cards?.parent?.background);
  expect(cards?.child?.alpha).toBe(1);

  // A parent with an open subtask cannot be completed from its card menu either.
  await browser.evaluate(() => {
    const card = [...document.querySelectorAll("[data-task-card]")].find((item) =>
      item.textContent?.includes("Write the ledger"),
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
  });
  const parentMarkDone = screen.getByRole("menuitem", "Mark done Write the ledger");
  await expect(parentMarkDone).toBeVisible();
  await expect(parentMarkDone).toHaveAttribute("aria-disabled", "true");
  await expect(parentMarkDone).toHaveAttribute("title", "Finish open subtasks first");
  expect(
    await browser.evaluate(() => {
      const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
        (node) => node.getAttribute("aria-label") === "Mark done Write the ledger",
      );
      return item?.disabled ?? null;
    }),
  ).toBe(true);
  await browser.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return null;
  });
  await expect(screen.getByTestId("task-menu")).toHaveCount(0);

  await createOpenTask(screen, "Review the diff");
  await expect(list.getByText("Review the diff", { exact: true })).toBeVisible();

  // The blocker link is a ledger fact; seed it through the API and keep asserting the display.
  const blocked = await browser.evaluate(async () => {
    const ledger = (await (await fetch("/api/tasks")).json()) as {
      tasks: Array<{ id: string; title: string }>;
    };
    const gated = ledger.tasks.find((task) => task.title === "Write the ledger");
    const blocker = ledger.tasks.find((task) => task.title === "Review the diff");
    if (gated === undefined || blocker === undefined) return false;
    const response = await fetch(`/api/tasks/${encodeURIComponent(gated.id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blockedBy: [blocker.id] }),
    });
    return response.ok;
  });
  expect(blocked).toBe(true);
  await expect(list.getByText("Blocked by Review the diff", { exact: true })).toBeVisible();

  await screen.getByRole("button", { name: "Open Write the ledger" }).tap();
  await openTaskActions(screen);
  const parentStatus = screen.getByTestId("task-detail-status");
  await expect(parentStatus).toBeVisible();
  await expect(parentStatus).toHaveAttribute("aria-disabled", "true");
  const parentDone = await browser.evaluate(() => {
    const button = document.querySelector<HTMLElement>('[data-testid="task-detail-status"]');
    return button?.getAttribute("aria-disabled") === "true";
  });
  expect(parentDone).toBe(true);
  const blockedTap = await browser.evaluate(async () => {
    const button = document.querySelector<HTMLElement>('[data-testid="task-detail-status"]');
    button?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return {
      disabled: button?.getAttribute("aria-disabled") ?? null,
      label: button?.textContent?.trim() ?? null,
    };
  });
  expect(blockedTap).toEqual({ disabled: "true", label: "Mark done" });
  await browser.keyboard.press("Escape");

  await browser.evaluate(() => {
    const card = [...document.querySelectorAll("[data-task-card]")].find((item) =>
      item.textContent?.includes("Review the diff"),
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
  });
  await screen.getByRole("menuitem", "Mark done Review the diff").tap();
  await expect(list.getByText("Blocked by Review the diff", { exact: true })).not.toBeVisible();
  await screen.getByRole("button", { name: "Open Store tasks.json" }).tap();
  await chooseTaskAction(screen, "task-detail-status");
  await expect(screen.getByTestId("task-state")).toHaveText("Done");
  await expect(list.getByText("1 of 1 subtasks done", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Open Write the ledger" }).tap();
  await chooseTaskAction(screen, "task-detail-status");
  await expect(screen.getByTestId("task-state")).toHaveText("Done");

  expect(await browser.evaluate(() => new URLSearchParams(location.search).get("page"))).toBe(
    "tasks",
  );
  await app.open("/?page=tasks");
  await expect(screen.getByRole("textbox", "New task")).toBeVisible();
  await expect(list.getByText("Write the ledger", { exact: true })).toBeVisible();
  await expect(list.getByText("Store tasks.json", { exact: true })).toBeVisible();
  await expect(list.getByText("1 of 1 subtasks done", { exact: true })).toBeVisible();

  await browser.evaluate(() => {
    const card = [...document.querySelectorAll('[data-state="done"] > [data-task-card]')].find(
      (item) => item.textContent?.includes("Review the diff"),
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
  });
  await expect(screen.getByRole("menuitem", "Reopen Review the diff")).toBeVisible();
  await screen.getByRole("menuitem", "Remove Review the diff").tap();
  await expect(screen.getByText("Review the diff", { exact: true })).not.toBeVisible();

  await screen.getByRole("tab", "Chat").tap();
  await expect(screen.getByRole("textbox", "Message")).toBeVisible();
  await expect(screen.getByTestId("subtask-progress")).toHaveCount(0);
  expect(await browser.evaluate(() => new URLSearchParams(location.search).get("page"))).toBe(
    "chat",
  );
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

test("retires an optimistic task card when the create fails and keeps the draft", async ({
  app,
  browser,
  screen,
}) => {
  await app.open("/?page=tasks");
  await expect(screen.getByRole("textbox", "New task")).toBeVisible();
  await browser.route("**/api/tasks", async (route) => {
    if (route.request.method !== "POST") {
      await route.continue();
      return;
    }
    await route.fulfill({ status: 500, body: "Task list is full" });
  });
  const composer = screen.getByRole("textbox", "New task");
  const list = screen.getByTestId("task-list");
  const title = `Rejected task ${Date.now()}`;
  await composer.fill(title);
  await screen.getByRole("button", "Add task").tap();

  await expect(screen.getByTestId("composer-error")).toHaveText("Task list is full");
  await expect(composer).toHaveValue(title);
  await expect(list.getByText(title, { exact: true })).toHaveCount(0);
});

test("create and propose share the insert and differ only in their proposal fields", async ({
  app,
  browser,
}) => {
  await app.open("/?page=tasks");
  const rowsJson = await browser.evaluate(async () => {
    const title = `Shared insert ${Date.now()}`;
    const body = "Same body for both rows.";
    const rationale = "The same insert should make both rows, differing only in proposal fields.";
    const create = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, parentId: null, project: "shared-insert", body }),
    });
    const propose = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        propose: true,
        rationale,
        project: "shared-insert",
        body,
      }),
    });
    const created = (await create.json()) as {
      tasks: Array<Record<string, unknown>>;
    };
    const proposed = (await propose.json()) as {
      tasks: Array<Record<string, unknown>>;
    };
    const open = created.tasks.find((task) => task.title === title && task.status === "open");
    const idea = proposed.tasks.find((task) => task.title === title && task.status === "proposed");
    if (open === undefined || idea === undefined) return "null";
    const shared = (task: Record<string, unknown>) => {
      const copy = { ...task };
      for (const key of ["id", "status", "proposedAt", "rationale", "createdBy", "createdAt"]) {
        delete copy[key];
      }
      return copy;
    };
    await fetch(`/api/tasks/${encodeURIComponent(String(open.id))}`, { method: "DELETE" });
    await fetch(`/api/tasks/${encodeURIComponent(String(idea.id))}`, { method: "DELETE" });
    return JSON.stringify({
      open: shared(open),
      proposed: shared(idea),
      openAuthor: open.createdBy,
      proposedAuthor: idea.createdBy,
      proposedAt: idea.proposedAt,
      rationale: idea.rationale,
    });
  });
  const rows = JSON.parse(rowsJson) as {
    open: Record<string, unknown>;
    proposed: Record<string, unknown>;
    openAuthor: unknown;
    proposedAuthor: unknown;
    proposedAt: unknown;
    rationale: unknown;
  } | null;
  expect(rows).not.toBeNull();
  expect(rows?.open).toEqual(rows?.proposed);
  expect(rows?.openAuthor).toBe("operator");
  expect(rows?.proposedAuthor).toBe("operator");
  expect(rows?.rationale).toContain("same insert");
  expect(typeof rows?.proposedAt).toBe("string");
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
    await runToolCalls(browser, [{ name: "task_reopen", arguments: { id, reason: firstReason } }]);
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

test("a proposed or backlog task cannot be reopened", async ({ app, browser }) => {
  const tag = Date.now();
  const proposedTitle = `Proposed reopen ${tag}`;
  const backlogTitle = `Backlog reopen ${tag}`;
  await app.open("/?page=tasks");
  const proposedId = await createReopenTask(browser, proposedTitle, { propose: true });
  const backlogId = await createReopenTask(browser, backlogTitle, { backlog: true });
  expect(proposedId).not.toBe("");
  expect(backlogId).not.toBe("");

  try {
    await runToolCalls(browser, [
      {
        name: "task_reopen",
        arguments: { id: proposedId, reason: "A proposal is not finished" },
      },
      {
        name: "task_reopen",
        arguments: { id: backlogId, reason: "A parked task is not finished" },
      },
    ]);
    await expect
      .poll(
        async () => {
          const outputs = await toolOutputs(browser, "task_reopen");
          return outputs.filter((output) => output.includes("Only a done task can be reopened"))
            .length;
        },
        { timeout: 20_000 },
      )
      .toBe(2);
    expect((await readReopenTask(browser, proposedId))?.status).toBe("proposed");
    expect((await readReopenTask(browser, backlogId))?.status).toBe("backlog");
  } finally {
    await deleteReopenTasks(browser, [proposedTitle, backlogTitle]);
  }
});

test("a press compresses buttons and role buttons until release, unless reduced motion", async ({
  app,
  browser,
  screen,
}) => {
  const transformOf = (selector: string) =>
    browser.evaluate((target) => {
      const element = document.querySelector<HTMLElement>(target);
      return element === null ? null : getComputedStyle(element).transform;
    }, selector);
  const scaleOf = (selector: string) =>
    browser.evaluate((target) => {
      const element = document.querySelector<HTMLElement>(target);
      if (element === null) return null;
      const transform = getComputedStyle(element).transform;
      if (transform === "none") return 1;
      const scale = Number(transform.slice("matrix(".length).split(",")[0]);
      return Number.isFinite(scale) ? scale : null;
    }, selector);
  const pointOf = (selector: string) =>
    browser.evaluate((target) => {
      const element = document.querySelector<HTMLElement>(target);
      if (element === null) return null;
      const box = element.getBoundingClientRect();
      return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
    }, selector);
  const settle = () =>
    browser.evaluate(async () => {
      await new Promise<void>((resolve) => {
        window.setTimeout(resolve, 160);
      });
      return true;
    });

  await browser.setViewport({ width: 1280, height: 800 });
  await browser.emulateMedia({ reducedMotion: "no-preference" });
  await app.open("/?page=tasks");

  const title = `Press feedback ${Date.now()}`;
  const taskId = await browser.evaluate(async (taskTitle) => {
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: taskTitle }),
    });
    if (!response.ok) return null;
    const ledger = (await response.json()) as { tasks: Array<{ id: string; title: string }> };
    return ledger.tasks.find((task) => task.title === taskTitle)?.id ?? null;
  }, title);
  expect(taskId).not.toBeNull();
  if (taskId === null) throw new Error("created task is missing");
  await app.open("/?page=tasks");
  await expect(screen.getByTestId(`task-${taskId}`)).toBeVisible();

  await screen.getByRole("textbox", "New task").fill(`Button press ${Date.now()}`);
  const buttonSelector = '[data-testid="add-task"]';
  await expect(screen.getByTestId("add-task")).toBeVisible();
  expect(await transformOf(buttonSelector)).toBe("none");

  const buttonPoint = await pointOf(buttonSelector);
  expect(buttonPoint).not.toBeNull();
  if (buttonPoint === null) throw new Error("Add task has no box");
  // Synthetic pointer events do not enter :active, so hold a real pointer to read the press.
  await browser.mouse.move(buttonPoint.x, buttonPoint.y);
  await browser.mouse.down();
  await expect.poll(() => scaleOf(buttonSelector), { timeout: 2_000 }).toBeLessThan(1);
  expect(await scaleOf(buttonSelector)).toBeGreaterThan(0.95);
  await browser.mouse.up();
  await expect.poll(() => transformOf(buttonSelector), { timeout: 2_000 }).toBe("none");

  const cardSelector = `[data-testid="task-${taskId}"] [data-task-card]`;
  const cardPoint = await pointOf(cardSelector);
  expect(cardPoint).not.toBeNull();
  if (cardPoint === null) throw new Error("task card has no box");
  await browser.mouse.move(cardPoint.x, cardPoint.y);
  await browser.mouse.down();
  await expect.poll(() => scaleOf(cardSelector), { timeout: 2_000 }).toBeLessThan(1);
  await browser.mouse.up();

  await browser.emulateMedia({ reducedMotion: "reduce" });
  // A card press can open the desktop detail, which hides the create composer.
  await browser.keyboard.press("Escape");
  await expect(screen.getByRole("textbox", "New task")).toBeVisible();
  await screen.getByRole("textbox", "New task").fill(`${title} reduced`);
  const reducedPoint = await pointOf(buttonSelector);
  expect(reducedPoint).not.toBeNull();
  if (reducedPoint === null) throw new Error("Add task has no box");
  await browser.mouse.move(reducedPoint.x, reducedPoint.y);
  await browser.mouse.down();
  await settle();
  expect(await transformOf(buttonSelector)).toBe("none");
  await browser.mouse.up();
});
