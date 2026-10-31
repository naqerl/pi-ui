import type { Task, TaskCompletion } from "./types.js";

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

/** Open tasks in `blockedBy`. A done blocker does not keep the task blocked. */
export function liveBlockerIds(tasks: readonly Task[], task: Task): string[] {
  const open = new Set(tasks.filter((item) => item.status === "open").map((item) => item.id));
  return task.blockedBy.filter((id) => open.has(id));
}

export function hasOpenDescendant(tasks: readonly Task[], id: string): boolean {
  const descendants = descendantIds(tasks, id);
  return tasks.some((task) => descendants.has(task.id) && task.status === "open");
}

/**
 * True when `blockerId` already depends on `taskId`, so "blocked by blockerId"
 * would close a cycle. Self-block is a cycle.
 */
export function blockerClosesCycle(
  tasks: readonly Task[],
  taskId: string,
  blockerId: string,
): boolean {
  if (taskId === blockerId) return true;
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const seen = new Set<string>();
  const stack = [blockerId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || seen.has(current)) continue;
    if (current === taskId) return true;
    seen.add(current);
    const task = byId.get(current);
    if (task === undefined) continue;
    for (const upstream of task.blockedBy) stack.push(upstream);
  }
  return false;
}

/** Proposals first, then ready work, then blocked, then done. Ties follow creation order. */
export function compareTasks(tasks: readonly Task[], a: Task, b: Task): number {
  const rank = (task: Task) => {
    if (task.status === "proposed") return 0;
    if (task.status === "done") return 3;
    if (liveBlockerIds(tasks, task).length > 0) return 2;
    return 1;
  };
  const delta = rank(a) - rank(b);
  if (delta !== 0) return delta;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/** A short token count for a dense ledger or card line, such as `120k`. */
export function formatTokenCount(tokens: number): string {
  const compact = (value: number, suffix: string) => {
    const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
    return `${rounded}${suffix}`;
  };
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return compact(tokens / 1_000, "k");
  return compact(tokens / 1_000_000, "m");
}

/** Active time for a stats cell, such as `42s`, `18m` or `1h 05m`. */
export function formatActiveTime(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Provider cost in USD, with cents below a dollar and a floor for tiny amounts. */
export function formatCost(usd: number): string {
  if (usd <= 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  return `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`;
}

export type CompletionParseResult =
  | { ok: true; completion: TaskCompletion }
  | { ok: false; error: string };

const EVIDENCE_TARGET = "a commit sha, file path, screenshot path or sentence a reviewer can check";

/**
 * Validate a completion for the task tool and the HTTP API. Only evidence is reported; time,
 * tokens and cost are measured from the runs that worked on the task.
 */
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
