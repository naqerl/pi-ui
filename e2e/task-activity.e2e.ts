import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";

// A task is working because a run called tools tagged with its id, never because the agent said
// so; calls without a tag are not attributed to any task, and the badge survives the turn.
test("tagged tool calls show a task as working, untagged ones touch no task", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks");
  const tag = Date.now();
  const title = `Measure the build ${tag}`;
  const id = await browser.evaluate(async (name) => {
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: name }),
    });
    const ledger = (await response.json()) as { tasks: Array<{ id: string; title: string }> };
    return ledger.tasks.find((task) => task.title === name)?.id ?? null;
  }, title);
  expect(id).not.toBeNull();
  await expect(screen.getByTestId(`task-${id}`)).toBeVisible();
  await expect(screen.getByTestId("now-line")).toHaveCount(0);

  // The tagged call waits until the test has looked, however slow the machine.
  const release = join(tmpdir(), `pi-ui-task-activity-${tag}-${randomUUID()}`);
  const wait = `for i in $(seq 600); do [ -e '${release}' ] && break; sleep 0.1; done; echo released`;
  const calls = [
    { name: "bash", arguments: { command: wait, piuiTaskId: id } },
    { name: "bash", arguments: { command: "echo untagged" } },
  ];
  await browser.evaluate(
    async (text) => {
      await fetch("/api/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      return null;
    },
    `TOOLCALLS ${JSON.stringify(calls)}`,
  );

  await expect(screen.getByTestId(`task-${id}`)).toHaveAttribute("data-state", "working");
  await expect(screen.getByTestId(`task-${id}`)).toContainText("Working");
  // The row's badge says it; there is no separate "Working on …" line.
  await expect(screen.getByTestId("now-line")).toHaveCount(0);

  writeFileSync(release, "");

  // Wait for the turn to end, then check the ledger still remembers the tagged call.
  await expect
    .poll(() =>
      browser.evaluate(async (taskId) => {
        const ledger = (await (await fetch("/api/tasks")).json()) as {
          tasks: Array<{ id: string; lastWorkedAt?: string | null }>;
          activity?: { running: boolean };
        };
        const task = ledger.tasks.find((item) => item.id === taskId);
        return {
          running: ledger.activity?.running ?? null,
          lastWorkedAt: task?.lastWorkedAt ?? null,
        };
      }, id),
    )
    .toMatchObject({ running: false, lastWorkedAt: expect.any(String) });
  await expect(screen.getByTestId(`task-${id}`)).toHaveAttribute("data-state", "working");
  await expect(screen.getByTestId(`task-${id}`)).toContainText("Working");
  await expect(screen.getByTestId(`task-stale-${id}`)).toHaveCount(0);

  await screen.getByRole("button", { name: `Open ${title}` }).tap();
  await expect(screen.getByTestId("task-history")).toContainText("Run started");
  await expect(screen.getByTestId("task-history")).toContainText("Run ended");
  const runs = await browser.evaluate(
    () =>
      [...document.querySelectorAll('[data-testid="task-stats"] dd')].map(
        (node) => node.textContent,
      )[3] ?? null,
  );
  expect(runs).toBe("1");

  // Finishing the task is what clears the badge; the run ending did not.
  await screen.getByTestId("task-detail-status").tap();
  await expect(screen.getByTestId("task-state")).toHaveText("Done");
});
