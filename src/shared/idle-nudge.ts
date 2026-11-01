import type { Task } from "./types.js";

/**
 * The browser-safe half of the idle nudge: wording and task selection. The
 * persisted record and the timer live in `src/server/idle-nudge.ts`, so the
 * client bundle never pulls in `node:` modules.
 */

/** Twenty minutes, the default idle period before an automated nudge. */
export const DEFAULT_IDLE_NUDGE_MS = 1_200_000;
/** The wording names the default window; it is what the user sees in the prompt. */
export const IDLE_NUDGE_MINUTES = 20;
/** The persisted record of the last task set that produced a nudge. */
export const IDLE_NUDGE_FILE = "idle-nudge.json";
/** A nudge never lists more than this many task ids. */
export const IDLE_NUDGE_TASK_LIMIT = 20;
/** A working task is asked for a status no more often than once an hour. */
export const IDLE_STATUS_INTERVAL_MS = 3_600_000;
/** An ignored task is left out of this many nudges before it is named again. */
export const IDLE_IGNORED_NUDGES = 3;

/** The task states the nudge understands, including the derived working state. */
export type IdleTaskStatus = Task["status"] | "working" | "blocked";
export type IdleTaskState = "open" | "working" | "blocked";

/** The fields the idle nudge needs from a task. */
export type IdleTask = {
  readonly id: string;
  readonly status: IdleTaskStatus;
  readonly blockedBy?: readonly string[];
  /** A derived client state, when the caller already has one. */
  readonly state?: IdleTaskState;
};

function taskState(task: IdleTask): IdleTaskStatus {
  if (task.status === "working" || task.state === "working") return "working";
  if (task.status === "blocked" || task.state === "blocked") return "blocked";
  if (task.status === "open") return "open";
  return task.status;
}

/**
 * The idle period from `PI_IDLE_NUDGE_MS`. Zero disables nudges; a missing or
 * invalid value keeps the twenty-minute default.
 */
export function idleNudgeMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PI_IDLE_NUDGE_MS;
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_IDLE_NUDGE_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_IDLE_NUDGE_MS;
  return Math.floor(value);
}

/**
 * Open tasks that are ready to pick. A blocker blocks only while it is itself
 * open; a done, proposed, or missing blocker id is no longer a gate.
 */
export function openTaskIds(tasks: readonly IdleTask[]): string[] {
  const live = new Set(
    tasks
      .filter((task) => {
        const state = taskState(task);
        return state === "open" || state === "working";
      })
      .map((task) => task.id),
  );
  return tasks
    .filter((task) => taskState(task) === "open")
    .filter((task) => !(task.blockedBy ?? []).some((id) => live.has(id)))
    .map((task) => task.id);
}

/** Tasks the agent has started and not finished; they are asked for a status. */
export function workingTaskIds(tasks: readonly IdleTask[]): string[] {
  const live = liveOpenIds(tasks);
  return tasks
    .filter((task) => taskState(task) === "working")
    .filter((task) => !(task.blockedBy ?? []).some((id) => live.has(id)))
    .map((task) => task.id);
}

function liveOpenIds(tasks: readonly IdleTask[]): Set<string> {
  return new Set(
    tasks
      .filter((task) => {
        const state = taskState(task);
        return state === "open" || state === "working";
      })
      .map((task) => task.id),
  );
}

/** A task-id to open-blocker-ids map that also offers the familiar Map accessors. */
export type WaitingOn = Record<string, string[]> & {
  readonly size: number;
  get(taskId: string): string[] | undefined;
  has(taskId: string): boolean;
  entries(): IterableIterator<[string, string[]]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string[]>;
  [Symbol.iterator](): IterableIterator<[string, string[]]>;
};

/**
 * For each open task that still has open blockers, the ids of those blockers.
 * Missing, done and proposed blocker ids are not waiting on anything.
 */
export function waitingOn(tasks: readonly IdleTask[]): WaitingOn {
  const live = liveOpenIds(tasks);
  const out = {} as WaitingOn;
  for (const task of tasks) {
    if (taskState(task) !== "open") continue;
    const blockers = (task.blockedBy ?? []).filter((id) => live.has(id));
    if (blockers.length > 0) out[task.id] = [...new Set(blockers)];
  }
  Object.defineProperties(out, {
    size: { get: () => Object.keys(out).length },
    get: { value: (taskId: string) => out[taskId] },
    has: { value: (taskId: string) => Object.hasOwn(out, taskId) },
    entries: { value: () => Object.entries(out)[Symbol.iterator]() },
    keys: { value: () => Object.keys(out)[Symbol.iterator]() },
    values: { value: () => Object.values(out)[Symbol.iterator]() },
    [Symbol.iterator]: { value: () => Object.entries(out)[Symbol.iterator]() },
  });
  return out;
}

