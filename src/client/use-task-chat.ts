import { useCallback, useEffect, useRef, useState } from "react";
import { acceptDeltaRevision } from "../shared/revisions";
import type {
  ChatMessage,
  RunState,
  StreamDraftSync,
  StreamMessageDone,
  StreamRunState,
  StreamTextDelta,
} from "../shared/types";
import { frameBatch, reduceDraft } from "./stream-batch";
import { subscribeTaskChatEvents } from "./task-chat-events";

export interface TaskAgentSnapshot {
  taskId: string;
  messages: ChatMessage[];
  run: RunState;
  draft: { text: string; thinking: string; revision: number };
}

export function useTaskChat(taskId: string, closed: boolean) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draftText, setDraftText] = useState("");
  const [run, setRun] = useState<RunState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const draftRevision = useRef(0);
  const taskIdRef = useRef(taskId);
  taskIdRef.current = taskId;

  const applySnapshot = useCallback((snapshot: TaskAgentSnapshot) => {
    const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    const draft = snapshot.draft;
    setMessages(messages);
    setRun(snapshot.run === "running" ? "running" : "idle");
    setDraftText(typeof draft?.text === "string" ? draft.text : "");
    draftRevision.current = typeof draft?.revision === "number" ? draft.revision : 0;
    setReady(true);
  }, []);

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
    setReady(false);
    setError(null);
    draftRevision.current = 0;
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
  }, [refresh, taskId]);

  useEffect(() => {
    if (run !== "running" || closed) return;
    const timer = setInterval(() => void refresh(), 1_000);
    return () => clearInterval(timer);
  }, [closed, refresh, run]);

  const send = useCallback(
    async (text: string) => {
      if (closed) return false;
      const trimmed = text.trim();
      if (trimmed.length === 0) return false;
      setError(null);
      try {
        const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: trimmed }),
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

  return { messages, draftText, run, error, ready, send, stop, dismissError: () => setError(null) };
}
