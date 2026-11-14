import type { Task } from "./types.js";

/** Immutable per-ledger facts. State precedence remains owned by taskState. */
export function indexTasks(tasks: readonly Task[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const active = new Set(
    tasks
      .filter((task) => task.status === "open" || task.status === "working")
      .map((task) => task.id),
  );
  const children = new Map<string, Task[]>();
  const blockers = new Map<string, string[]>();
  const doneBelow = new Set<string>();
  for (const task of tasks) {
    blockers.set(
      task.id,
      task.blockedBy.filter((id) => active.has(id)),
    );
    if (task.parentId !== null) {
      const group = children.get(task.parentId);
      if (group === undefined) children.set(task.parentId, [task]);
      else group.push(task);
    }
    if (task.status === "done") {
      let parent = task.parentId;
      while (parent !== null && !doneBelow.has(parent)) {
        doneBelow.add(parent);
        parent = byId.get(parent)?.parentId ?? null;
      }
    }
  }
  const rank = (task: Task) =>
    task.status === "proposed"
      ? 0
      : task.status === "planning"
        ? 1
        : task.status === "backlog"
          ? 5
          : task.status === "done"
            ? 4
            : (blockers.get(task.id)?.length ?? 0) > 0
              ? 3
              : 2;
  const compare = (a: Task, b: Task): number =>
    rank(a) - rank(b) ||
    (a.createdAt !== b.createdAt
      ? a.createdAt < b.createdAt
        ? -1
        : 1
      : a.id === b.id
        ? 0
        : a.id < b.id
          ? -1
          : 1);
  for (const group of children.values()) group.sort(compare);
  return { byId, children, blockers, doneBelow, compare };
}
export type TaskIndex = ReturnType<typeof indexTasks>;
