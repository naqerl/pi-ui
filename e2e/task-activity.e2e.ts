import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";

// A task is working because a live run calls tools tagged with its id, never because the agent
// said so; calls without a tag still show, as untracked work.
test("tagged tool calls show a task as working, untagged ones as untracked work", async ({
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
  const idle = screen.getByTestId("now-card");
  await expect(idle).toHaveAttribute("data-running", "false");

  // The tagged call waits until the test has looked, however slow the machine.
  const release = join(tmpdir(), `pi-ui-task-activity-${tag}`);
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
  await expect(screen.getByTestId(`now-task-${id}`)).toBeVisible();
  await expect(screen.getByTestId("now-card")).toHaveAttribute("data-running", "true");
  await expect(screen.getByTestId("now-untracked")).toContainText("1 call · last bash");

  writeFileSync(release, "");
  await expect(screen.getByTestId("now-card")).toHaveAttribute("data-running", "false");
  await expect(screen.getByTestId(`task-${id}`)).toHaveAttribute("data-state", "ready");
  await expect(screen.getByTestId("now-untracked")).toHaveCount(0);

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
});
