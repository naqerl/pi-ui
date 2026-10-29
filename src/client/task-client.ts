import type { TaskLedger, TaskStatus } from "../shared/types";

const FALLBACK_ERROR = "Could not update tasks";

export type TaskOutcome = { ok: true; ledger: TaskLedger } | { ok: false; error: string };

async function requestTask(url: string, init: RequestInit): Promise<TaskOutcome> {
  try {
    const response = await fetch(url, init);
    if (response.ok) return { ok: true, ledger: (await response.json()) as TaskLedger };
    const error = (await response.text()).trim();
    return { ok: false, error: error.length > 0 ? error : FALLBACK_ERROR };
  } catch {
    return { ok: false, error: FALLBACK_ERROR };
  }
}

export function createTask(title: string, parentId: string | null): Promise<TaskOutcome> {
  return requestTask("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ title, parentId }),
  });
}

export function updateTask(
  id: string,
  patch: { status?: TaskStatus; blockedBy?: string[] },
): Promise<TaskOutcome> {
  return requestTask(`/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function removeTask(id: string): Promise<TaskOutcome> {
  return requestTask(`/api/tasks/${encodeURIComponent(id)}`, { method: "DELETE" });
}
