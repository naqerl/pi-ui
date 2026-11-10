import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isStaleWorking,
  STALE_WORKING_MS,
  subtaskCount,
  taskState,
  WORKING_WINDOW_MS,
} from "../src/shared/task-status.js";
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
  return { now: NOW, running: false, runId: null, traces: {}, ...patch };
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

test("working follows a live run until it reaches a terminal outcome", () => {
  const a = task("a");
  const recent = new Date(Date.parse(NOW) - 60_000).toISOString();
  const stale = new Date(Date.parse(NOW) - 6 * 60 * 60_000).toISOString();
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
  // A live run with no recent tool call keeps working; only a terminal outcome clears it.
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
    "working",
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

test("a tagged task keeps working after the run, and is stale after an hour", () => {
  const at = Date.parse(NOW);
  const worked = new Date(at - 2 * 60 * 60_000).toISOString();
  const a = task("a", { lastWorkedAt: worked });
  assert.equal(taskState([a], a, undefined), "working", "the ledger keeps the badge");
  assert.equal(taskState([a], a, activity()), "working", "an idle view keeps it too");
  assert.equal(isStaleWorking(a, activity()), true);
  assert.equal(isStaleWorking(a, activity({ now: worked })), false, "not yet an hour old");

  const recent = task("a", { lastWorkedAt: new Date(at - 60_000).toISOString() });
  assert.equal(isStaleWorking(recent, activity()), false);
  const traced = activity({
    traces: {
      a: trace({ lastActivityAt: new Date(at - 60_000).toISOString() }),
    },
  });
  assert.equal(isStaleWorking(a, traced), false, "a newer tagged trace is still activity");

  const persisted = task("a", {
    status: "working",
    workingSince: worked,
    lastWorkedAt: new Date(at - 60_000).toISOString(),
  });
  assert.equal(isStaleWorking(persisted, activity()), false, "a newer tagged call clears stale");
  const persistedTraced = task("a", { status: "working", workingSince: worked });
  assert.equal(isStaleWorking(persistedTraced, traced), false, "newer trace activity clears stale");
  const persistedIdle = task("a", { status: "working", workingSince: worked });
  assert.equal(isStaleWorking(persistedIdle, activity()), true);

  const closed = task("a", { status: "done", lastWorkedAt: worked });
  assert.equal(taskState([closed], closed, activity()), "done");
  assert.equal(isStaleWorking(closed, activity()), false);

  const blocker = task("b", { lastWorkedAt: worked });
  const blocked = task("a", { lastWorkedAt: worked, blockedBy: ["b"] });
  assert.equal(taskState([blocked, blocker], blocked, activity()), "blocked");
});

test("a released task is ready even when a late attributed call stamped it", () => {
  const at = Date.parse(NOW);
  const releasedAt = new Date(at - 2 * 60 * 60_000).toISOString();
  const lastWorkedAt = new Date(Date.parse(releasedAt) + 2).toISOString();
  const released = task("a", {
    releasedAt,
    releaseReason: "Waiting for capacity",
    lastWorkedAt,
    workingSince: releasedAt,
  });
  const live = activity({
    running: true,
    runId: "r1",
    traces: {
      a: trace({
        lastActivityAt: lastWorkedAt,
        lastRun: { id: "r1", outcome: "running", at: NOW },
      }),
    },
  });

  assert.equal(taskState([released], released, activity()), "ready");
  assert.equal(taskState([released], released, live), "ready", "release outranks an old trace");
  assert.equal(isStaleWorking(released, activity()), false);
  assert.equal(isStaleWorking(released, live), false);
});

test("a restart keeps working from lastWorkedAt even when its old run is interrupted", () => {
  const at = Date.parse(NOW);
  const lastWorkedAt = new Date(at - 2 * 60 * 60_000).toISOString();
  const a = task("a", { lastWorkedAt });
  const restarted = activity({
    traces: {
      a: trace({
        lastActivityAt: lastWorkedAt,
        lastRun: { id: "old", outcome: "interrupted", at: NOW, reason: "pi-ui restarted mid-run" },
      }),
    },
  });
  assert.equal(taskState([a], a, restarted), "working");
  assert.equal(isStaleWorking(a, restarted), true);
  assert.ok(STALE_WORKING_MS > WORKING_WINDOW_MS);
});
