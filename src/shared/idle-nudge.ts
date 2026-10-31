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

/** The fields the idle nudge needs from a task. */
export type IdleTask = Pick<Task, "id" | "status"> & {
  readonly blockedBy?: readonly string[];
};

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
  const open = new Set(tasks.filter((task) => task.status === "open").map((task) => task.id));
  return tasks
    .filter((task) => task.status === "open")
    .filter((task) => !(task.blockedBy ?? []).some((id) => open.has(id)))
    .map((task) => task.id);
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
  const open = new Set(tasks.filter((task) => task.status === "open").map((task) => task.id));
  const out = {} as WaitingOn;
  for (const task of tasks) {
    if (task.status !== "open") continue;
    const blockers = (task.blockedBy ?? []).filter((id) => open.has(id));
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

/** The prompt sent as an automated notice; it is also its transcript text. */
export function idleNudgeText(
  taskIdsOrTasks: readonly string[] | readonly IdleTask[] | WaitingOn,
  waiting?: WaitingOn,
): string {
  let taskIds: readonly string[];
  let blocked: WaitingOn | undefined;
  if (Array.isArray(taskIdsOrTasks)) {
    const items: readonly unknown[] = taskIdsOrTasks;
    if (items.every((item): item is string => typeof item === "string")) {
      taskIds = items;
      blocked = waiting;
    } else {
      const tasks = items as readonly IdleTask[];
      taskIds = openTaskIds(tasks);
      blocked = waitingOn(tasks);
    }
  } else {
    taskIds = [];
    blocked = taskIdsOrTasks as WaitingOn;
  }
  if (taskIds.length === 0 && blocked !== undefined && Object.keys(blocked).length > 0) {
    return idleBlockedNudgeText(blocked);
  }
  return `You have been idle for ${IDLE_NUDGE_MINUTES} minutes and ${taskIds.length} task(s) are open: ${taskIds.join(", ")}. Pick the next one and implement it.`;
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
