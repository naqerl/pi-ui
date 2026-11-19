import type { TaskIndex } from "./task-index.js";
import { descendantIds, isActiveStatus, isReleasedTask, liveBlockerIds } from "./tasks.js";
import type { Task, TaskActivity, TaskState, TaskTrace } from "./types.js";

export const WORKING_WINDOW_MS = 10 * 60_000;

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

export function lastWorkedAtMs(task: Task, activity: TaskActivity | undefined): number | null {
  let newest = instant(task.lastWorkedAt);
  const traced = instant(activity?.traces[task.id]?.lastActivityAt);
  if (traced !== null && (newest === null || traced > newest)) newest = traced;
  return newest;
}

function runIsLive(trace: TaskTrace | undefined): boolean {
  return trace?.lastRun?.outcome === "running";
}

export function runIsTerminal(trace: TaskTrace | undefined): boolean {
  const outcome = trace?.lastRun?.outcome;
  return outcome === "ok" || outcome === "error" || outcome === "interrupted";
}

export function isWorking(task: Task, activity: TaskActivity | undefined): boolean {
  if (task.status !== "open" || activity === undefined) return false;
  const trace = activity.traces[task.id];
  if (!runIsLive(trace)) return false;
  if (activity.running && activity.runId !== null) {
    return trace?.lastRun?.id === activity.runId;
  }
  return true;
}

export function isFailed(task: Task, activity: TaskActivity | undefined): boolean {
  const outcome = activity?.traces[task.id]?.lastRun?.outcome;
  return outcome === "error" || outcome === "interrupted";
}

export function isStaleWorking(
  task: Task,
  activity: TaskActivity | undefined,
  at: number = nowOf(activity),
): boolean {
  if (!isActiveStatus(task.status)) return false;
  if (isReleasedTask(task)) return false;
  const marked = instant(task.workingSince);
  const touched = lastWorkedAtMs(task, activity);
  const last = marked === null ? touched : touched === null ? marked : Math.max(marked, touched);
  return last !== null && at - last > STALE_WORKING_MS;
}

export function carryWorkingTraces(
  previous: TaskActivity | undefined,
  next: TaskActivity | undefined,
  tasks: readonly Task[],
): TaskActivity | undefined {
  if (next === undefined) return previous;
  if (previous === undefined) return next;
  const open = new Set(tasks.filter((task) => isActiveStatus(task.status)).map((task) => task.id));
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

export function taskState(
  tasks: readonly Task[],
  task: Task,
  activity: TaskActivity | undefined,
  index?: TaskIndex,
): TaskState {
  if (task.status === "proposed") return "proposed";
  if (task.status === "planning") return "planning";
  if (task.status === "backlog") return "backlog";
  if (task.status === "done") return "done";
  if (task.status === "working") return "working";
  if (!isReleasedTask(task)) {
    if (isWorking(task, activity)) return "working";
    if (task.lastWorkedAt !== undefined && task.lastWorkedAt !== null) {
      if (
        (index === undefined ? liveBlockerIds(tasks, task) : (index.blockers.get(task.id) ?? []))
          .length > 0
      )
        return "blocked";
      return "working";
    }
  }
  if (isFailed(task, activity)) return "failed";
  if (
    (index === undefined ? liveBlockerIds(tasks, task) : (index.blockers.get(task.id) ?? []))
      .length > 0
  )
    return "blocked";
  if (index !== undefined) {
    if (index.doneBelow.has(task.id)) return "partial";
  } else {
    const below = descendantIds(tasks, task.id);
    if (below.size > 0 && tasks.some((item) => below.has(item.id) && item.status === "done"))
      return "partial";
  }
  return "ready";
}

export function subtaskCount(tasks: readonly Task[], id: string): { done: number; total: number } {
  const children = tasks.filter((task) => task.parentId === id && task.status !== "proposed");
  return {
    done: children.filter((task) => task.status === "done").length,
    total: children.length,
  };
}
