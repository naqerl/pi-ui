import { descendantIds, liveBlockerIds } from "./tasks.js";
import type { Task, TaskActivity, TaskState } from "./types.js";

/** A task counts as working while its last tagged call in the live run is this recent. */
export const WORKING_WINDOW_MS = 10 * 60_000;

function nowOf(activity: TaskActivity | undefined): number {
  const parsed = activity === undefined ? Number.NaN : Date.parse(activity.now);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** True when the live run tagged a tool call with this task recently. */
export function isWorking(task: Task, activity: TaskActivity | undefined): boolean {
  if (activity === undefined || !activity.running || activity.runId === null) return false;
  const trace = activity.traces[task.id];
  if (trace?.lastRun == null || trace.lastActivityAt === null) return false;
  if (trace.lastRun.id !== activity.runId || trace.lastRun.outcome !== "running") return false;
  const last = Date.parse(trace.lastActivityAt);
  return Number.isFinite(last) && nowOf(activity) - last <= WORKING_WINDOW_MS;
}

/** True when the run that last touched the task errored or was interrupted. */
export function isFailed(task: Task, activity: TaskActivity | undefined): boolean {
  const outcome = activity?.traces[task.id]?.lastRun?.outcome;
  return outcome === "error" || outcome === "interrupted";
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
