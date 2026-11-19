import { useCallback, useMemo, useRef, useState } from "react";
import type {
  ActivityItem,
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
import { subscribeTaskChatEvents, subscribeTaskChatLiveness } from "./task-chat-events";
import type { ChatTransport, QueueMutation, TransportSendResult } from "./use-chat";
import { useChat } from "./use-chat";

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
  activity?: ActivityItem[];
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
    activity: snapshot.activity ?? [],
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

function inertStream(): EventSource {
  return {
    readyState: 0,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    close: () => undefined,
  } as unknown as EventSource;
}

function createTaskStream(taskId: string): EventSource {
  let closed = false;
  const listeners = new Map<
    string,
    Map<EventListenerOrEventListenerObject, (event: Event) => void>
  >();
  const dispatch = (type: string, data: unknown) => {
    const event = { type, data: JSON.stringify(data) } as MessageEvent<string>;
    for (const listener of listeners.get(type)?.values() ?? []) listener(event);
  };
  const shim = {
    CONNECTING: 0,
    OPEN: 1,
    CLOSED: 2,
    readyState: 0,
    url: "/api/stream",
    withCredentials: false,
    onopen: null,
    onerror: null,
    onmessage: null,
    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
      if (listener === null) return;
      const registered =
        listeners.get(type) ??
        new Map<EventListenerOrEventListenerObject, (event: Event) => void>();
      registered.set(listener, (event) => {
        if (typeof listener === "function") listener(event);
        else listener.handleEvent(event);
      });
      listeners.set(type, registered);
    },
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null) {
      if (listener === null) return;
      listeners.get(type)?.delete(listener);
    },
    dispatchEvent: () => true,
    close() {
      if (closed) return;
      closed = true;
      stopFrames();
      stopLiveness();
      (shim as { readyState: number }).readyState = 2;
    },
  } as unknown as EventSource;
  const stopFrames = subscribeTaskChatEvents((frame) => {
    if (!closed) dispatch(frame.event, frame.data);
  }, taskId);

  let opening = true;
  let firstLiveness: unknown;
  const stopLiveness = subscribeTaskChatLiveness((data) => {
    if (opening) {
      firstLiveness = data;
      return;
    }
    if (!closed) dispatch("liveness", data);
  });
  queueMicrotask(() => {
    if (closed) return;
    opening = false;
    (shim as { readyState: number }).readyState = 1;
    shim.onopen?.call(shim, new Event("open"));
    if (firstLiveness !== undefined) dispatch("liveness", firstLiveness);
  });
  return shim;
}

function createTaskTransport(
  taskId: string,
  onQuestions: (questions: TaskQuestionSet | null) => void,
): ChatTransport {
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
            activity: [],
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
      } catch {}
    },
    async dismissRunError(id) {
      await fetch(`${base}/error/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      }).catch(() => undefined);
    },
    openStream() {
      return fixture ? inertStream() : createTaskStream(taskId);
    },
  };
}

export function useTaskChat(taskId: string, closed: boolean) {
  const [questions, setQuestions] = useState<TaskQuestionSet | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answeredSets = useRef(new Set<string>());
  const applyQuestions = useCallback((next: TaskQuestionSet | null) => {
    setQuestions(next !== null && answeredSets.current.has(next.id) ? null : next);
  }, []);
  const transport = useMemo(
    () => createTaskTransport(taskId, applyQuestions),
    [taskId, applyQuestions],
  );
  const chat = useChat({
    transport,
    onQuestions: applyQuestions,
    publishLiveness: false,
  });
  const { refresh, dismissRunError } = chat;

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
    quiet: chat.quiet,
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
