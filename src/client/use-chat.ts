import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActivityItem,
  ChatMessage,
  Snapshot,
  StreamMessageDone,
  StreamRunState,
  StreamTextDelta,
  StreamToolEnd,
  StreamToolStart,
  SubmitMessageResponse,
  ToolActivity,
} from "../shared/types";

export type TimelineItem =
  | { kind: "message"; order: number; message: ChatMessage }
  | { kind: "activity"; order: number; activity: ActivityItem };

function parseEvent<T>(event: MessageEvent<string>): T | null {
  try {
    return JSON.parse(event.data) as T;
  } catch {
    return null;
  }
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [liveTools, setLiveTools] = useState<ToolActivity[]>([]);
  const [draftText, setDraftText] = useState("");
  const [draftThinking, setDraftThinking] = useState("");
  const [running, setRunning] = useState(false);
  const [ready, setReady] = useState(false);
  const refreshSequence = useRef(0);

  const refreshState = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      if (!response.ok) return;
      const snapshot = (await response.json()) as Snapshot;
      if (sequence !== refreshSequence.current) return;
      setMessages(snapshot.messages);
      setActivity(snapshot.activity);
      const persistedActivityIds = new Set(snapshot.activity.map((item) => item.id));
      setLiveTools((current) => current.filter((item) => !persistedActivityIds.has(item.id)));
      setRunning(snapshot.run === "running");
      setReady(true);
    } catch {
      // The SSE connection will keep the UI usable once the server is reachable again.
    }
  }, []);

  useEffect(() => {
    void refreshState();
    const source = new EventSource("/api/stream");

    source.onopen = () => {
      setDraftText("");
      setDraftThinking("");
      setLiveTools([]);
    };

    source.addEventListener("run.state", (event) => {
      const data = parseEvent<StreamRunState>(event as MessageEvent<string>);
      if (!data) return;
      setRunning(data.state === "running");
      if (data.state === "idle") {
        setDraftText("");
        setDraftThinking("");
        setLiveTools([]);
        void refreshState();
      }
    });

    source.addEventListener("message.delta", (event) => {
      const data = parseEvent<StreamTextDelta>(event as MessageEvent<string>);
      if (data) setDraftText((current) => current + data.text);
    });

    source.addEventListener("thinking.delta", (event) => {
      const data = parseEvent<StreamTextDelta>(event as MessageEvent<string>);
      if (data) setDraftThinking((current) => current + data.text);
    });

    source.addEventListener("message.done", (event) => {
      const data = parseEvent<StreamMessageDone>(event as MessageEvent<string>);
      if (data?.message) {
        const message = data.message;
        setMessages((current) =>
          current.some((item) => item.id === message.id) ? current : [...current, message],
        );
      }
      setDraftText("");
      setDraftThinking("");
      void refreshState();
    });

    source.addEventListener("tool.start", (event) => {
      const data = parseEvent<StreamToolStart>(event as MessageEvent<string>);
      if (!data) return;
      const tool: ToolActivity = {
        kind: "tool",
        id: `live-${data.toolCallId}`,
        name: data.name,
        arguments: JSON.stringify(data.arguments, null, 2),
        isError: false,
        timestamp: data.timestamp,
        order: Number.MAX_SAFE_INTEGER - 1,
        pending: true,
      };
      setLiveTools((current) => [...current.filter((item) => item.id !== tool.id), tool]);
      setDraftThinking("");
    });

    source.addEventListener("tool.end", (event) => {
      const data = parseEvent<StreamToolEnd>(event as MessageEvent<string>);
      if (!data) return;
      const liveId = `live-${data.toolCallId}`;
      setLiveTools((current) =>
        current.map((item) => (item.id === liveId ? { ...data.activity, pending: false } : item)),
      );
      void refreshState();
    });

    return () => source.close();
  }, [refreshState]);

  const timeline = useMemo(() => {
    const persistedActivityIds = new Set(activity.map((item) => item.id));
    const items: TimelineItem[] = [
      ...messages.map((message) => ({
        kind: "message" as const,
        order: message.order,
        message,
      })),
      ...activity.map((item) => ({ kind: "activity" as const, order: item.order, activity: item })),
      ...liveTools
        .filter((item) => !persistedActivityIds.has(item.id))
        .map((item) => ({
          kind: "activity" as const,
          order: item.order,
          activity: item,
        })),
    ];

    if (draftThinking.length > 0) {
      items.push({
        kind: "activity",
        order: Number.MAX_SAFE_INTEGER - 3,
        activity: {
          kind: "thinking",
          id: "draft-thinking",
          name: "thinking",
          text: draftThinking,
          timestamp: new Date().toISOString(),
          order: Number.MAX_SAFE_INTEGER - 3,
          pending: true,
        },
      });
    }

    if (draftText.length > 0) {
      items.push({
        kind: "message",
        order: Number.MAX_SAFE_INTEGER - 2,
        message: {
          id: "draft-assistant",
          role: "assistant",
          text: draftText,
          timestamp: new Date().toISOString(),
          order: Number.MAX_SAFE_INTEGER - 2,
        },
      });
    }

    return items.sort((a, b) => a.order - b.order);
  }, [messages, activity, liveTools, draftText, draftThinking]);

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      const trimmed = text.trim();
      if (trimmed.length === 0 || running) return false;

      try {
        const response = await fetch("/api/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: trimmed }),
        });
        if (response.status === 409) {
          await refreshState();
          return false;
        }
        if (!response.ok) return false;
        const data = (await response.json()) as SubmitMessageResponse;
        setMessages((current) =>
          current.some((item) => item.id === data.message.id)
            ? current
            : [...current, data.message],
        );
        setRunning(true);
        setDraftText("");
        setDraftThinking("");
        setLiveTools([]);
        return true;
      } catch {
        return false;
      }
    },
    [running, refreshState],
  );

  const stop = useCallback(async () => {
    try {
      await fetch("/api/stop", { method: "POST" });
      await refreshState();
    } catch {
      // Ignore; the run state event is authoritative.
    }
  }, [refreshState]);

  return { timeline, running, ready, send, stop };
}
