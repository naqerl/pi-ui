import type { Task, TaskActivity } from "./types.js";

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

/** One hour; a live run with no tool call for this long gets a status nudge. */
export const STALE_RUN_NUDGE_MS = 3_600_000;
/** The wording names the stale-run window; it is what the user sees in the prompt. */
export const STALE_RUN_NUDGE_MINUTES = 60;
/** The persisted record of the last stale-run nudge for each task. */
export const STALE_RUN_NUDGE_FILE = "stale-nudge.json";

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
 * The stale-run window from `PI_STALE_RUN_NUDGE_MS`. Zero disables the check; a
 * missing or invalid value keeps the one-hour default. The same window is the
 * per-task cooldown, so a task is nudged at most once per hour in production.
 */
export function staleRunNudgeMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PI_STALE_RUN_NUDGE_MS;
  if (raw === undefined || raw.trim().length === 0) return STALE_RUN_NUDGE_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return STALE_RUN_NUDGE_MS;
  return Math.floor(value);
}

/**
 * Tasks whose live run has not made a tagged tool call for `windowMs`. A terminal
 * run, a closed or proposed task, and a task waiting on an open blocker are left
 * alone: only work that is still live and still unblocked is worth a status check.
 */
export function staleRunTaskIds(
  tasks: readonly IdleTask[],
  activity: TaskActivity | undefined,
  at: number = Date.now(),
  windowMs: number = STALE_RUN_NUDGE_MS,
): string[] {
  if (activity === undefined || !activity.running || activity.runId === null) return [];
  if (windowMs <= 0) return [];
  const open = new Set(tasks.filter((task) => task.status === "open").map((task) => task.id));
  const ids: string[] = [];
  for (const task of tasks) {
    if (task.status !== "open") continue;
    if ((task.blockedBy ?? []).some((id) => open.has(id))) continue;
    const trace = activity.traces[task.id];
    const run = trace?.lastRun;
    if (run?.outcome !== "running" || run.id !== activity.runId) continue;
    // Quiet time starts at the later of the last tool call and the current run's start.
    // Without this, an old timestamp from a previous run makes a fresh run look stale.
    const calledAt = trace.lastActivityAt === null ? Number.NaN : Date.parse(trace.lastActivityAt);
    const startedAt = Date.parse(run.at);
    const last = Math.max(
      Number.isFinite(calledAt) ? calledAt : Number.NEGATIVE_INFINITY,
      Number.isFinite(startedAt) ? startedAt : Number.NEGATIVE_INFINITY,
    );
    if (!Number.isFinite(last) || at - last < windowMs) continue;
    ids.push(task.id);
  }
  return ids;
}

/** The prompt sent when a live run has gone quiet on these tasks. */
export function staleRunNudgeText(taskIds: readonly string[]): string {
  const list = taskIds.join(", ");
  const subject = taskIds.length === 1 ? `Task ${list}` : `Tasks ${list}`;
  const verb = taskIds.length === 1 ? "has" : "have";
  return `${subject} ${verb} had no tool call for ${STALE_RUN_NUDGE_MINUTES} minutes. Confirm whether ${taskIds.length === 1 ? "it is" : "they are"} still in progress, close ${taskIds.length === 1 ? "it" : "them"} if ${taskIds.length === 1 ? "it is" : "they are"} done, or mark ${taskIds.length === 1 ? "it" : "them"} blocked if not, and update the task ledger accordingly.`;
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
