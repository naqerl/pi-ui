import type { Task } from "../shared/types";

/** How many opened tasks the per-browser ring keeps. */
export const RECENT_TASK_LIMIT = 12;
/** The bare JSON array of task ids, most recent first. */
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
  } catch {
    // A denied removal leaves the corrupt value; every read still treats it as empty.
  }
}

/** The stored ring, most recent first. A missing, unreadable or malformed value is empty. */
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

/** Move an opened task to the front of the ring, adding it if it is new. */
export function rememberRecentTask(
  id: string,
  knownTasks?: readonly Task[],
  storage: RecentStore | undefined = browserStorage(),
): void {
  if (id.length === 0 || storage === undefined) return;
  const known = knownTasks === undefined ? null : new Set(knownTasks.map((task) => task.id));
  const readable = readRecentTaskIds(storage);
  // An empty ledger can mean the snapshot has not arrived yet, so it must not wipe the ring.
  const stored =
    known === null || known.size === 0
      ? readable
      : readable.filter((storedId) => known.has(storedId));
  // Reopening the front entry is not a reorder, so a no-op write stays a no-op.
  if (stored[0] === id) return;
  const next = [id, ...stored.filter((storedId) => storedId !== id)].slice(0, RECENT_TASK_LIMIT);
  try {
    storage.setItem(READ_KEY, JSON.stringify(next));
  } catch {
    // A denied write leaves the previous ring in place.
  }
}

/** The stored ring intersected with the ledger, preserving the reopened order. */
export function recentTaskOrder(tasks: Task[]): string[] {
  const known = new Set(tasks.map((task) => task.id));
  return readRecentTaskIds().filter((id) => known.has(id));
}
