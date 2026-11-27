import { STALE_WORKING_MS } from "./task-status.js";
import { isActiveStatus, isPendingStatus, isReleasedTask } from "./tasks.js";
import type { Task, TaskActivity } from "./types.js";

export const DEFAULT_IDLE_NUDGE_MS = 1_200_000;
export const IDLE_NUDGE_MINUTES = 20;
export const IDLE_NUDGE_FILE = "idle-nudge.json";
export const IDLE_NUDGE_TASK_LIMIT = 20;
export const IDLE_STATUS_INTERVAL_MS = 3_600_000;
export const IDLE_IGNORED_NUDGES = 3;

export type IdleTaskStatus = Task["status"] | "working" | "blocked";
export type IdleTaskState = "open" | "working" | "blocked";

export const STALE_RUN_NUDGE_MS = 3_600_000;
export const STALE_RUN_NUDGE_MINUTES = 60;
export const STALE_RUN_NUDGE_FILE = "stale-nudge.json";

export type IdleTask = Pick<Task, "id"> & {
  readonly status: IdleTaskStatus;
  readonly title?: string;
  readonly blockedBy?: readonly string[];
  readonly lastWorkedAt?: string | null;
  readonly workingSince?: string;
  readonly releasedAt?: string;
  readonly releaseReason?: string;
  readonly completedAt?: string | null;
  readonly closedAt?: string | null;
  readonly lastActivityAt?: string | null;
  readonly state?: IdleTaskState;
};

