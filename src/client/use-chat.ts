import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DashboardState } from "../shared/dashboard";
import { pendingSteerMessage } from "../shared/steers";
import type {
  ActivityItem,
  ChatMessage,
  ContextUsage,
  McpEventsState,
  McpStatus,
  MessageMode,
  ModelOption,
  QueuedMessage,
  RunState,
  Snapshot,
  StreamActivity,
  StreamDraftSync,
  StreamMessageDone,
  StreamNotice,
  StreamRunState,
  StreamTextDelta,
  StreamTheme,
  StreamToolEnd,
  StreamToolStart,
  SubmitMessageResponse,
  TaskLedger,
  ToolActivity,
  TranscriptHistory,
  UsageSummary,
} from "../shared/types";
import { setDashboard } from "./dashboard-store";

const EMPTY_EVENTS: McpEventsState = {
  subscriptions: [],
  events: [],
  notice: null,
  revision: 0,
};

/** A send that failed for a reason worth showing carries it in `error`. */
export type SendOutcome = { ok: true } | { ok: false; error: string | null };

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

/**
 * Job results belong on the activity page. Older servers still send them as user messages, so
 * move those out of the chat before the transcript reaches the view.
 */
function separateJobResults(messages: ChatMessage[]): {
  messages: ChatMessage[];
  activity: ActivityItem[];
} {
  const kept: ChatMessage[] = [];
  const activity: ActivityItem[] = [];
  for (const message of messages) {
    const notice = message.notice;
    if (notice?.kind === "job") {
      activity.push({
        kind: "job",
        id: `j-${message.id}`,
        notice,
        timestamp: message.timestamp,
        order: message.order,
      });
    } else {
      kept.push(message);
    }
  }
  return { messages: kept, activity };
}

function addJobActivity(current: ActivityItem[], extra: ActivityItem[]): ActivityItem[] {
  if (extra.length === 0) return current;
  const held = new Set(current.map((item) => item.id));
  return [...current, ...extra.filter((item) => !held.has(item.id))];
}

/** Messages fetched per scroll-up page. */
const HISTORY_PAGE = 30;

/** Keeps every held item below `from`, then the snapshot's items from `from` up. */
function mergeWindow<T extends { order: number }>(current: T[], from: number, fresh: T[]): T[] {
  return [...current.filter((item) => item.order < from), ...fresh];
}

/** Adds an older page in front of what is held, skipping anything already there. */
function prependPage<T extends { id: string }>(current: T[], page: T[]): T[] {
  const held = new Set(current.map((item) => item.id));
  return [...page.filter((item) => !held.has(item.id)), ...current];
}

export interface UseChatOptions {
  /** Load the whole transcript at once (activity and events pages). */
  fullHistory?: boolean;
}

