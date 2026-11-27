import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ActivityItem,
  ContextUsage,
  McpStatus,
  MessageMode,
  QueuedMessage,
  RunError,
  Snapshot,
  SubmitMessageResponse,
  UsageSummary,
} from "../shared/types";
import type { ChatTransport, QueueMutation, TransportSendResult } from "./use-chat";
import { useChat } from "./use-chat";

/** The bot chat has no token or MCP accounting; these keep the shared snapshot shape. */
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

export interface BotChatSnapshot {
  botId: string;
  messages: Snapshot["messages"];
  activity?: ActivityItem[];
  running: boolean;
  error?: string;
}

function newestMessage(messages: BotChatSnapshot["messages"]) {
  let newest: BotChatSnapshot["messages"][number] | undefined;
  for (const message of messages) {
    if (newest === undefined || message.order >= newest.order) newest = message;
  }
  return newest;
}

export function runErrorFrom(snapshot: BotChatSnapshot): RunError | null {
  if (snapshot.error === undefined || snapshot.error.trim() === "") return null;
  const anchor = newestMessage(snapshot.messages);
  return {
    id: `bot-error:${anchor?.id ?? "empty"}:${snapshot.error}`,
    class: "BotError",
    message: snapshot.error,
    // A new send adds a row, so the id and time stay put while polling one failure.
    // With no row yet, a stable sentinel beats a timestamp that moves every poll.
    at: anchor?.timestamp ?? new Date(0).toISOString(),
  };
}

function asSnapshot(botId: string, snapshot: BotChatSnapshot): Snapshot {
  return {
    conversationId: `bot:${botId}`,
    messages: snapshot.messages,
    activity: snapshot.activity ?? [],
    from: 0,
    hasEarlier: false,
    run: snapshot.running ? "running" : "idle",
    runError: runErrorFrom(snapshot),
    queue: [],
    steers: [],
    queueRevision: 0,
    usage: EMPTY_USAGE,
    context: EMPTY_CONTEXT,
    mcp: EMPTY_MCP,
    draft: { text: "", thinking: "", revision: 0 },
  };
}

/**
 * The bot API has no event stream. The shim opens on the next microtask so the shared
 * chat core treats the transport as connected, then polling reconciles each snapshot.
 */
function openInertStream(): EventSource {
  let closed = false;
  const shim = {
    CONNECTING: 0,
    OPEN: 1,
    CLOSED: 2,
    readyState: 0,
    url: "",
    withCredentials: false,
    onopen: null as ((event: Event) => void) | null,
    onerror: null,
    onmessage: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
    close() {
      if (closed) return;
      closed = true;
      (shim as { readyState: number }).readyState = 2;
    },
  } as unknown as EventSource;
  queueMicrotask(() => {
    if (closed) return;
    (shim as { readyState: number }).readyState = 1;
    shim.onopen?.call(shim, new Event("open"));
  });
  return shim;
}

function createBotTransport(botId: string): ChatTransport {
  const base = `/api/bots/${encodeURIComponent(botId)}/chat`;
  return {
    async readSnapshot() {
      const response = await fetch(base, { cache: "no-store" });
      if (!response.ok) return null;
      const snapshot = (await response.json()) as BotChatSnapshot;
      return { snapshot: asSnapshot(botId, snapshot), stale: false };
    },
    async readHistory() {
      // A bot conversation is read whole; there is no earlier-page endpoint.
      return null;
    },
    async send(text, mode, attachments): Promise<TransportSendResult> {
      if (attachments.length > 0) {
        return { ok: false, error: "Bots do not accept attachments yet." };
      }
      try {
        const response = await fetch(base, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (response.status === 409) {
          return {
            ok: false,
            conflict: true,
            error: "The bot is still working. Try again when it is idle.",
          };
        }
        if (!response.ok) {
          const reason = (await response.text()).trim();
          return {
            ok: false,
            error: reason.length > 0 ? reason : "Message was not sent",
          };
        }
        const snapshot = (await response.json()) as BotChatSnapshot;
        const placed = [...snapshot.messages]
          .reverse()
          .find((message) => message.role === "user" && message.text.trim() === text);
        const data: SubmitMessageResponse = {
          // The POST returns the placed user row; a missing row is reconciled by a refresh.
          message: placed ?? {
            id: `bot-send-${Date.now().toString(36)}`,
            role: "user",
            text,
            timestamp: new Date().toISOString(),
            order: 0,
          },
          mode,
          queued: false,
          placed: placed !== undefined,
          queue: [],
        };
        return { ok: true, data };
      } catch {
        return { ok: false, error: "Message was not sent" };
      }
    },
    async cancelQueued(): Promise<QueueMutation | null> {
      return null;
    },
    async steerQueued(): Promise<TransportSendResult> {
      return { ok: false, error: null };
    },
    async unsendSteer(): Promise<{
      steer: QueuedMessage;
      steers: QueuedMessage[];
      queueRevision?: number;
    } | null> {
      return null;
    },
    async stop() {
      // The bot route has no stop endpoint; the run settles on its own.
    },
    async dismissRunError() {
      // Dismissal is local: the next snapshot without an error clears it.
    },
    openStream() {
      return openInertStream();
    },
  };
}

/**
 * The bot surface uses the one chat core over `GET/POST /api/bots/:id/chat`. Everything
 * above the transport — transcript rows, scroll, status and the composer — is shared.
 */
export function useBotChat(botId: string) {
  const [error, setError] = useState<string | null>(null);
  const transport = useMemo(() => createBotTransport(botId), [botId]);
  const chat = useChat({ transport, publishLiveness: false, snapshotActivity: true });
  const { dismissRunError } = chat;

  // Poll after a send until the settled snapshot flips the run back to idle.
  useEffect(() => {
    if (!chat.running) return;
    const timer = window.setInterval(() => void chat.refresh(), 800);
    return () => window.clearInterval(timer);
  }, [chat.running, chat.refresh]);

  const send = useCallback(
    async (text: string, attachments: string[] = [], mode: MessageMode = "queue") => {
      setError(null);
      if (attachments.length > 0) {
        setError("Bots do not accept attachments yet.");
        return false;
      }
      const outcome = await chat.send(text, mode, []);
      if (!outcome.ok) {
        if (outcome.error !== null) setError(outcome.error);
        return false;
      }
      // The POST returns before the answer settles; reconcile the placed row before
      // the optimistic copy is retired for good.
      await chat.refresh();
      return true;
    },
    [chat],
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
    ready: chat.ready,
    runError: chat.runError,
    error,
    send,
    stop: chat.stop,
    cancelQueued: chat.cancelQueued,
    unsendSteer: chat.unsendSteer,
    dismissError,
  };
}

export type BotChatState = ReturnType<typeof useBotChat>;
