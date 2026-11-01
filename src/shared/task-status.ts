import { descendantIds, liveBlockerIds } from "./tasks.js";
import type { Task, TaskActivity, TaskState } from "./types.js";

/** A task counts as working while its last tagged call in the live run is this recent. */
export const WORKING_WINDOW_MS = 10 * 60_000;

/** After an hour without a tagged call, a working task is shown as stale as well. */
export const STALE_WORKING_MS = 60 * 60_000;

function nowOf(activity: TaskActivity | undefined): number {
  const parsed = activity === undefined ? Number.NaN : Date.parse(activity.now);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function instant(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * The newest tagged call recorded for a task: the ledger's `lastWorkedAt`, or a live trace
 * when it is fresher. The trace also covers views from before the ledger remembered the time.
 */
export function lastWorkedAtMs(task: Task, activity: TaskActivity | undefined): number | null {
  let newest = instant(task.lastWorkedAt);
  const traced = instant(activity?.traces[task.id]?.lastActivityAt);
  if (traced !== null && (newest === null || traced > newest)) newest = traced;
  return newest;
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
 * True when an open task carries the working badge but nothing has touched it for over an
 * hour. The marker never replaces `working`; done and proposed tasks are never stale.
 */
export function isStaleWorking(
  task: Task,
  activity: TaskActivity | undefined,
  at: number = nowOf(activity),
): boolean {
  if (task.status !== "open") return false;
  const last = lastWorkedAtMs(task, activity);
  return last !== null && at - last > STALE_WORKING_MS;
}

/**
 * The one state a task shows. Ledger facts (proposed, done, a live blocker) win; then a task
 * keeps its working badge once it has been tagged, even after the run ends; live activity only
 * animates it. A failed run or a parent with some finished subtasks follows, and anything else
 * is ready.
 */
export function taskState(
  tasks: readonly Task[],
  task: Task,
  activity: TaskActivity | undefined,
): TaskState {
  if (task.status === "proposed") return "proposed";
  if (task.status === "done") return "done";
  if (isWorking(task, activity)) return "working";
  if (task.lastWorkedAt !== undefined && task.lastWorkedAt !== null) {
    // A live blocker is still ledger truth, even for work that was tagged before it appeared.
    if (liveBlockerIds(tasks, task).length > 0) return "blocked";
    return "working";
  }
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
