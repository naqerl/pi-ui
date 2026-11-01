import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

type TaskRead = {
  id: string;
  title: string;
  status: string;
  workingSince?: string;
  lastWorkedAt?: string | null;
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
