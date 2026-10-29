import type { TaskLedger, TaskStatus } from "../shared/types";

async function readLedger(response: Response): Promise<TaskLedger | null> {
  if (!response.ok) return null;
  return (await response.json()) as TaskLedger;
}

export function createTask(title: string, parentId: string | null): Promise<TaskLedger | null> {
  return fetch("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, parentId }),
  }).then(readLedger, () => null);
}

export function updateTask(
  id: string,
  patch: { status?: TaskStatus; blockedBy?: string[] },
): Promise<TaskLedger | null> {
  return fetch(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  }).then(readLedger, () => null);
}

export function removeTask(id: string): Promise<TaskLedger | null> {
  return fetch(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" }).then(
    readLedger,
    () => null,
  );
}
