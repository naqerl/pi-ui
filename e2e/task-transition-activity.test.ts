import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyTaskToolResult,
  OPTIMISTIC_ACTIVITY_ORDER,
  sameActivity,
} from "../src/shared/activity-optimistic.js";
import type { ActivityItem, ToolActivity } from "../src/shared/types.js";
import { mergeWindow } from "../src/shared/window.js";

function row(patch: Partial<ToolActivity> = {}): ToolActivity {
  return {
    kind: "tool",
    id: "a-12",
    name: "task_working",
    arguments: '{\n  "id": "task-1",\n  "note": "start"\n}',
    output: "task-1 working The task",
    isError: false,
    timestamp: "2026-11-01T12:00:01.000Z",
    order: 120_000,
    ...patch,
  };
}

function apply(patch: Partial<ToolActivity> = {}) {
  return applyTaskToolResult([], {
    toolCallId: "call-1",
    name: "task_working",
    isError: false,
    activity: row(patch),
    timestamp: "2026-11-01T12:00:00.000Z",
  });
}

test("applying a task_working result paints its activity row immediately", () => {
  const activity = apply();
  assert.equal(activity.length, 1);
  const item = activity[0];
  assert.equal(item?.kind, "tool");
  if (item?.kind !== "tool") return;
  assert.equal(item.name, "task_working");
  assert.equal(item.taskId, "task-1");
  assert.equal(item.toolCallId, "call-1");
  assert.equal(item.optimistic, true);
  assert.equal(item.order, OPTIMISTIC_ACTIVITY_ORDER);
  assert.equal(item.timestamp, "2026-11-01T12:00:00.000Z");
});

test("a snapshot older than the transition does not remove the optimistic row", () => {
  const activity = apply();
  const older: ActivityItem = row({
    id: "a-10",
    name: "bash",
    arguments: '{"command":"ls"}',
    output: "src",
    timestamp: "2026-11-01T11:59:00.000Z",
    order: 100_000,
  });
  const merged = mergeWindow(activity, 0, [older], sameActivity);
  assert.deepEqual(
    merged.map((item) => item.id),
    ["a-10", "a-12"],
  );
  const last = merged.at(-1);
  assert.equal(last?.kind === "tool" ? last.optimistic : undefined, true);
});

test("the server copy replaces the optimistic row by id without duplicating it", () => {
  const activity = apply();
  const server = row({ id: "a-12", order: 120_000, optimistic: undefined });
  const merged = mergeWindow(activity, 0, [server], sameActivity);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.id, "a-12");
  assert.equal(merged[0]?.kind === "tool" ? merged[0].optimistic : undefined, undefined);
});

test("a server copy with another id reconciles by task, tool and start", () => {
  const activity = apply({ id: "local-call-1", order: Number.MAX_SAFE_INTEGER });
  const server = row({
    id: "a-99",
    order: 990_000,
    timestamp: "2026-11-01T12:00:00.000Z",
    toolCallId: undefined,
    taskId: undefined,
    optimistic: undefined,
  });
  const merged = mergeWindow(activity, 0, [server], sameActivity);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.id, "a-99");
});

test("a failed task_working result removes the row it painted", () => {
  const activity = apply();
  const rejected = applyTaskToolResult(activity, {
    toolCallId: "call-1",
    name: "task_working",
    isError: true,
    activity: row({ isError: true }),
  });
  assert.deepEqual(rejected, []);
});

test("release and complete also paint their closing row at the result", () => {
  for (const name of ["task_release", "task_done"]) {
    const activity = applyTaskToolResult([], {
      toolCallId: `call-${name}`,
      name,
      isError: false,
      activity: row({ id: `a-${name}`, name }),
    });
    assert.equal(activity.length, 1, name);
    assert.equal(activity[0]?.kind === "tool" ? activity[0].name : "", name);
  }
});
