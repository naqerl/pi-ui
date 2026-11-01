import { descendantIds, liveBlockerIds } from "./tasks.js";
import type { Task, TaskActivity, TaskState, TaskTrace } from "./types.js";

/** Kept for callers that still name the old recency window; working now lasts until the run ends. */
export const WORKING_WINDOW_MS = 10 * 60_000;

/** True when the trace says its run has not reached a terminal outcome yet. */
function runIsLive(trace: TaskTrace | undefined): boolean {
  return trace?.lastRun?.outcome === "running";
}

/** True when the trace records a terminal run, so a badge may clear. */
export function runIsTerminal(trace: TaskTrace | undefined): boolean {
  const outcome = trace?.lastRun?.outcome;
  return outcome === "ok" || outcome === "error" || outcome === "interrupted";
}

/**
 * True when a task was touched by a run that has not ended. A later snapshot that omits
 * the activity (or carries the same non-terminal run) must not clear the badge; only the
 * task closing or a terminal outcome does.
 */
export function isWorking(task: Task, activity: TaskActivity | undefined): boolean {
  if (task.status !== "open" || activity === undefined) return false;
  const trace = activity.traces[task.id];
  if (!runIsLive(trace)) return false;
  // Another run being live means this task belongs to an older run, not the current one.
  if (activity.running && activity.runId !== null) {
    return trace?.lastRun?.id === activity.runId;
  }
  // No terminal event has arrived for the run that touched the task.
  return true;
}

/** True when the run that last touched the task errored or was interrupted. */
export function isFailed(task: Task, activity: TaskActivity | undefined): boolean {
  const outcome = activity?.traces[task.id]?.lastRun?.outcome;
  return outcome === "error" || outcome === "interrupted";
}

/**
 * Carries a task's working trace across a snapshot that omits it, so a badge already shown
 * stays until the task closes or the snapshot reports a terminal run for it.
 */
export function carryWorkingTraces(
  previous: TaskActivity | undefined,
  next: TaskActivity | undefined,
  tasks: readonly Task[],
): TaskActivity | undefined {
  if (next === undefined) return previous;
  if (previous === undefined) return next;
  const open = new Set(tasks.filter((task) => task.status === "open").map((task) => task.id));
  const traces = { ...next.traces };
  for (const [id, trace] of Object.entries(previous.traces)) {
    if (!open.has(id) || !runIsLive(trace)) continue;
    const current = traces[id];
    if (runIsTerminal(current)) continue;
    if (runIsLive(current)) continue;
    traces[id] = trace;
  }
  return { ...next, traces };
}

/**
 * The one state a task shows. Ledger facts (proposed, done) win; then what runs measured
 * (working beats everything open, a failed run beats blockers); then blockers; then a parent
 * with some finished subtasks is partial; anything else is ready.
 */
export function taskState(
  tasks: readonly Task[],
  task: Task,
  activity: TaskActivity | undefined,
): TaskState {
  if (task.status === "proposed") return "proposed";
  if (task.status === "done") return "done";
  if (isWorking(task, activity)) return "working";
  if (isFailed(task, activity)) return "failed";
  if (liveBlockerIds(tasks, task).length > 0) return "blocked";
  const below = descendantIds(tasks, task.id);
  if (below.size > 0 && tasks.some((item) => below.has(item.id) && item.status === "done")) {
    return "partial";
  }
  return "ready";
}

/** Done and total direct subtasks, for a parent's row meta. */
export function subtaskCount(tasks: readonly Task[], id: string): { done: number; total: number } {
  const children = tasks.filter((task) => task.parentId === id && task.status !== "proposed");
  return {
    done: children.filter((task) => task.status === "done").length,
    total: children.length,
  };
}
