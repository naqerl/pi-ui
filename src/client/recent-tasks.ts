import type { Task } from "../shared/types";

export const RECENT_TASK_LIMIT = 12;
export const READ_KEY = "pi-ui:recent-tasks";

type RecentStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): RecentStore | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function dropStored(storage: RecentStore): void {
  try {
    storage.removeItem(READ_KEY);
  } catch {}
}

export function readRecentTaskIds(storage: RecentStore | undefined = browserStorage()): string[] {
  if (storage === undefined) return [];
  try {
    const raw = storage.getItem(READ_KEY);
    if (raw === null) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string" || id.length === 0)) {
      dropStored(storage);
      return [];
    }
    return [...new Set(parsed as string[])].slice(0, RECENT_TASK_LIMIT);
  } catch {
    dropStored(storage);
    return [];
  }
}

export function rememberRecentTask(
  id: string,
  knownTasks?: readonly Task[],
  storage: RecentStore | undefined = browserStorage(),
): void {
  if (id.length === 0 || storage === undefined) return;
  const known = knownTasks === undefined ? null : new Set(knownTasks.map((task) => task.id));
  const readable = readRecentTaskIds(storage);
  const stored =
    known === null || known.size === 0
      ? readable
      : readable.filter((storedId) => known.has(storedId));
  if (stored[0] === id) return;
  const next = [id, ...stored.filter((storedId) => storedId !== id)].slice(0, RECENT_TASK_LIMIT);
  try {
    storage.setItem(READ_KEY, JSON.stringify(next));
  } catch {}
}

export function recentTaskOrder(tasks: Task[]): string[] {
  const known = new Set(tasks.map((task) => task.id));
  return readRecentTaskIds().filter((id) => known.has(id));
}
