import type { TaskLedger, TaskQuestionAnswer, TaskStatus } from "../shared/types";

const FALLBACK_ERROR = "Could not update tasks";

export type TaskOutcome = { ok: true; ledger: TaskLedger } | { ok: false; error: string };

/** Read the reason a rejected create names, whether the server sends text or JSON. */
function failureText(body: string): string {
  const text = body.trim();
  if (text.length === 0) return FALLBACK_ERROR;
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const message = record.error ?? record.message;
      if (typeof message === "string" && message.trim().length > 0) return message.trim();
    }
  } catch {
    // Plain text is the common shape; keep it verbatim.
  }
  return text;
}

async function requestTask(url: string, init: RequestInit): Promise<TaskOutcome> {
  try {
    const response = await fetch(url, init);
    if (response.ok) return { ok: true, ledger: (await response.json()) as TaskLedger };
    return { ok: false, error: failureText(await response.text()) };
  } catch {
    return { ok: false, error: FALLBACK_ERROR };
  }
}

/** The question routes answer with `{ ledger }` so one reply refreshes the whole tasks view. */
async function requestQuestionLedger(url: string, body: unknown): Promise<TaskOutcome> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) return { ok: false, error: failureText(await response.text()) };
    const parsed = (await response.json()) as { ledger?: TaskLedger };
    if (parsed.ledger === undefined) return { ok: false, error: FALLBACK_ERROR };
    return { ok: true, ledger: parsed.ledger };
  } catch {
    return { ok: false, error: FALLBACK_ERROR };
  }
}

export function answerTaskQuestions(
  taskId: string,
  setId: string,
  answers: TaskQuestionAnswer[],
): Promise<TaskOutcome> {
  return requestQuestionLedger(`/api/tasks/${encodeURIComponent(taskId)}/questions/answer`, {
    setId,
    answers,
  });
}

export function dismissTaskQuestions(taskId: string, setId: string): Promise<TaskOutcome> {
  return requestQuestionLedger(`/api/tasks/${encodeURIComponent(taskId)}/questions/dismiss`, {
    setId,
  });
}

export function createTask(
  title: string,
  parentId: string | null,
  attachments: string[] = [],
  project?: string | null,
  options?: { backlog?: boolean; status?: TaskStatus; plan?: boolean; body?: string },
): Promise<TaskOutcome> {
  return requestTask("/api/tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      parentId,
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(project === undefined ? {} : { project }),
      ...(options?.backlog === true ? { backlog: true } : {}),
      ...(options?.plan === true ? { plan: true } : {}),
      ...(options?.status === undefined ? {} : { status: options.status }),
      ...(options?.body === undefined ? {} : { body: options.body }),
    }),
  });
}

export function updateTask(
  id: string,
  patch: {
    title?: string;
    body?: string;
    status?: TaskStatus;
    blockedBy?: string[];
    completion?: { evidence: string };
    project?: string | null;
    attachments?: string[];
    reopenReason?: string;
  },
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
