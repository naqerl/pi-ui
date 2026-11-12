import { useCallback, useEffect, useRef, useState } from "react";
import { acceptDeltaRevision } from "../shared/revisions";
import { runErrorMatchesDismissal } from "../shared/run-error";
import type {
  ChatMessage,
  RunError,
  RunState,
  StreamDraftSync,
  StreamMessageDone,
  StreamRunState,
  StreamTextDelta,
  TaskQuestionAnswer,
  TaskQuestionSet,
} from "../shared/types";
import { frameBatch, reduceDraft } from "./stream-batch";
import { subscribeTaskChatEvents } from "./task-chat-events";

export interface TaskAgentSnapshot {
  taskId: string;
  messages: ChatMessage[];
  run: RunState;
  runError?: RunError | null;
  draft: { text: string; thinking: string; revision: number };
  questions?: TaskQuestionSet | null;
}

export function useTaskChat(taskId: string, closed: boolean) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draftText, setDraftText] = useState("");
  const [run, setRun] = useState<RunState>("idle");
  const [questions, setQuestions] = useState<TaskQuestionSet | null>(null);
  const [runError, setRunError] = useState<RunError | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const draftRevision = useRef(0);
  const answeredSets = useRef(new Set<string>());
  const dismissedRunErrors = useRef<ReadonlySet<string>>(new Set());
  const taskIdRef = useRef(taskId);
  taskIdRef.current = taskId;

  const acceptRunError = useCallback((next: RunError | null | undefined) => {
    if (next === undefined || next === null) {
      setRunError(null);
      return;
    }
    setRunError(dismissedRunErrors.current.has(next.id) ? null : next);
  }, []);

  const applySnapshot = useCallback(
    (snapshot: TaskAgentSnapshot) => {
      const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
      const draft = snapshot.draft;
      setMessages(messages);
      setRun(snapshot.run === "running" ? "running" : "idle");
      acceptRunError(snapshot.runError);
      setDraftText(typeof draft?.text === "string" ? draft.text : "");
      draftRevision.current = typeof draft?.revision === "number" ? draft.revision : 0;
      const pending = snapshot.questions ?? null;
      setQuestions(pending !== null && answeredSets.current.has(pending.id) ? null : pending);
      setReady(true);
    },
    [acceptRunError],
  );

  const refresh = useCallback(async () => {
    const id = taskIdRef.current;
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/chat`, {
        cache: "no-store",
      });
      if (!response.ok) {
        const text = (await response.text()).trim();
        setError(text.length > 0 ? text : "Could not load the task chat");
        return;
      }
      applySnapshot((await response.json()) as TaskAgentSnapshot);
      setError(null);
    } catch {
      setError("Could not load the task chat");
    }
  }, [applySnapshot]);

  useEffect(() => {
    setMessages([]);
    setDraftText("");
    setRun("idle");
    setQuestions(null);
    setRunError(null);
    setReady(false);
    setError(null);
    draftRevision.current = 0;
    answeredSets.current.clear();
    dismissedRunErrors.current = new Set();
    if (taskId.startsWith("fixture-")) {
      setReady(true);
      return;
    }
    void refresh();

    const draftBatch = frameBatch<{ kind: "text"; delta: StreamTextDelta }>(
      (items) => {
        setDraftText((current) =>
          reduceDraft(
            current,
            items.map((item) => item.delta),
          ),
        );
      },
      (runFrame) => window.requestAnimationFrame(runFrame),
      (frame) => window.cancelAnimationFrame(frame),
    );

    void taskId;
    const unsubscribe = subscribeTaskChatEvents((frame) => {
      if (frame.taskId !== taskIdRef.current) return;
      if (frame.event === "draft.sync") {
        const data = frame.data as StreamDraftSync;
        if (data == null || typeof data.revision !== "number") return;
        draftRevision.current = data.revision;
        draftBatch.clear();
        setDraftText(typeof data.text === "string" ? data.text : "");
        return;
      }
      if (frame.event === "message.delta") {
        const data = frame.data as StreamTextDelta;
        if (data == null || typeof data.revision !== "number") return;
        const revision = acceptDeltaRevision(draftRevision.current, data.revision);
        if (revision === null) return;
        draftRevision.current = revision;
        draftBatch.push({ kind: "text", delta: data });
        return;
      }
      if (frame.event === "message.done") {
        const message = (frame.data as StreamMessageDone | null)?.message;
        if (message) {
          setMessages((current) =>
            current.some((item) => item.id === message.id) ? current : [...current, message],
          );
        }
        draftBatch.clear();
        setDraftText("");
        void refresh();
        return;
      }
      if (frame.event === "run.state") {
        const data = frame.data as StreamRunState;
        if (data == null || typeof data.state !== "string") return;
        setRun(data.state);
        if (data.runError !== undefined) acceptRunError(data.runError);
        if (data.state !== "running") {
          draftBatch.clear();
          setDraftText("");
          void refresh();
        }
      }
    });

    return () => {
      draftBatch.clear();
      unsubscribe();
    };
  }, [acceptRunError, refresh, taskId]);

  useEffect(() => {
    if (run !== "running" || closed) return;
    const timer = setInterval(() => void refresh(), 1_000);
    return () => clearInterval(timer);
  }, [closed, refresh, run]);

  const send = useCallback(
    async (text: string, attachments: string[] = []) => {
      if (closed) return false;
      const trimmed = text.trim();
      if (trimmed.length === 0 && attachments.length === 0) return false;
      setError(null);
      try {
        const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: trimmed,
            ...(attachments.length > 0 ? { attachments } : {}),
          }),
        });
        if (!response.ok) {
          const message = (await response.text()).trim();
          setError(message.length > 0 ? message : "Could not send the message");
          return false;
        }
        applySnapshot((await response.json()) as TaskAgentSnapshot);
        return true;
      } catch {
        setError("Could not send the message");
        return false;
      }
    },
    [applySnapshot, closed, taskId],
  );

  const stop = useCallback(async () => {
    try {
      const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/chat/stop`, {
        method: "POST",
      });
      if (response.ok) applySnapshot((await response.json()) as TaskAgentSnapshot);
    } catch {
      setError("Could not stop the task agent");
    }
  }, [applySnapshot, taskId]);

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
        applySnapshot((await response.json()) as TaskAgentSnapshot);
        return true;
      } catch {
        setError("Could not send the answers");
        return false;
      }
    },
    [applySnapshot, taskId],
  );

  const dismissError = useCallback(
    (id?: string) => {
      // No id is the composer's own dismissal; only an explicit matching id targets the run error.
      if (id === undefined) {
        setError(null);
        return;
      }
      if (runError === null || !runErrorMatchesDismissal(id, runError)) return;
      dismissedRunErrors.current = new Set(dismissedRunErrors.current).add(runError.id);
      setRunError(null);
      void fetch(`/api/tasks/${encodeURIComponent(taskId)}/chat/error/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: runError.id }),
      })
        .then(async (response) => {
          if (!response.ok) return;
          const data = (await response.json()) as TaskAgentSnapshot & {
            runError?: RunError | null;
          };
          if (typeof data.taskId === "string" && Array.isArray(data.messages)) {
            applySnapshot(data);
          } else if ("runError" in data) {
            acceptRunError(data.runError);
          }
        })
        .catch(() => undefined);
    },
    [acceptRunError, applySnapshot, runError, taskId],
  );

  return {
    messages,
    draftText,
    run,
    questions,
    runError,
    error,
    ready,
    send,
    stop,
    answerQuestions,
    dismissError,
  };
}
