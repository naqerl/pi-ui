import type { Task } from "./types.js";

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

/** Ready work first, then blocked, then done. Ties follow creation order. */
export function compareTasks(tasks: readonly Task[], a: Task, b: Task): number {
  const rank = (task: Task) => {
    if (task.status === "done") return 2;
    if (liveBlockerIds(tasks, task).length > 0) return 1;
    return 0;
  };
  const delta = rank(a) - rank(b);
  if (delta !== 0) return delta;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}
