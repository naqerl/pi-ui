import assert from "node:assert/strict";
import { test } from "node:test";
import { indexTasks } from "../src/shared/task-index.js";
import { taskState } from "../src/shared/task-status.js";
import { compareTasks, liveBlockerIds } from "../src/shared/tasks.js";
import type { Task, TaskActivity } from "../src/shared/types.js";

test("indexed facts preserve every existing state and ordering, including Working quirks", () => {
  let seed = 137;
  const random = (n: number) => {
    seed = (seed * 16807) % 2147483647;
    return seed % n;
  };
  const statuses = ["open", "working", "done", "proposed", "backlog"] as const;
  for (let iteration = 0; iteration < 30; iteration++) {
    const tasks: Task[] = Array.from({ length: 100 }, (_, i) => ({
      id: `t${i}`,
      title: `Task ${i}`,
      status: statuses[random(statuses.length)] ?? "open",
      parentId: random(3) === 0 ? null : `t${random(100)}`,
      blockedBy: [`t${random(100)}`, `t${random(100)}`],
      createdAt: `2026-01-01T00:00:${String(random(60)).padStart(2, "0")}Z`,
      completedAt: null,
      completion: null,
      ...(random(2) === 0 ? { lastWorkedAt: "2026-01-01T00:00:00Z" } : {}),
    }));
    const activity: TaskActivity = {
      running: true,
      runId: "r1",
      now: "2026-01-02T00:00:00Z",
      traces: {},
    };
    const index = indexTasks(tasks);
    for (const task of tasks) {
      assert.equal(taskState(tasks, task, activity, index), taskState(tasks, task, activity));
      assert.deepEqual(index.blockers.get(task.id), liveBlockerIds(tasks, task));
    }
    assert.deepEqual(
      [...tasks].sort(index.compare),
      [...tasks].sort((a, b) => compareTasks(tasks, a, b)),
    );
  }
});
