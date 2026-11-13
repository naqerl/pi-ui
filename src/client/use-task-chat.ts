import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ContextUsage,
  McpStatus,
  MessageMode,
  QueuedMessage,
  Snapshot,
  SubmitMessageResponse,
  TaskQuestionAnswer,
  TaskQuestionSet,
  UsageSummary,
} from "../shared/types";
import type { ChatTransport, QueueMutation, TransportSendResult } from "./use-chat";
import { useChat } from "./use-chat";

/** The plan chat does not track main-chat usage; these keep the shared snapshot shape. */
const EMPTY_USAGE: UsageSummary = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: 0,
};
const EMPTY_CONTEXT: ContextUsage = { tokens: 0, window: null, percent: null };
const EMPTY_MCP: McpStatus = { servers: [], unavailable: [] };

interface TaskAgentSnapshot {
  taskId: string;
  messages: Snapshot["messages"];
  run: Snapshot["run"];
  runError?: Snapshot["runError"];
  draft: { text: string; thinking: string; revision: number };
  questions?: TaskQuestionSet | null;
  queue?: QueuedMessage[];
  steers?: QueuedMessage[];
  queueRevision?: number;
}

function asSnapshot(taskId: string, snapshot: TaskAgentSnapshot): Snapshot {
  return {
    conversationId: `task:${taskId}`,
    messages: snapshot.messages,
    activity: [],
    from: 0,
    hasEarlier: false,
    run: snapshot.run,
    runError: snapshot.runError ?? null,
    queue: snapshot.queue ?? [],
    steers: snapshot.steers ?? [],
    queueRevision: snapshot.queueRevision ?? 0,
    usage: EMPTY_USAGE,
    context: EMPTY_CONTEXT,
    mcp: EMPTY_MCP,
    draft: snapshot.draft,
  };
}

/**
 * The plan chat's routes behind the main chat's transport seam. Everything above this
 * — transcript rows, scroll, queue/steer reconciliation, status and the stream reducer —
 * is the one shared chat core in `use-chat.ts`.
 */
function inertStream(): EventSource {
  return {
    readyState: 0,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    close: () => undefined,
  } as unknown as EventSource;
}

function createTaskTransport(
  taskId: string,
  onQuestions: (questions: TaskQuestionSet | null) => void,
): ChatTransport {
  // The design fixture has no server conversation; keep its transcript local and silent.
  const fixture = taskId.startsWith("fixture-");
  const base = `/api/tasks/${encodeURIComponent(taskId)}/chat`;
  return {
    async readSnapshot() {
      if (fixture) {
        onQuestions(null);
        return {
          snapshot: asSnapshot(taskId, {
            taskId,
            messages: [],
            run: "idle",
            draft: { text: "", thinking: "", revision: 0 },
            questions: null,
          }),
          stale: false,
        };
      }
      const response = await fetch(base, { cache: "no-store" });
      if (!response.ok) return null;
      const snapshot = (await response.json()) as TaskAgentSnapshot;
      onQuestions(snapshot.questions ?? null);
      return { snapshot: asSnapshot(taskId, snapshot), stale: false };
    },
    async readHistory() {
      // The plan conversation is small and always read whole; there is no earlier page.
      return null;
    },
    async send(text, mode, attachments, queueKey): Promise<TransportSendResult> {
      try {
        const response = await fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text,
            mode,
            queueKey,
            ...(attachments.length > 0 ? { attachments } : {}),
          }),
        });
        if (response.status === 409) return { ok: false, conflict: true, error: null };
        if (!response.ok) {
          const reason = (await response.text()).trim();
          return {
            ok: false,
            error: reason.length > 0 ? reason : "Message was not sent",
          };
        }
        return { ok: true, data: (await response.json()) as SubmitMessageResponse };
      } catch {
        return { ok: false, error: "Message was not sent" };
      }
    },
    async cancelQueued(id) {
      try {
        const response = await fetch(`${base}/queue/${encodeURIComponent(id)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "cancel" }),
        });
        if (!response.ok) return null;
        return (await response.json()) as QueueMutation;
      } catch {
        return null;
      }
    },
    async steerQueued(id) {
      try {
        const response = await fetch(`${base}/queue/${encodeURIComponent(id)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "steer" }),
        });
        if (response.status === 404) return { ok: false, conflict: true, error: null };
        if (!response.ok) return { ok: false, error: null };
        return { ok: true, data: (await response.json()) as SubmitMessageResponse };
      } catch {
        return { ok: false, error: null };
      }
    },
    async unsendSteer(id) {
      try {
        const response = await fetch(`${base}/steer/${encodeURIComponent(id)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "unsend" }),
        });
        if (!response.ok) return null;
        return (await response.json()) as {
          steer: QueuedMessage;
          steers: QueuedMessage[];
          queueRevision?: number;
        };
      } catch {
        return null;
      }
    },
    async stop() {
      try {
        await fetch(`${base}/stop`, { method: "POST" });
      } catch {
        // The run state event is authoritative.
      }
    },
    async dismissRunError(id) {
      await fetch(`${base}/error/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      }).catch(() => undefined);
    },
    openStream() {
      return fixture ? inertStream() : new EventSource(`${base}/stream`);
    },
  };
}

export function useTaskChat(taskId: string, closed: boolean) {
  const [questions, setQuestions] = useState<TaskQuestionSet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answeredSets = useRef(new Set<string>());
  const transport = useMemo(
    () =>
      createTaskTransport(taskId, (next) => {
        setQuestions(next !== null && answeredSets.current.has(next.id) ? null : next);
      }),
    [taskId],
  );
  const chat = useChat({ transport });
  const { refresh, running, dismissRunError } = chat;

  // The plan agent can ask a question mid-run without a transcript row, so poll while it works.
  useEffect(() => {
    if (!running || closed) return;
    const timer = setInterval(() => void refresh(), 1_000);
    return () => clearInterval(timer);
  }, [closed, refresh, running]);

  const send = useCallback(
    async (text: string, attachments: string[] = [], mode: MessageMode = "queue") => {
      if (closed) return false;
      setError(null);
      const outcome = await chat.send(text, mode, attachments);
      if (!outcome.ok) {
        if (outcome.error !== null) setError(outcome.error);
        return false;
      }
      return true;
    },
    [chat, closed],
  );

  const stop = useCallback(async () => {
    if (closed) return;
    await chat.stop();
  }, [chat, closed]);

  const answerQuestions = useCallback(
    async (setId: string, answers: TaskQuestionAnswer[]) => {
      setError(null);
      try {
        const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/questions/answer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ setId, answers }),
        });
        if (!response.ok) {
          const message = (await response.text()).trim();
          setError(message.length > 0 ? message : "Could not send the answers");
          return false;
        }
        answeredSets.current.add(setId);
        setQuestions(null);
        await refresh();
        return true;
      } catch {
        setError("Could not send the answers");
        return false;
      }
    },
    [refresh, taskId],
  );

  const dismissError = useCallback(
    (id?: string) => {
      if (id === undefined) {
        setError(null);
        return;
      }
      dismissRunError(id);
    },
    [dismissRunError],
  );

  return {
    timeline: chat.timeline,
    running: chat.running,
    thinking: chat.thinking,
    interrupted: chat.interrupted,
    ready: chat.ready,
    runError: chat.runError,
    questions,
    error,
    send,
    stop,
    cancelQueued: chat.cancelQueued,
    unsendSteer: chat.unsendSteer,
    answerQuestions,
    dismissError,
  };
}
