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

export interface TaskAgentSnapshot {
  taskId: string;
  messages: ChatMessage[];
  run: RunState;
  draft: { text: string; thinking: string; revision: number };
}

function parseEvent<T>(event: MessageEvent<string>): T | null {
  try {
    return JSON.parse(event.data) as T;
  } catch {
    return null;
  }
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
    setMessages(snapshot.messages);
    setRun(snapshot.run);
    setDraftText(snapshot.draft.text);
    draftRevision.current = snapshot.draft.revision;
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
    void refresh();

    const source = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/chat/stream`);
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

    source.addEventListener("draft.sync", (event) => {
      const data = parseEvent<StreamDraftSync>(event as MessageEvent<string>);
      if (!data) return;
      draftRevision.current = data.revision;
      draftBatch.clear();
      setDraftText(data.text);
    });
    source.addEventListener("message.delta", (event) => {
      const data = parseEvent<StreamTextDelta>(event as MessageEvent<string>);
      if (!data) return;
      const revision = acceptDeltaRevision(draftRevision.current, data.revision);
      if (revision === null) return;
      draftRevision.current = revision;
      draftBatch.push({ kind: "text", delta: data });
    });
    source.addEventListener("message.done", (event) => {
      const data = parseEvent<StreamMessageDone>(event as MessageEvent<string>);
      const message = data?.message;
      if (message) {
        setMessages((current) =>
          current.some((item) => item.id === message.id) ? current : [...current, message],
        );
      }
      draftBatch.clear();
      setDraftText("");
      void refresh();
    });
    source.addEventListener("run.state", (event) => {
      const data = parseEvent<StreamRunState>(event as MessageEvent<string>);
      if (!data) return;
      setRun(data.state);
      if (data.state !== "running") {
        draftBatch.clear();
        setDraftText("");
        void refresh();
      }
    });
    source.addEventListener("error", () => {
      // EventSource retries on its own; a snapshot covers a missed frame.
      void refresh();
    });

    return () => {
      draftBatch.clear();
      source.close();
    };
  }, [refresh, taskId]);

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
