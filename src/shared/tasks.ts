import type { Task, TaskCompletion } from "./types.js";

export const TASK_BODY_MAX_LENGTH = 20_000;

export const TASK_ATTACHMENTS_MAX = 12;

export const DEFAULT_NEW_TASK_TITLE = "New task";

export function proposedDraftTitle(id: string): string {
  return `Proposed ${id}`;
}

export function isProposedDraftTitle(title: string): boolean {
  return /^Proposed [abcdefghijkmnopqrstuvwxyz23456789]{4,8}$/.test(title);
}

export function descendantIds(tasks: readonly Task[], id: string): Set<string> {
  const children = new Map<string, string[]>();
  for (const task of tasks) {
    if (task.parentId === null) continue;
    const list = children.get(task.parentId);
    if (list === undefined) children.set(task.parentId, [task.id]);
    else list.push(task.id);
  }
  const out = new Set<string>();
  const stack = [...(children.get(id) ?? [])];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || out.has(current)) continue;
    out.add(current);
    for (const child of children.get(current) ?? []) stack.push(child);
  }
  return out;
}

export function ancestorIds(tasks: readonly Task[], id: string): Set<string> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const out = new Set<string>();
  let current = byId.get(id);
  while (current?.parentId != null) {
    if (out.has(current.parentId)) break;
    out.add(current.parentId);
    current = byId.get(current.parentId);
  }
  return out;
}

export function isActiveStatus(status: string): boolean {
  return status === "open" || status === "working";
}

export function isPendingStatus(status: string): boolean {
  return status === "open" || status === "working" || status === "planning";
}

export function isReleasedTask(task: {
  status: string;
  releasedAt?: string;
  releaseReason?: string;
}): boolean {
  return (
    task.status === "open" && (task.releasedAt !== undefined || task.releaseReason !== undefined)
  );
}

export function leftWorking(
  previous: Readonly<Record<string, string>>,
  tasks: readonly Task[],
): string[] {
  return tasks
    .filter((task) => previous[task.id] === "working" && task.status !== "working")
    .map((task) => task.id);
}

export function liveBlockerIds(tasks: readonly Task[], task: Task): string[] {
  const pending = new Set(
    tasks.filter((item) => isPendingStatus(item.status)).map((item) => item.id),
  );
  return task.blockedBy.filter((id) => pending.has(id));
}

export function hasOpenDescendant(tasks: readonly Task[], id: string): boolean {
  const descendants = descendantIds(tasks, id);
  return tasks.some((task) => descendants.has(task.id) && isActiveStatus(task.status));
}

export function dependencyCyclePath(
  tasks: readonly Task[],
  taskId: string,
  blockerId: string,
): string[] {
  if (taskId === blockerId) return [taskId, blockerId];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const previous = new Map<string, string>();
  const seen = new Set<string>();
  const stack = [blockerId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    if (current === taskId) {
      const path = [current];
      let step = previous.get(current);
      while (step !== undefined) {
        path.unshift(step);
        step = previous.get(step);
      }
      return [...path, blockerId];
    }
    seen.add(current);
    const task = byId.get(current);
    if (task === undefined) continue;
    for (const upstream of task.blockedBy) {
      if (seen.has(upstream)) continue;
      if (!previous.has(upstream)) previous.set(upstream, current);
      stack.push(upstream);
    }
  }
  return [];
}

export function blockerClosesCycle(
  tasks: readonly Task[],
  taskId: string,
  blockerId: string,
): boolean {
  return dependencyCyclePath(tasks, taskId, blockerId).length > 0;
}

export function compareTasks(tasks: readonly Task[], a: Task, b: Task): number {
  const rank = (task: Task) => {
    if (task.status === "proposed") return 0;
    if (task.status === "planning") return 1;
    if (task.status === "backlog") return 5;
    if (task.status === "done") return 4;
    if (liveBlockerIds(tasks, task).length > 0) return 3;
    return 2;
  };
  const delta = rank(a) - rank(b);
  if (delta !== 0) return delta;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export function formatTokenCount(tokens: number): string {
  const compact = (value: number, suffix: string) => {
    const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
    return `${rounded}${suffix}`;
  };
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return compact(tokens / 1_000, "k");
  return compact(tokens / 1_000_000, "m");
}

export function formatActiveTime(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatCost(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  return `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`;
}

export type CompletionParseResult =
  | { ok: true; completion: TaskCompletion }
  | { ok: false; error: string };

const EVIDENCE_TARGET = "a commit sha, file path, screenshot path or sentence a reviewer can check";

export function parseCompletion(input: unknown): CompletionParseResult {
  if (typeof input !== "object" || input === null) {
    return { ok: false, error: `completion must contain evidence; point at ${EVIDENCE_TARGET}` };
  }
  const record = input as Record<string, unknown>;
  if (record.evidence === undefined || record.evidence === null) {
    return { ok: false, error: `evidence is required; point at ${EVIDENCE_TARGET}` };
  }
  if (typeof record.evidence !== "string") {
    return { ok: false, error: `evidence must point at ${EVIDENCE_TARGET}` };
  }
  const evidence = record.evidence.trim();
  if (evidence.length < 8) {
    return {
      ok: false,
      error: `evidence must be at least 8 characters and point at ${EVIDENCE_TARGET}`,
    };
  }
  return { ok: true, completion: { evidence } };
}

export const TASK_REOPEN_REASON_MAX_LENGTH = 500;

export type ReopenReasonParseResult = { ok: true; reason: string } | { ok: false; error: string };

export function parseReopenReason(input: unknown): ReopenReasonParseResult {
  if (typeof input !== "string" || input.trim().length === 0) {
    return { ok: false, error: "A reopen needs a reason" };
  }
  const reason = input.trim();
  if (reason.length > TASK_REOPEN_REASON_MAX_LENGTH) {
    return {
      ok: false,
      error: `reason must be at most ${TASK_REOPEN_REASON_MAX_LENGTH} characters`,
    };
  }
  return { ok: true, reason };
}

export const TASK_RELEASE_REASON_MIN_LENGTH = 3;
export const TASK_RELEASE_REASON_MAX_LENGTH = 500;

export type ReleaseReasonParseResult = { ok: true; reason: string } | { ok: false; error: string };

export function parseReleaseReason(input: unknown): ReleaseReasonParseResult {
  if (typeof input !== "string" || input.trim().length === 0) {
    return { ok: false, error: "A release needs a reason" };
  }
  const reason = input.trim();
  if (reason.length < TASK_RELEASE_REASON_MIN_LENGTH) {
    return {
      ok: false,
      error: `reason must be at least ${TASK_RELEASE_REASON_MIN_LENGTH} characters`,
    };
  }
  if (reason.length > TASK_RELEASE_REASON_MAX_LENGTH) {
    return {
      ok: false,
      error: `reason must be at most ${TASK_RELEASE_REASON_MAX_LENGTH} characters`,
    };
  }
  return { ok: true, reason };
}