export function useChat(options: UseChatOptions = {}) {
  const fullHistory = options.fullHistory === true;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [liveTools, setLiveTools] = useState<ToolActivity[]>([]);
  const [draftText, setDraftText] = useState("");
  const [draftThinking, setDraftThinking] = useState("");
  const [runState, setRunState] = useState<RunState>("idle");
  const [runStartedAt, setRunStartedAt] = useState<string | null>(null);
  const [lastEventAt, setLastEventAt] = useState<string | null>(null);
  const [quietAfterMs, setQuietAfterMs] = useState<number | undefined>(undefined);
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const [mcp, setMcp] = useState<McpStatus>({ servers: [], unavailable: [] });
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [context, setContext] = useState<ContextUsage | null>(null);
  const [mcpEvents, setMcpEvents] = useState<McpEventsState>(EMPTY_EVENTS);
  const [steers, setSteers] = useState<QueuedMessage[]>([]);
  const [ready, setReady] = useState(false);
  const [hasEarlier, setHasEarlier] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  /** Lowest transcript order held; refreshes ask for everything from here up. */
  const windowFrom = useRef<number | null>(null);
  const hasEarlierRef = useRef(false);
  const conversationRef = useRef<string | null>(null);
  const historyLoading = useRef(false);
  const refreshSequence = useRef(0);
  const draftRevision = useRef(0);
  const draftThinkingAt = useRef<string | null>(null);
  const toolsRevision = useRef(0);
  const eventsRevision = useRef(0);
  const taskRevision = useRef(-1);
  const [taskLedger, setTaskLedger] = useState<TaskLedger>({ tasks: [], revision: -1 });

  const applyTasks = useCallback((ledger: TaskLedger) => {
    if (ledger.revision < taskRevision.current) return;
    taskRevision.current = ledger.revision;
    setTaskLedger(ledger);
  }, []);

  const applyDraft = useCallback((draft: StreamDraftSync) => {
    if (draft.revision < draftRevision.current) return;
    draftRevision.current = draft.revision;
    setDraftText(draft.text);
    setDraftThinking(draft.thinking);
  }, []);

  const applyEvents = useCallback((state: McpEventsState) => {
    if (state.revision < eventsRevision.current) return;
    eventsRevision.current = state.revision;
    setMcpEvents(state);
  }, []);

  const refreshState = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      const from = windowFrom.current ?? (fullHistory ? 0 : null);
      const url = from === null ? "/api/state" : `/api/state?from=${from}`;
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) return;
      const snapshot = (await response.json()) as Snapshot;
      if (sequence !== refreshSequence.current) return;
      const snapshotFrom = snapshot.from ?? 0;
      const sameConversation = conversationRef.current === snapshot.conversationId;
      conversationRef.current = snapshot.conversationId;
      if (!sameConversation || windowFrom.current === null || snapshotFrom < windowFrom.current) {
        windowFrom.current = snapshotFrom;
        hasEarlierRef.current = snapshot.hasEarlier === true;
        setHasEarlier(hasEarlierRef.current);
      }
      const fresh = separateJobResults(snapshot.messages);
      const freshActivity = [...snapshot.activity, ...fresh.activity].sort(
        (a, b) => a.order - b.order,
      );
      if (sameConversation) {
        setMessages((current) => mergeWindow(current, snapshotFrom, fresh.messages));
        setActivity((current) => mergeWindow(current, snapshotFrom, freshActivity));
      } else {
        setMessages(fresh.messages);
        setActivity(freshActivity);
      }
      const persistedActivityIds = new Set(snapshot.activity.map((item) => item.id));
      const toolsAreCurrent =
        snapshot.activeTools !== undefined &&
        (snapshot.toolsRevision === undefined || snapshot.toolsRevision >= toolsRevision.current);
      if (toolsAreCurrent && snapshot.activeTools !== undefined) {
        if (snapshot.toolsRevision !== undefined) toolsRevision.current = snapshot.toolsRevision;
        setLiveTools(snapshot.activeTools.filter((item) => !persistedActivityIds.has(item.id)));
      } else {
        setLiveTools((current) => current.filter((item) => !persistedActivityIds.has(item.id)));
      }
      setRunState(snapshot.run);
      setRunStartedAt(snapshot.runStartedAt ?? null);
      setLastEventAt(snapshot.runLastEventAt ?? null);
      if (snapshot.quietAfterMs !== undefined) setQuietAfterMs(snapshot.quietAfterMs);
      setQueue(snapshot.queue);
      setSteers(snapshot.steers ?? []);
      setMcp(snapshot.mcp ?? { servers: [], unavailable: [] });
      setUsage(snapshot.usage ?? null);
      setContext(snapshot.context ?? null);
      if (snapshot.draft !== undefined) applyDraft(snapshot.draft);
      if (snapshot.mcpEvents !== undefined) applyEvents(snapshot.mcpEvents);
      if (snapshot.tasks !== undefined) applyTasks(snapshot.tasks);
      setReady(true);
    } catch {
      // The SSE connection will keep the UI usable once the server is reachable again.
    }
  }, [applyDraft, applyEvents, applyTasks, fullHistory]);

  /** Fetches the page of transcript just older than what is held. */
  const loadEarlier = useCallback(async () => {
    const before = windowFrom.current;
    if (historyLoading.current || before === null || !hasEarlierRef.current) return;
    historyLoading.current = true;
    setLoadingEarlier(true);
    try {
      const response = await fetch(`/api/history?before=${before}&limit=${HISTORY_PAGE}`, {
        cache: "no-store",
      });
      if (!response.ok) return;
      const page = (await response.json()) as TranscriptHistory;
      if (windowFrom.current !== before) return;
      windowFrom.current = page.from;
      hasEarlierRef.current = page.hasEarlier;
      const older = separateJobResults(page.messages);
      setMessages((current) => prependPage(current, older.messages));
      setActivity((current) =>
        prependPage(
          current,
          [...page.activity, ...older.activity].sort((a, b) => a.order - b.order),
        ),
      );
      setHasEarlier(page.hasEarlier);
    } catch {
      // A later scroll tries again.
    } finally {
      historyLoading.current = false;
      setLoadingEarlier(false);
    }
  }, []);

  useEffect(() => {
    void refreshState();
    const source = new EventSource("/api/stream");
    source.onopen = () => {
      void refreshState();
    };

    source.addEventListener("theme", (event) => {
      const data = parseEvent<StreamTheme>(event as MessageEvent<string>);
      if (!data) return;
      window.dispatchEvent(new CustomEvent("pi-theme", { detail: data }));
    });

    source.addEventListener("model", (event) => {
      const data = parseEvent<ModelOption>(event as MessageEvent<string>);
      if (!data) return;
      window.dispatchEvent(new CustomEvent("pi-model", { detail: data }));
    });

    source.addEventListener("draft.sync", (event) => {
      const data = parseEvent<StreamDraftSync>(event as MessageEvent<string>);
      if (data) applyDraft(data);
    });

    source.addEventListener("mcp.events", (event) => {
      const data = parseEvent<McpEventsState>(event as MessageEvent<string>);
      if (data) applyEvents(data);
    });

    source.addEventListener("mcp.status", (event) => {
      const data = parseEvent<McpStatus>(event as MessageEvent<string>);
      if (data) setMcp(data);
    });

    source.addEventListener("dashboard", (event) => {
      const data = parseEvent<DashboardState>(event as MessageEvent<string>);
      if (data) setDashboard(data);
    });

    source.addEventListener("tasks", (event) => {
      const data = parseEvent<TaskLedger>(event as MessageEvent<string>);
      if (data) applyTasks(data);
    });

    source.addEventListener("run.state", (event) => {
      const data = parseEvent<StreamRunState>(event as MessageEvent<string>);
      if (!data) return;
      setRunState(data.state);
      setRunStartedAt(data.startedAt ?? null);
      if (data.lastEventAt !== undefined) setLastEventAt(data.lastEventAt);
      if (data.queue !== undefined) setQueue(data.queue);
      if (data.steers !== undefined) setSteers(data.steers);
      if (data.state !== "running") {
        setDraftText("");
        setDraftThinking("");
        setLiveTools([]);
        void refreshState();
      }
    });

    source.addEventListener("message.delta", (event) => {
      const data = parseEvent<StreamTextDelta>(event as MessageEvent<string>);
      if (!data) return;
      if (data.revision !== undefined) {
        if (data.revision < draftRevision.current) return;
        draftRevision.current = data.revision;
      }
      if (typeof data.full === "string") setDraftText(data.full);
      else setDraftText((current) => current + data.text);
    });

    source.addEventListener("thinking.delta", (event) => {
      const data = parseEvent<StreamTextDelta>(event as MessageEvent<string>);
      if (!data) return;
      if (data.revision !== undefined) {
        if (data.revision < draftRevision.current) return;
        draftRevision.current = data.revision;
      }
      if (typeof data.full === "string") setDraftThinking(data.full);
      else setDraftThinking((current) => current + data.text);
    });

    source.addEventListener("message.done", (event) => {
      const data = parseEvent<StreamMessageDone>(event as MessageEvent<string>);
      if (data?.message) {
        const { messages, activity: jobActivity } = separateJobResults([data.message]);
        const message = messages[0];
        if (message !== undefined) {
          setMessages((current) =>
            current.some((item) => item.id === message.id) ? current : [...current, message],
          );
        }
        if (jobActivity.length > 0) setActivity((current) => addJobActivity(current, jobActivity));
        setDraftText("");
        setDraftThinking("");
      }
      void refreshState();
    });

    source.addEventListener("notice", (event) => {
      const data = parseEvent<StreamNotice>(event as MessageEvent<string>);
      if (!data) return;
      const { messages, activity: jobActivity } = separateJobResults([data.message]);
      const message = messages[0];
      if (message !== undefined) {
        setMessages((current) =>
          current.some((item) => item.id === message.id) ? current : [...current, message],
        );
      }
      if (jobActivity.length > 0) setActivity((current) => addJobActivity(current, jobActivity));
    });

    source.addEventListener("activity", (event) => {
      const data = parseEvent<StreamActivity>(event as MessageEvent<string>);
      if (data?.activity.kind !== "job") return;
      setActivity((current) => addJobActivity(current, [data.activity]));
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
      if (typeof data.toolsRevision === "number") {
        toolsRevision.current = Math.max(toolsRevision.current, data.toolsRevision);
      }
    });

    source.addEventListener("tool.end", (event) => {
      const data = parseEvent<StreamToolEnd>(event as MessageEvent<string>);
      if (!data) return;
      const liveId = `live-${data.toolCallId}`;
      setLiveTools((current) =>
        current.map((item) => (item.id === liveId ? { ...data.activity, pending: false } : item)),
      );
      if (typeof data.toolsRevision === "number") {
        toolsRevision.current = Math.max(toolsRevision.current, data.toolsRevision);
      }
      void refreshState();
    });

    return () => source.close();
  }, [applyDraft, applyEvents, applyTasks, refreshState]);

  useEffect(() => {
    if (runState !== "running") return;
    const timer = setInterval(() => {
      void refreshState();
    }, 2000);
    return () => clearInterval(timer);
  }, [runState, refreshState]);

  if (draftThinking.length === 0) draftThinkingAt.current = null;
  else if (draftThinkingAt.current === null) draftThinkingAt.current = new Date().toISOString();

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
          timestamp: draftThinkingAt.current ?? new Date().toISOString(),
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

    // Steers the run has not reached go below everything it is still doing; once delivered, the
    // snapshot has them where they entered the conversation.
    for (const steer of steers) {
      const message = pendingSteerMessage(steer);
      items.push({ kind: "message", order: message.order, message });
    }

    return items.sort((a, b) => a.order - b.order);
  }, [messages, activity, liveTools, draftText, draftThinking, steers]);

  const send = useCallback(
    async (
      text: string,
      mode: MessageMode = "queue",
      attachments: string[] = [],
    ): Promise<SendOutcome> => {
      const trimmed = text.trim();
      if (trimmed.length === 0 && attachments.length === 0) return { ok: false, error: null };

      try {
        const response = await fetch("/api/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: trimmed,
            mode,
            ...(attachments.length > 0 ? { attachments } : {}),
          }),
        });
        if (response.status === 409) {
          await refreshState();
          return { ok: false, error: null };
        }
        if (!response.ok) {
          const reason = (await response.text()).trim();
          return { ok: false, error: reason.length > 0 ? reason : "Message was not sent" };
        }
        const data = (await response.json()) as SubmitMessageResponse;
        setQueue(data.queue);
        if (data.steers !== undefined) setSteers(data.steers);
        if (!data.queued && !(runState === "running")) {
          setRunState("running");
          setRunStartedAt(new Date().toISOString());
          setDraftText("");
          setDraftThinking("");
          setLiveTools([]);
        }
        if (!data.queued && data.placed) {
          const { messages, activity: jobActivity } = separateJobResults([data.message]);
          const message = messages[0];
          if (message !== undefined) {
            setMessages((current) =>
              current.some((item) => item.id === message.id) ? current : [...current, message],
            );
          }
          if (jobActivity.length > 0) {
            setActivity((current) => addJobActivity(current, jobActivity));
          }
        }
        return { ok: true };
      } catch {
        return { ok: false, error: "Message was not sent" };
      }
    },
    [runState, refreshState],
  );

  const cancelQueued = useCallback(async (id: string): Promise<boolean> => {
    try {
      const response = await fetch(`/api/queue/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
      if (!response.ok) return false;
      const data = (await response.json()) as { queue?: QueuedMessage[] };
      if (data.queue !== undefined) setQueue(data.queue);
      return true;
    } catch {
      return false;
    }
  }, []);

  /** Takes back the newest steer the run has not reached; null when there is none left to take. */
  const unsendSteer = useCallback(async (): Promise<QueuedMessage | null> => {
    const latest = steers.at(-1);
    if (latest === undefined) return null;
    try {
      const response = await fetch(`/api/steer/${encodeURIComponent(latest.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "unsend" }),
      });
      if (!response.ok) {
        await refreshState();
        return null;
      }
      const data = (await response.json()) as { steer: QueuedMessage; steers: QueuedMessage[] };
      setSteers(data.steers);
      return data.steer;
    } catch {
      return null;
    }
  }, [steers, refreshState]);

  const steerQueued = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const response = await fetch(`/api/queue/${encodeURIComponent(id)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "steer" }),
        });
        if (response.status === 404) {
          await refreshState();
          return false;
        }
        if (!response.ok) return false;
        const data = (await response.json()) as SubmitMessageResponse;
        setQueue(data.queue);
        setRunState("running");
        return true;
      } catch {
        return false;
      }
    },
    [refreshState],
  );

  const stop = useCallback(async () => {
    try {
      await fetch("/api/stop", { method: "POST" });
      await refreshState();
    } catch {
      // Ignore; the run state event is authoritative.
    }
  }, [refreshState]);

  return {
    timeline,
    running: runState === "running",
    interrupted: runState === "interrupted",
    runStartedAt,
    lastEventAt,
    quietAfterMs,
    queue,
    mcp,
    usage,
    context,
    refresh: refreshState,
    mcpEvents,
    tasks: taskLedger.tasks,
    ready,
    hasEarlier,
    loadingEarlier,
    loadEarlier,
    applyTasks,
    send,
    cancelQueued,
    steerQueued,
    steers,
    unsendSteer,
    stop,
  };
}
