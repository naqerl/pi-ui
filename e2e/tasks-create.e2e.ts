import { test } from "@e2e-dev/web";
import { expect } from "e2e";

import { removeTasks } from "./tasks-helpers.js";

test("keeps a todo with subtasks and blockers on the tasks page", { timeout: 300_000 }, async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 800 });
  await app.open("/");
  await expect(screen.getByRole("textbox", "Message")).toBeVisible();

  await screen.getByRole("tab", "Tasks").tap();
  const composer = screen.getByRole("textbox", "New task");
  await expect(composer).toBeVisible();

  await composer.fill("Write the ledger");
  await screen.getByRole("button", "Add task").tap();
  const list = screen.getByTestId("task-list");
  await expect(list.getByText("Write the ledger", { exact: true })).toBeVisible();
  expect(await browser.evaluate(() => document.querySelector("[data-task-check]") === null)).toBe(
    true,
  );
  await expect(composer).toHaveValue("");
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

  await screen.getByRole("textbox", "New task").fill("Review the diff");
  await screen.getByRole("button", "Add task").tap();
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
  await screen.getByTestId("task-detail-status").tap();
  await expect(screen.getByTestId("task-state")).toHaveText("Done");
  await expect(list.getByText("1 of 1 subtasks done", { exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Open Write the ledger" }).tap();
  await screen.getByTestId("task-detail-status").tap();
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
  const composer = screen.getByRole("textbox", "New task");
  const list = screen.getByTestId("task-list");
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

  const title = `Painted task ${Date.now()}`;
  await composer.fill(title);
  try {
    await screen.getByRole("button", "Add task").tap();
    await expect(list.getByText(title, { exact: true })).toBeVisible({ timeout: 1_500 });
    expect(requests).toBe(1);
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

test("a long press on Send parks the next task in the backlog", { timeout: 300_000 }, async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 1280, height: 844 });
  await app.open("/?page=tasks");
  const composer = screen.getByRole("textbox", "New task");
  await expect(composer).toBeVisible();
  await expect(screen.getByTestId("task-filters")).toHaveCount(0);
  await expect(screen.getByTestId("task-filter-active")).toHaveCount(0);
  await expect(screen.getByTestId("task-filter-blocked")).toHaveCount(0);
  await expect(screen.getByTestId("task-filter-proposed")).toHaveCount(0);

  const tag = Date.now();
  const liveProject = `Zlive${tag}`;
  const parkedProject = `Abacklog${tag}`;
  const liveTitle = `Live ${tag}`;
  const parkedTitle = `Parked ${tag}`;
  const parkedOnlyTitle = `Parked elsewhere ${tag}`;
  const workingTitle = `Working ${tag}`;
  const titles = [liveTitle, parkedTitle, parkedOnlyTitle, workingTitle];

  // A project whose only task is parked, sorted before the live project by name.
  await browser.evaluate(
    async ({ title, project }) => {
      await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, project, backlog: true }),
      });
      return null;
    },
    { title: parkedOnlyTitle, project: parkedProject },
  );

  // A parked badge must read as a filled chip, while a working badge keeps the
  // filled look it already had.
  const workingStatus = await browser.evaluate(
    async ({ title, project }) => {
      await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, project }),
      });
      const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
        tasks: Array<{ id: string; title: string }>;
      };
      const task = ledger.tasks.find((item) => item.title === title);
      if (task === undefined) return null;
      const patched = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "working" }),
      });
      return patched.status;
    },
    { title: workingTitle, project: liveProject },
  );
  expect(workingStatus).toBe(200);

  // A short press still makes a normal task in a project.
  await composer.fill(`@${liveProject} ${liveTitle}`);
  await screen.getByRole("button", "Add task").tap();
  await expect(screen.getByText(liveTitle, { exact: true })).toBeVisible();

  await composer.fill(`@${liveProject} ${parkedTitle}`);
  await browser.evaluate(async () => {
    const button = document.querySelector<HTMLButtonElement>('[data-testid="add-task"]');
    if (button === null) return null;
    const box = button.getBoundingClientRect();
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    const fire = (type: string) =>
      button.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 21,
          pointerType: "touch",
          isPrimary: true,
          clientX: x,
          clientY: y,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
        }),
      );
    fire("pointerdown");
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 560);
    });
    fire("pointerup");
    return null;
  });
  // The timer-driven mode change commits after the pointer events; wait for it.
  await expect(screen.getByTestId("add-task")).toHaveAttribute("aria-pressed", "true");
  await expect(screen.getByTestId("backlog-chip")).toHaveText("Backlog");
  await expect(composer).toHaveAttribute("placeholder", "New backlog task");

  await screen.getByRole("button", "Add task").tap();
  await expect(screen.getByText(liveTitle, { exact: true })).toBeVisible();
  await expect(screen.getByText(parkedTitle, { exact: true })).toBeVisible();
  await expect(screen.getByTestId("add-task")).toHaveAttribute("aria-pressed", "false");
  await expect(screen.getByTestId("backlog-chip")).toHaveCount(0);
  await expect(screen.getByTestId("task-filters")).toHaveCount(0);
  await expect(screen.getByTestId("task-filter-active")).toHaveCount(0);
  await expect(screen.getByTestId("task-filter-blocked")).toHaveCount(0);
  await expect(screen.getByTestId("task-filter-proposed")).toHaveCount(0);

  const ledger = await browser.evaluate(async (names) => {
    const result = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
      tasks: Array<{ id: string; title: string; status: string; project?: string }>;
    };
    return result.tasks.filter((task) => names.includes(task.title));
  }, titles);
  const parked = ledger.find((task) => task.title === parkedTitle);
  const live = ledger.find((task) => task.title === liveTitle);
  expect(parked?.status).toBe("backlog");
  expect(live?.status).toBe("open");
  expect(parked?.project).toBe(liveProject);

  const page = await browser.evaluate(
    ({ parkedName, liveName, workingName, liveGroup, parkedGroup }) => {
      const card = (name: string) =>
        [...document.querySelectorAll<HTMLElement>("[data-task-card]")].find(
          (item) => item.getAttribute("aria-label") === `Open ${name}`,
        );
      const badgeStyle = (name: string) => {
        const badge = card(name)?.querySelector<HTMLElement>('[data-testid^="task-badge-"]');
        if (badge === undefined || badge === null) return null;
        const style = getComputedStyle(badge);
        return { background: style.backgroundColor, color: style.color };
      };
      const parkedCard = card(parkedName);
      const liveCard = card(liveName);
      if (parkedCard === undefined || liveCard === undefined) return null;
      const parkedBadge = badgeStyle(parkedName);
      const workingBadge = badgeStyle(workingName);
      if (parkedBadge === null || workingBadge === null) return null;
      const parkedStyle = getComputedStyle(parkedCard);
      const liveStyle = getComputedStyle(liveCard);
      const group = document.querySelector<HTMLElement>(
        `[data-testid="task-project-${liveGroup}"]`,
      );
      const ordered = [...(group?.querySelectorAll<HTMLElement>("[data-task-card]") ?? [])].map(
        (item) => item.getAttribute("aria-label"),
      );
      const groups = [
        ...document.querySelectorAll<HTMLElement>('[data-testid^="task-project-"]'),
      ].map((item) => item.dataset.testid ?? "");
      return {
        muted: parkedStyle.backgroundColor !== liveStyle.backgroundColor,
        filtered: parkedStyle.filter !== "none" || parkedStyle.backdropFilter !== "none",
        parkedLast: ordered.at(-1) === `Open ${parkedName}`,
        parkedGroupLast:
          groups.indexOf(`task-project-${parkedGroup}`) >
          groups.indexOf(`task-project-${liveGroup}`),
        badges: { parked: parkedBadge, working: workingBadge },
      };
    },
    {
      parkedName: parkedTitle,
      liveName: liveTitle,
      workingName: workingTitle,
      liveGroup: liveProject,
      parkedGroup: parkedProject,
    },
  );
  expect(page).toEqual({
    muted: true,
    filtered: true,
    parkedLast: true,
    parkedGroupLast: true,
    badges: { parked: expect.any(Object), working: expect.any(Object) },
  });

  // The parked badge is a solid filled chip whose text contrasts with its fill;
  // the working badge keeps the same default fill it already used.
  const transparent = ["transparent", "rgba(0, 0, 0, 0)"];
  const badges = page?.badges ?? { parked: null, working: null };
  expect(transparent).not.toContain(badges.parked?.background);
  expect(badges.parked?.color).not.toBe(badges.parked?.background);
  expect(transparent).not.toContain(badges.working?.background);
  expect(badges.working?.color).not.toBe(badges.working?.background);
  expect(badges.parked?.background).toBe(badges.working?.background);

  // The agent's real ledger tools hide the parked task and refuse its id.
  await screen.getByRole("tab", "Chat").tap();
  const chat = screen.getByRole("textbox", "Message");
  await chat.fill(
    `TOOLCALLS ${JSON.stringify([
      { name: "task_list", arguments: {} },
      {
        name: "task_done",
        arguments: { id: parked?.id, evidence: "e2e/tasks-backlog.e2e.ts" },
      },
    ])}`,
  );
  await screen.getByRole("button", "Send").tap();
  const readTools = () =>
    browser.evaluate(async () => {
      const state = (await (await fetch("/api/state", { cache: "no-store" })).json()) as {
        activity?: Array<{ name?: string; output?: string }>;
      };
      const output = (name: string) => {
        const item = (state.activity ?? []).find((entry) => entry.name === name);
        return typeof item?.output === "string" ? item.output : null;
      };
      return { list: output("task_list"), done: output("task_done") };
    });
  await expect
    .poll(
      async () => {
        const tools = await readTools();
        return tools.list !== null && tools.done !== null;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  const tools = await readTools();
  expect(tools.list).toContain(liveTitle);
  expect(tools.list).not.toContain(parkedTitle);
  expect(tools.list).not.toContain(parked?.id);
  expect(tools.done).toContain("Unknown task");

  await removeTasks(browser, titles);
});