function capped(ids: readonly string[]): string[] {
  return ids.slice(0, IDLE_NUDGE_TASK_LIMIT);
}

/** The work list asks every named task for one of three decisions. */
function idleWorkText(taskIds: readonly string[], totalOpen = taskIds.length): string {
  const ids = capped(taskIds);
  return `You have been idle for ${IDLE_NUDGE_MINUTES} minutes and ${totalOpen} task(s) are open: ${ids.join(", ")}. Mark a task working with the task tool before starting it; if it cannot be done now, mark it blocked and propose_task the task that would unblock it; if other tasks are already in progress, leave it alone — ignoring it is a valid answer.`;
}

/** Working tasks get a status question instead of being offered as new work. */
function idleWorkingText(taskIds: readonly string[], withIdlePrefix: boolean): string {
  const ids = capped(taskIds);
  const prefix = withIdlePrefix ? `You have been idle for ${IDLE_NUDGE_MINUTES} minutes. ` : "";
  return `${prefix}Status check for tasks marked working: ${ids.join(", ")}. Mark each complete with task_done, mark it blocked and propose_task what would unblock it, or leave it alone — ignoring it is a valid answer.`;
}

/** The one-paragraph decision notice, with work and status names capped together. */
export function idleDecisionNudgeText(
  openIds: readonly string[],
  workingIds: readonly string[] = [],
  totalOpen = openIds.length,
): string {
  const visibleOpen = capped(openIds);
  const room = Math.max(0, IDLE_NUDGE_TASK_LIMIT - visibleOpen.length);
  const working = workingIds.slice(0, room);
  if (openIds.length === 0 && working.length > 0) {
    return idleWorkingText(working, true);
  }
  if (openIds.length === 0) return idleWorkText(openIds, totalOpen);
  const work = idleWorkText(visibleOpen, totalOpen);
  if (working.length === 0) return work;
  return `${work} Status check for tasks marked working: ${working.join(", ")}. Mark each complete with task_done, mark it blocked and propose_task what would unblock it, or leave it alone — ignoring it is a valid answer.`;
}

/** The prompt sent as an automated notice; it is also its transcript text. */
export function idleNudgeText(
  taskIdsOrTasks: readonly string[] | readonly IdleTask[] | WaitingOn,
  waiting?: WaitingOn,
): string {
  let taskIds: readonly string[];
  let workingIds: readonly string[] = [];
  let blocked: WaitingOn | undefined;
  if (Array.isArray(taskIdsOrTasks)) {
    const items: readonly unknown[] = taskIdsOrTasks;
    if (items.every((item): item is string => typeof item === "string")) {
      taskIds = items;
      blocked = waiting;
    } else {
      const tasks = items as readonly IdleTask[];
      taskIds = openTaskIds(tasks);
      workingIds = workingTaskIds(tasks);
      blocked = waitingOn(tasks);
    }
  } else {
    taskIds = [];
    blocked = taskIdsOrTasks as WaitingOn;
  }
  if (taskIds.length === 0 && workingIds.length > 0) {
    return idleDecisionNudgeText(taskIds, workingIds);
  }
  if (taskIds.length === 0 && blocked !== undefined && Object.keys(blocked).length > 0) {
    return idleBlockedNudgeText(blocked);
  }
  return idleDecisionNudgeText(taskIds, workingIds);
}

/** The notice used when the open work exists but every task is still blocked. */
export function idleBlockedNudgeText(waiting: WaitingOn): string {
  const detail = Object.keys(waiting)
    .map((taskId) => [taskId, waiting[taskId]] as const)
    .filter(([, blockers]) => (blockers?.length ?? 0) > 0)
    .map(([taskId, blockers]) => `${taskId} waits on ${(blockers ?? []).join(", ")}`)
    .join("; ");
  return `You have been idle for ${IDLE_NUDGE_MINUTES} minutes. Nothing is unblocked: ${detail}.`;
}

/** The same blocked notice under the names callers use in prose. */
export const blockedNudgeText = idleBlockedNudgeText;
export const idleNudgeBlockedText = idleBlockedNudgeText;
