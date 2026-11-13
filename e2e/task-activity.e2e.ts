import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { chooseTaskAction } from "./tasks-helpers";

// A call belongs to the one task marked working, never to a per-call tag; its measurements stay
// on that task after the run ends, and the badge survives the turn.
test("tool calls made while one task is working are charged to it", async ({
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

  const working = await browser.evaluate(async (taskId) => {
    const response = await fetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "working" }),
    });
    return response.ok;
  }, id ?? "");
  expect(working).toBe(true);

  // The call waits until the test has looked, however slow the machine.
  const release = join(tmpdir(), `pi-ui-task-activity-${tag}-${randomUUID()}`);
  const wait = `for i in $(seq 600); do [ -e '${release}' ] && break; sleep 0.1; done; echo released`;
  const calls = [
    { name: "bash", arguments: { command: wait } },
    { name: "bash", arguments: { command: "echo also charged" } },
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

  // Wait for the turn to end, then check the ledger still remembers both attributed calls.
  await expect
    .poll(() =>
      browser.evaluate(async (taskId: string) => {
        const ledger = (await (await fetch("/api/tasks")).json()) as {
          tasks: Array<{ id: string; lastWorkedAt?: string | null }>;
          activity?: {
            running: boolean;
            traces: Record<string, { measured?: { runs: number; calls: number } }>;
          };
        };
        const task = ledger.tasks.find((item) => item.id === taskId);
        return {
          running: ledger.activity?.running ?? null,
          lastWorkedAt: task?.lastWorkedAt ?? null,
          runs: ledger.activity?.traces[taskId]?.measured?.runs ?? null,
          calls: ledger.activity?.traces[taskId]?.measured?.calls ?? null,
        };
      }, id ?? ""),
    )
    .toMatchObject({ running: false, lastWorkedAt: expect.any(String), runs: 1, calls: 2 });
  await expect(screen.getByTestId(`task-${id}`)).toHaveAttribute("data-state", "working");
  await expect(screen.getByTestId(`task-${id}`)).toContainText("Working");
  await expect(screen.getByTestId(`task-stale-${id}`)).toHaveCount(0);

  await screen.getByRole("button", { name: `Open ${title}` }).tap();
  await expect(screen.getByTestId("task-history")).toHaveCount(0);
  await expect(screen.getByTestId("task-detail")).not.toContainText("Run started");

  // Finishing the task is what clears the badge; the run ending did not.
  await chooseTaskAction(screen, "task-detail-status");
  await expect(screen.getByTestId("task-state")).toHaveText("Done");
});

// A task tool result paints its row now; stale snapshots and the run ending must not take
// it away, and the closing row arrives with the status change rather than one snapshot later.
test("a task transition shows its activity row as soon as the card changes", async ({
  app,
  browser,
  screen,
}) => {
  await browser.addInitScript(() => {
    if (!("serviceWorker" in navigator)) return;
    Object.defineProperty(navigator.serviceWorker, "register", {
      configurable: true,
      value: async () => undefined,
    });
  });
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks");
  const tag = Date.now();
  const title = `Transition activity ${tag}`;
  const id = await browser.evaluate(async (name) => {
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: name }),
    });
    const ledger = (await response.json()) as { tasks: Array<{ id: string; title: string }> };
    return ledger.tasks.find((task) => task.title === name)?.id ?? "";
  }, title);
  expect(id).not.toBe("");
  const card = screen.getByTestId(`task-${id}`);
  await expect(card).toBeVisible();

  // Keep the pre-transition snapshot alive. A refresh that lands after the tool result must
  // not erase the row, and the row may not wait for a newer snapshot to appear.
  const stale = await browser.evaluate(() =>
    fetch("/api/state", { cache: "no-store" }).then((response) => response.json()),
  );
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: stale });
  });

  try {
    await browser.evaluate(
      async (args) => {
        await fetch("/api/message", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: `TOOLCALLS ${JSON.stringify([
              { name: "task_working", arguments: { id: args.id, note: "e2e transition" } },
            ])}`,
          }),
        });
        return null;
      },
      { id },
    );

    await expect(card).toHaveAttribute("data-state", "working");
    await screen.getByRole("tab", "Chat").tap();
    const info = screen.getByTestId("run-info");
    await expect(info).toBeVisible();
    await info.tap();
    await expect(screen.getByTestId("activity-dialog")).toBeVisible();
    // Both facts hold in this window, with no reload and a snapshot that predates the change.
    await expect(
      screen.getByTestId("activity-row").filter({ hasText: "task_working" }),
    ).toBeVisible();
    await expect(card).toHaveAttribute("data-state", "working");

    await browser.evaluate(
      async (args) => {
        await fetch("/api/message", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            text: `TOOLCALLS ${JSON.stringify([
              {
                name: "task_done",
                arguments: { id: args.id, evidence: "e2e/task-activity.e2e.ts" },
              },
            ])}`,
          }),
        });
        return null;
      },
      { id },
    );

    await expect(card).toHaveAttribute("data-state", "done");
    // The closing row is already in the next run's summary, before any newer snapshot.
    const latestInfo = browser.locator('[data-testid="run-info"]').last();
    await expect(latestInfo).toHaveAttribute("aria-label", /^Run activity: 2 tool calls/);
    await expect(card).toHaveAttribute("data-state", "done");

    await screen.getByTestId("activity-dialog-close").tap();
    await expect(screen.getByTestId("activity-dialog")).toHaveCount(0);
    await latestInfo.tap();
    await expect(screen.getByTestId("activity-dialog")).toBeVisible();
    await expect(screen.getByTestId("activity-row").filter({ hasText: "task_done" })).toBeVisible();
    await expect(card).toHaveAttribute("data-state", "done");
  } finally {
    await browser.unrouteAll();
    await browser.evaluate(async (taskId) => {
      await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });
      return null;
    }, id);
  }
});
