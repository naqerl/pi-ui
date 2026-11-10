import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

async function removeTasks(browser: Browser, titles: readonly string[]) {
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
        muted: parkedStyle.color !== liveStyle.color,
        filtered:
          parkedCard.classList.contains("saturate-0") &&
          !liveCard.classList.contains("saturate-0") &&
          parkedStyle.filter !== liveStyle.filter,
        parkedLast: ordered.at(-1) === `Open ${parkedName}`,
        projectOrderStable:
          groups.indexOf(`task-project-${parkedGroup}`) <
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
    projectOrderStable: true,
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
