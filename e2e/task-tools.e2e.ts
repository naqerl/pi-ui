import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

type TaskRead = {
  id: string;
  title: string;
  status: string;
  workingSince?: string;
  lastWorkedAt?: string | null;
  releasedAt?: string;
  releaseReason?: string;
};

// The e2e server and its task store are shared by every test file: leave no tasks behind.
async function removeTasks(browser: Browser, titles: readonly string[]) {
  await browser.evaluate(async (names) => {
    const matching = async () =>
      (
        (await (await fetch("/api/tasks")).json()).tasks as Array<{ id: string; title: string }>
      ).filter((task) => names.includes(task.title));
    for (const task of await matching()) {
      await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
    }
    return null;
  }, titles);
}

async function createTask(browser: Browser, title: string): Promise<string> {
  return browser.evaluate(async (name) => {
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: name }),
    });
    const ledger = (await response.json()) as { tasks: TaskRead[] };
    return ledger.tasks.find((task) => task.title === name)?.id ?? "";
  }, title);
}

async function runWorking(
  browser: Browser,
  id: string,
  note: string,
  title: string,
): Promise<string> {
  await browser.evaluate(
    async (args) => {
      await fetch("/api/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: `TOOLCALLS ${JSON.stringify([
            { name: "task_working", arguments: { id: args.id, note: args.note } },
          ])}`,
        }),
      });
      return null;
    },
    { id, note },
  );
  let output: string | null = null;
  await expect
    .poll(
      async () => {
        output = await browser.evaluate(
          async (args) => {
            const state = (await (await fetch("/api/state", { cache: "no-store" })).json()) as {
              activity?: Array<{ name?: string; output?: string }>;
            };
            const result = (state.activity ?? []).find(
              (entry) =>
                entry.name === "task_working" &&
                typeof entry.output === "string" &&
                entry.output.includes(args.id) &&
                entry.output.includes(args.note),
            );
            return typeof result?.output === "string" ? result.output : null;
          },
          { id, note },
        );
        return output !== null;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  expect(output).toContain(title);
  expect(output).toContain("working");
  expect(output).toContain(note);
  return output ?? "";
}

async function runRelease(
  browser: Browser,
  id: string,
  reason: string,
  title: string,
): Promise<string> {
  await browser.evaluate(
    async (args) => {
      await fetch("/api/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: `TOOLCALLS ${JSON.stringify([
            { name: "task_release", arguments: { id: args.id, reason: args.reason } },
          ])}`,
        }),
      });
      return null;
    },
    { id, reason },
  );
  let output: string | null = null;
  await expect
    .poll(
      async () => {
        output = await browser.evaluate(
          async (args) => {
            const state = (await (await fetch("/api/state", { cache: "no-store" })).json()) as {
              activity?: Array<{ name?: string; output?: string }>;
            };
            const result = (state.activity ?? []).find(
              (entry) =>
                entry.name === "task_release" &&
                typeof entry.output === "string" &&
                entry.output.includes(args.id) &&
                entry.output.includes(args.reason),
            );
            return typeof result?.output === "string" ? result.output : null;
          },
          { id, reason },
        );
        return output !== null;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  expect(output).toContain(title);
  expect(output).toContain("open");
  expect(output).toContain(`released: ${reason}`);
  return output ?? "";
}

async function readTask(browser: Browser, id: string): Promise<TaskRead | null> {
  return browser.evaluate(async (taskId) => {
    const state = (await (await fetch("/api/state", { cache: "no-store" })).json()) as {
      tasks: { tasks: TaskRead[] };
    };
    return state.tasks.tasks.find((task) => task.id === taskId) ?? null;
  }, id);
}

test("task_working persists its start, repeats idempotently and clears on close", async ({
  app,
  browser,
  screen,
}) => {
  const tag = Date.now();
  const title = `Track the working badge ${tag}`;
  await app.open("/?page=tasks");
  const id = await createTask(browser, title);
  expect(id).not.toBe("");

  try {
    const first = `first pass ${tag}`;
    await runWorking(browser, id, first, title);
    const afterFirst = await readTask(browser, id);
    expect(afterFirst?.status).toBe("working");
    expect(typeof afterFirst?.workingSince).toBe("string");
    expect(typeof afterFirst?.lastWorkedAt).toBe("string");

    // Reload the page: the badge comes from the persisted status, not from a live run.
    await app.open("/?page=tasks");
    await expect(screen.getByTestId(`task-${id}`)).toHaveAttribute("data-state", "working");
    await expect(screen.getByTestId(`task-${id}`)).toContainText("Working");

    await new Promise((resolve) => setTimeout(resolve, 50));
    await runWorking(browser, id, `second pass ${tag}`, title);
    const afterSecond = await readTask(browser, id);
    expect(afterSecond?.status).toBe("working");
    expect(afterSecond?.workingSince).toBe(afterFirst?.workingSince);

    await browser.evaluate(async (taskId) => {
      await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      });
      return null;
    }, id);
    const closed = await readTask(browser, id);
    expect(closed?.status).toBe("done");
    expect(closed?.workingSince).toBeUndefined();
    expect(closed?.lastWorkedAt ?? null).toBeNull();
  } finally {
    await removeTasks(browser, [title]);
  }
});

test("task_release returns a working task to open through the tool route", async ({
  app,
  browser,
  screen,
}) => {
  const tag = Date.now();
  const title = `Park the working badge ${tag}`;
  const reason = "Waiting for the nightly build to finish";
  await app.open("/?page=tasks");
  const id = await createTask(browser, title);
  expect(id).not.toBe("");

  try {
    await runWorking(browser, id, `first pass ${tag}`, title);
    expect((await readTask(browser, id))?.status).toBe("working");

    await runRelease(browser, id, reason, title);
    const released = await readTask(browser, id);
    expect(released?.status).toBe("open");
    expect(released?.releaseReason).toBe(reason);
    expect(typeof released?.releasedAt).toBe("string");
    expect(released?.workingSince).toBeUndefined();
    expect(released?.lastWorkedAt ?? null).toBeNull();

    // The release's own attributed call must not revive the badge after it was cleared.
    await app.open("/?page=tasks");
    await expect(screen.getByTestId(`task-${id}`)).toHaveAttribute("data-state", "ready");
    await expect(screen.getByTestId(`task-badge-${id}`)).toHaveCount(0);
    await expect(screen.getByTestId(`task-stale-${id}`)).toHaveCount(0);
    await screen.getByRole("button", { name: `Open ${title}` }).tap();
    await expect(screen.getByTestId(`task-released-${id}`)).toContainText(reason);
  } finally {
    await removeTasks(browser, [title]);
  }
});

test("a released task shows its reason in the task details", async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  const tag = Date.now();
  const title = `Show the released badge ${tag}`;
  const reason = "Parked until the capacity frees up";
  await app.open("/?page=tasks");
  const id = await createTask(browser, title);
  expect(id).not.toBe("");

  try {
    const seeded = await browser.evaluate(
      async (args) => {
        const working = await fetch(`/api/tasks/${encodeURIComponent(args.id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "working" }),
        });
        if (!working.ok) return false;
        const released = await fetch(`/api/tasks/${encodeURIComponent(args.id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "open", releaseReason: args.reason }),
        });
        return released.ok;
      },
      { id, reason },
    );
    expect(seeded).toBe(true);

    await app.open("/?page=tasks");
    await expect(screen.getByTestId(`task-${id}`)).toHaveAttribute("data-state", "ready");
    await expect(screen.getByTestId(`task-badge-${id}`)).toHaveCount(0);
    await screen.getByRole("button", { name: `Open ${title}` }).tap();

    const line = screen.getByTestId(`task-released-${id}`);
    await expect(line).toBeVisible();
    await expect(line).toContainText("released");
    await expect(line).toContainText(reason);
  } finally {
    await removeTasks(browser, [title]);
  }
});
