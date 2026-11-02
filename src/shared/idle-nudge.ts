import { STALE_WORKING_MS } from "./task-status.js";
import { isActiveStatus } from "./tasks.js";
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
/** A nudge never lists more than this many task ids. */
export const IDLE_NUDGE_TASK_LIMIT = 20;
/** A working task is asked for a status no more often than once an hour. */
export const IDLE_STATUS_INTERVAL_MS = 3_600_000;
/** An ignored task is left out of this many nudges before it is named again. */
export const IDLE_IGNORED_NUDGES = 3;

/** The task states the nudge understands, including the derived working state. */
export type IdleTaskStatus = Task["status"] | "working" | "blocked";
export type IdleTaskState = "open" | "working" | "blocked";

/** One hour; a live run with no tool call for this long gets a status nudge. */
export const STALE_RUN_NUDGE_MS = 3_600_000;
/** The wording names the stale-run window; it is what the user sees in the prompt. */
export const STALE_RUN_NUDGE_MINUTES = 60;
/** The persisted record of the last stale-run nudge for each task. */
export const STALE_RUN_NUDGE_FILE = "stale-nudge.json";

/** The fields the idle nudge needs from a task. */
export type IdleTask = Pick<Task, "id"> & {
  readonly status: IdleTaskStatus;
  readonly title?: string;
  readonly blockedBy?: readonly string[];
  readonly lastWorkedAt?: string | null;
  /** When task_working marked this task working, when the caller has it. */
  readonly workingSince?: string;
  /** A live trace's last attributed call, when the caller has one. */
  readonly lastActivityAt?: string | null;
  /** A derived client state, when the caller already has one. */
  readonly state?: IdleTaskState;
};

function taskState(task: IdleTask): IdleTaskStatus {
  if (task.status === "working" || task.state === "working") return "working";
  if (task.status === "blocked" || task.state === "blocked") return "blocked";
  if (task.status === "open") return "open";
  return task.status;
}

function instant(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The newest attributed call an idle task knows about, or null when it was never worked on. */
export function lastTouchedAt(task: IdleTask): number | null {
  let newest = instant(task.lastWorkedAt);
  const traced = instant(task.lastActivityAt);
  if (traced !== null && (newest === null || traced > newest)) newest = traced;
  return newest;
}

/** Open tasks that still carry working but have not been touched for over an hour. */
export function staleWorkedTasks(tasks: readonly IdleTask[], at: number = Date.now()): IdleTask[] {
  return tasks.filter((task) => {
    if (!isActiveStatus(task.status)) return false;
    const marked = instant(task.workingSince);
    const touched = lastTouchedAt(task);
    const last = marked === null ? touched : touched === null ? marked : Math.max(marked, touched);
    return last !== null && at - last > STALE_WORKING_MS;
  });
}

function staleRequestText(tasks: readonly IdleTask[]): string {
  const named = tasks.map((task) => {
    const title = (task.title ?? "").replace(/\s+/g, " ").trim() || task.id;
    return `${task.id} — ${title}`;
  });
D
  return `Actualize these tasks. These tasks were marked as working, but nothing has touched them for over an hour: ${named.join(", ")}. For each one, confirm it is still being worked on with task_working: if it is done, close it with task_done and evidence; if it cannot continue, mark it blocked and propose_task what would unblock it; if work continues, keep it working with task_working and a one-line note — do not silently keep the working badge.`;
}

export function withStaleRequest(text: string, tasks: readonly IdleTask[]): string {
  return tasks.length === 0 ? text : `${text}\n\n${staleRequestText(tasks)}`;
}

/** The idle notice used when the only thing to do is revisit stale working tasks. */
export function idleActualizeNudgeText(tasks: readonly IdleTask[]): string {
  return `You have been idle for ${IDLE_NUDGE_MINUTES} minutes. ${staleRequestText(tasks)}`;
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
 * Tasks whose live run has not made an attributed tool call for `windowMs`. A terminal
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
  const open = new Set(tasks.filter((task) => isActiveStatus(task.status)).map((task) => task.id));
  const ids: string[] = [];
  for (const task of tasks) {
    if (!isActiveStatus(task.status)) continue;
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
  return `You have been idle for ${IDLE_NUDGE_MINUTES} minutes and ${totalOpen} task(s) are open: ${ids.join(", ")}. Mark a task working with task_working before starting it; it sets the task to working and records when the work began. If it cannot be done now, mark it blocked and propose_task the task that would unblock it; if other tasks are already in progress, leave it alone — ignoring it is a valid answer.`;
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
  staleTasks?: readonly IdleTask[],
): string {
  let taskIds: readonly string[];
  let workingIds: readonly string[] = [];
  let blocked: WaitingOn | undefined;
  let stale = staleTasks ?? [];
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
      if (staleTasks === undefined) stale = staleWorkedTasks(tasks);
    }
  } else {
    taskIds = [];
    blocked = taskIdsOrTasks as WaitingOn;
  }
  if (taskIds.length === 0 && workingIds.length > 0) {
    return withStaleRequest(idleDecisionNudgeText(taskIds, workingIds), stale);
  }
  if (taskIds.length === 0 && blocked !== undefined && Object.keys(blocked).length > 0) {
    return withStaleRequest(idleBlockedNudgeText(blocked), stale);
  }
  return withStaleRequest(idleDecisionNudgeText(taskIds, workingIds), stale);
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