function instant(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function lastTouchedAt(task: IdleTask): number | null {
  let newest = instant(task.lastWorkedAt);
  const traced = instant(task.lastActivityAt);
  if (traced !== null && (newest === null || traced > newest)) newest = traced;
  return newest;
}

export function staleWorkedTasks(tasks: readonly IdleTask[], at: number = Date.now()): IdleTask[] {
  return tasks.filter((task) => {
    if (!isActiveStatus(task.status)) return false;
    if (isReleasedTask(task)) return false;
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
  return `Actualize these tasks. These tasks were marked as working, but nothing has touched them for over an hour: ${named.join(", ")}. For each one, confirm it is still being worked on with task_working: if it is done, close it with task_done and evidence; if it cannot continue, mark it blocked and propose_task what would unblock it; if work continues, keep it working with task_working and a one-line note — do not silently keep the working badge.`;
}

export function withStaleRequest(text: string, tasks: readonly IdleTask[]): string {
  if (tasks.length === 0) return text;
  const request = staleRequestText(tasks);
  return text.length === 0 ? request : `${text}\n\n${request}`;
}

export function idleActualizeNudgeText(tasks: readonly IdleTask[]): string {
  return `You have been idle for ${IDLE_NUDGE_MINUTES} minutes. ${staleRequestText(tasks)}`;
}

function closedDescription(tasks: readonly IdleTask[]): string {
  return tasks
    .map((task) => {
      const title = (task.title ?? "").replace(/\s+/g, " ").trim() || task.id;
      return `${task.id} "${title}"`;
    })
    .join(", ");
}

export function idleMemoryNudgeText(tasks: readonly IdleTask[]): string {
  const subject = tasks.length === 1 ? "it" : "them";
  return `You closed ${closedDescription(tasks)} since the last nudge and have not written anything durable about ${subject}.
If the work taught something reusable — a procedure, a trap, an environment fact — record it with
memory_write (long_term for the topic, daily for the log). If it taught nothing reusable, say so in
one line and continue.`;
}

export function withMemoryRequest(text: string, tasks: readonly IdleTask[]): string {
  return tasks.length === 0 ? text : `${text}\n\n${idleMemoryNudgeText(tasks)}`;
}

export const idleMemoryWriteNudgeText = idleMemoryNudgeText;

export function idleNudgeMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PI_IDLE_NUDGE_MS;
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_IDLE_NUDGE_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_IDLE_NUDGE_MS;
  return Math.floor(value);
}

export function staleRunNudgeMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PI_STALE_RUN_NUDGE_MS;
  if (raw === undefined || raw.trim().length === 0) return STALE_RUN_NUDGE_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return STALE_RUN_NUDGE_MS;
  return Math.floor(value);
}

export function staleRunTaskIds(
  tasks: readonly IdleTask[],
  activity: TaskActivity | undefined,
  at: number = Date.now(),
  windowMs: number = STALE_RUN_NUDGE_MS,
): string[] {
  if (activity === undefined || !activity.running || activity.runId === null) return [];
  if (windowMs <= 0) return [];
  const pending = new Set(
    tasks.filter((task) => isPendingStatus(task.status)).map((task) => task.id),
  );
  const ids: string[] = [];
  for (const task of tasks) {
    if (!isActiveStatus(task.status)) continue;
    if ((task.blockedBy ?? []).some((id) => pending.has(id))) continue;
    const trace = activity.traces[task.id];
    const run = trace?.lastRun;
    if (run?.outcome !== "running" || run.id !== activity.runId) continue;
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

export function staleRunNudgeText(taskIds: readonly string[]): string {
  const list = taskIds.join(", ");
  const subject = taskIds.length === 1 ? `Task ${list}` : `Tasks ${list}`;
  const verb = taskIds.length === 1 ? "has" : "have";
  return `${subject} ${verb} had no tool call for ${STALE_RUN_NUDGE_MINUTES} minutes. Confirm whether ${taskIds.length === 1 ? "it is" : "they are"} still in progress, close ${taskIds.length === 1 ? "it" : "them"} if ${taskIds.length === 1 ? "it is" : "they are"} done, or mark ${taskIds.length === 1 ? "it" : "them"} blocked if not, and update the task ledger accordingly.`;
}

export function openTaskIds(tasks: readonly IdleTask[]): string[] {
  const live = liveOpenIds(tasks);
  return tasks
    .filter((task) => task.status === "open" && !isReleasedTask(task))
    .filter((task) => !(task.blockedBy ?? []).some((id) => live.has(id)))
    .map((task) => task.id);
}

export function workingTaskIds(tasks: readonly IdleTask[]): string[] {
  const live = liveOpenIds(tasks);
  return tasks
    .filter((task) => task.status === "working")
    .filter((task) => !(task.blockedBy ?? []).some((id) => live.has(id)))
    .map((task) => task.id);
}

function liveOpenIds(tasks: readonly IdleTask[]): Set<string> {
  return new Set(tasks.filter((task) => isPendingStatus(task.status)).map((task) => task.id));
}

export type WaitingOn = Record<string, string[]> & {
  readonly size: number;
  get(taskId: string): string[] | undefined;
  has(taskId: string): boolean;
  entries(): IterableIterator<[string, string[]]>;
  keys(): IterableIterator<string>;
  values(): IterableIterator<string[]>;
  [Symbol.iterator](): IterableIterator<[string, string[]]>;
};

export function waitingOn(tasks: readonly IdleTask[]): WaitingOn {
  const live = liveOpenIds(tasks);
  const out = {} as WaitingOn;
  for (const task of tasks) {
    if (task.status !== "open" || isReleasedTask(task)) continue;
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

function idleWorkText(taskIds: readonly string[], totalOpen = taskIds.length): string {
  const ids = capped(taskIds);
  return `You have been idle for ${IDLE_NUDGE_MINUTES} minutes and ${totalOpen} task(s) are open: ${ids.join(", ")}. Mark a task working with task_working before starting it; it sets the task to working and records when the work began. If it cannot be done now, mark it blocked and propose_task the task that would unblock it; if other tasks are already in progress, leave it alone — ignoring it is a valid answer.`;
}

function idleWorkingText(taskIds: readonly string[], withIdlePrefix: boolean): string {
  const ids = capped(taskIds);
  const prefix = withIdlePrefix ? `You have been idle for ${IDLE_NUDGE_MINUTES} minutes. ` : "";
  return `${prefix}Status check for tasks marked working: ${ids.join(", ")}. Mark each complete with task_done, mark it blocked and propose_task what would unblock it, or leave it alone — ignoring it is a valid answer.`;
}

export function idleDecisionNudgeText(
  openIds: readonly string[],
  workingIds: readonly string[] = [],
  totalOpen = openIds.length,
): string {
  const visibleOpen = capped(openIds);
  const room = Math.max(0, IDLE_NUDGE_TASK_LIMIT - visibleOpen.length);
  const working = workingIds.slice(0, room);
  if (openIds.length === 0 && working.length === 0) return "";
  if (openIds.length === 0) {
    return idleWorkingText(working, true);
  }
  const work = idleWorkText(visibleOpen, totalOpen);
  if (working.length === 0) return work;
  return `${work} Status check for tasks marked working: ${working.join(", ")}. Mark each complete with task_done, mark it blocked and propose_task what would unblock it, or leave it alone — ignoring it is a valid answer.`;
}

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

export function idleBlockedNudgeText(waiting: WaitingOn): string {
  const detail = Object.keys(waiting)
    .map((taskId) => [taskId, waiting[taskId]] as const)
    .filter(([, blockers]) => (blockers?.length ?? 0) > 0)
    .map(([taskId, blockers]) => `${taskId} waits on ${(blockers ?? []).join(", ")}`)
    .join("; ");
  return `You have been idle for ${IDLE_NUDGE_MINUTES} minutes. Nothing is unblocked: ${detail}.`;
}

export const blockedNudgeText = idleBlockedNudgeText;
export const idleNudgeBlockedText = idleBlockedNudgeText;
