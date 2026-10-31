import assert from "node:assert/strict";
import { test } from "node:test";
import { subtaskCount, taskState, WORKING_WINDOW_MS } from "../src/shared/task-status.js";
import type { Task, TaskActivity, TaskTrace } from "../src/shared/types.js";

const NOW = "2026-10-31T12:00:00.000Z";

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    status: "open",
    parentId: null,
    blockedBy: [],
    createdAt: "2026-10-31T10:00:00.000Z",
    completedAt: null,
    completion: null,
    ...patch,
  };
}

function trace(patch: Partial<TaskTrace> = {}): TaskTrace {
  return {
    lastActivityAt: null,
    lastRun: null,
    measured: { runs: 0, calls: 0, activeMs: 0, tokens: 0, cost: 0 },
    history: [],
    ...patch,
  };
}

function activity(patch: Partial<TaskActivity> = {}): TaskActivity {
  return { now: NOW, running: false, runId: null, traces: {}, untracked: null, ...patch };
}

test("ledger facts: proposed and done win over anything measured", () => {
  const live = activity({
    running: true,
    runId: "r1",
    traces: {
      p: trace({ lastActivityAt: NOW, lastRun: { id: "r1", outcome: "running", at: NOW } }),
      d: trace({ lastActivityAt: NOW, lastRun: { id: "r1", outcome: "error", at: NOW } }),
    },
  });
  const tasks = [task("p", { status: "proposed" }), task("d", { status: "done" })];
  assert.equal(taskState(tasks, tasks[0] as Task, live), "proposed");
  assert.equal(taskState(tasks, tasks[1] as Task, live), "done");
});

test("working needs a live run with a recent call tagged with the task", () => {
  const a = task("a");
  const recent = new Date(Date.parse(NOW) - 60_000).toISOString();
  const stale = new Date(Date.parse(NOW) - WORKING_WINDOW_MS - 1).toISOString();
  const running = { id: "r1", outcome: "running" as const, at: recent };
  assert.equal(
    taskState(
      [a],
      a,
      activity({
        running: true,
        runId: "r1",
        traces: { a: trace({ lastActivityAt: recent, lastRun: running }) },
      }),
    ),
    "working",
  );
  // Same trace, but the run is over: not working, and nothing failed, so ready.
  assert.equal(
    taskState(
      [a],
      a,
      activity({
        traces: { a: trace({ lastActivityAt: recent, lastRun: { ...running, outcome: "ok" } }) },
      }),
    ),
    "ready",
  );
  // A live run that has not touched the task for a while does not keep it working.
  assert.equal(
    taskState(
      [a],
      a,
      activity({
        running: true,
        runId: "r1",
        traces: { a: trace({ lastActivityAt: stale, lastRun: running }) },
      }),
    ),
    "ready",
  );
  // Another run is live; this task was touched by an older one.
  assert.equal(
    taskState(
      [a],
      a,
      activity({
        running: true,
        runId: "r2",
        traces: { a: trace({ lastActivityAt: recent, lastRun: running }) },
      }),
    ),
    "ready",
  );
  // Without any activity view there is nothing to measure.
  assert.equal(taskState([a], a, undefined), "ready");
});

test("failed follows the run that last touched the task, and a new run clears it", () => {
  const a = task("a");
  const failed = activity({
    traces: {
      a: trace({
        lastActivityAt: NOW,
        lastRun: { id: "r1", outcome: "error", at: NOW, reason: "boom" },
      }),
    },
  });
  assert.equal(taskState([a], a, failed), "failed");
  const interrupted = activity({
    traces: {
      a: trace({ lastActivityAt: NOW, lastRun: { id: "r1", outcome: "interrupted", at: NOW } }),
    },
  });
  assert.equal(taskState([a], a, interrupted), "failed");
  const retried = activity({
    running: true,
    runId: "r2",
    traces: {
      a: trace({ lastActivityAt: NOW, lastRun: { id: "r2", outcome: "running", at: NOW } }),
    },
  });
  assert.equal(taskState([a], a, retried), "working");
});

test("blocked only by open blockers, and a failed run outranks a blocker", () => {
  const blocker = task("b");
  const a = task("a", { blockedBy: ["b"] });
  assert.equal(taskState([a, blocker], a, activity()), "blocked");
  const closed = task("b", { status: "done" });
  assert.equal(taskState([a, closed], a, activity()), "ready");
  const failed = activity({
    traces: { a: trace({ lastRun: { id: "r1", outcome: "error", at: NOW } }) },
  });
  assert.equal(taskState([a, blocker], a, failed), "failed");
});

test("a parent with some finished subtasks is partial and counts its children", () => {
  const parent = task("p");
  const one = task("c1", { parentId: "p", status: "done" });
  const two = task("c2", { parentId: "p" });
  const three = task("c3", { parentId: "p" });
  const tasks = [parent, one, two, three];
  assert.equal(taskState(tasks, parent, activity()), "partial");
  assert.deepEqual(subtaskCount(tasks, "p"), { done: 1, total: 3 });
  assert.equal(taskState([parent, two, three], parent, activity()), "ready");
});
