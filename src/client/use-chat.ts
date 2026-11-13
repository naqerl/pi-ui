import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { applyTaskToolResult, sameActivity } from "../shared/activity-optimistic";
import type { DashboardState } from "../shared/dashboard";
import { isQueuedNotice, queuedMessageId } from "../shared/queue";
import {
  acceptDeltaRevision,
  adoptSnapshotRevision,
  resetStreamRevisions,
} from "../shared/revisions";
import {
  consumeSteer,
  consumeSteersInMessages,
  dropSteer,
  mergeLiveSteers,
  type PendingSteer,
  rebuildSteersFromSnapshot,
} from "../shared/steers";
import { carryWorkingTraces } from "../shared/task-status";
import type {
  ActivityItem,
  ChatMessage,
  ContextUsage,
  DelegateRunView,
  DiagramRef,
  McpEventsState,
  McpStatus,
  MessageMode,
  ModelOption,
  QueuedMessage,
  RunError,
  RunState,
  Snapshot,
  StreamActivity,
  StreamDraftSync,
  StreamMessageDone,
  StreamNotice,
  StreamRunState,
  StreamSteerDropped,
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
import { mergeWindow } from "../shared/window";
import {
  buildChatTimeline,
  confirmedOptimistic,
  type OptimisticSend,
  optimisticId,
} from "./chat-timeline";
import { setDashboard } from "./dashboard-store";
import { frameBatch, reduceDraft, refreshBatch } from "./stream-batch";
import { publishTaskChatEvent } from "./task-chat-events";
import { isThinking } from "./working-state";

export type { TimelineItem } from "./chat-timeline";

const EMPTY_EVENTS: McpEventsState = {
  subscriptions: [],
  events: [],
  notice: null,
  revision: 0,
};

/** A send that failed for a reason worth showing carries it in `error`. */
export type SendOutcome = { ok: true } | { ok: false; error: string | null };

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
    if (notice !== undefined && !isQueuedNotice(notice) && notice.kind === "job") {
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

/** A client key lets the optimistically painted bubble keep its id once the server confirms. */
function newClientKey(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function markSendTiming(name: string, mode: MessageMode): void {
  try {
    performance.mark(name, { detail: { mode } });
  } catch {
    // Older browsers without custom mark details still get the plain mark.
    try {
      performance.mark(name);
    } catch {
      // Timing is a diagnostic; a failure must never affect sending.
    }
  }
}

function measureSendTiming(name: string, start: string, end: string): void {
  try {
    performance.measure(name, start, end);
  } catch {
    // The marks can be cleared by a devtools session; a missing measure is harmless.
  }
}

/** The id a pending send already has, matching the queued item the server will confirm. */

/** Messages fetched per scroll-up page. */
const HISTORY_PAGE = 30;
/** A failed state fetch retries from here, doubling up to the cap. */
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/** The same transcript row can arrive as a provisional copy before its entry is placed. */
function sameMessage(left: ChatMessage, right: ChatMessage): boolean {
  return left.id === right.id || (left.steerKey !== undefined && left.steerKey === right.steerKey);
}

/** Adds an older page in front of what is held, skipping anything already there. */
function prependPage<T extends { id: string }>(current: T[], page: T[]): T[] {
  const held = new Set(current.map((item) => item.id));
  return [...page.filter((item) => !held.has(item.id)), ...current];
}

/** A snapshot read, with the service worker's stale-cache marker kept out of the data. */
export interface SnapshotRead {
  snapshot: Snapshot;
  stale: boolean;
}

export type TransportSendResult =
  | { ok: true; data: SubmitMessageResponse }
  | { ok: false; conflict?: boolean; error: string | null };

export interface QueueMutation {
  queue?: QueuedMessage[];
  steers?: QueuedMessage[];
  queueRevision?: number;
}

/**
 * Where a conversation lives. The main chat and the plan chat speak different HTTP routes
 * but share every piece of client behaviour above this seam: transcript, scroll, queue,
 * steer revisions, optimistic rows, run status and the stream reducer.
 */
export interface ChatTransport {
  readSnapshot(from: number | null): Promise<SnapshotRead | null>;
  readHistory(before: number, limit: number): Promise<TranscriptHistory | null>;
  send(
    text: string,
    mode: MessageMode,
    attachments: string[],
    queueKey: string,
  ): Promise<TransportSendResult>;
  cancelQueued(id: string): Promise<QueueMutation | null>;
  steerQueued(id: string): Promise<TransportSendResult>;
  unsendSteer(
    id: string,
  ): Promise<{ steer: QueuedMessage; steers: QueuedMessage[]; queueRevision?: number } | null>;
  stop(): Promise<void>;
  dismissRunError(id: string): Promise<void>;
  openStream(): EventSource;
}

const MAIN_CHAT_TRANSPORT: ChatTransport = {
  async readSnapshot(from) {
    const response = await fetch(from === null ? "/api/state" : `/api/state?from=${from}`, {
      cache: "no-store",
    });
    if (!response.ok) return null;
    return {
      snapshot: (await response.json()) as Snapshot,
      stale: response.headers.get("x-pi-stale") === "1",
    };
  },
  async readHistory(before, limit) {
    const response = await fetch(`/api/history?before=${before}&limit=${limit}`, {
      cache: "no-store",
    });
    if (!response.ok) return null;
    return (await response.json()) as TranscriptHistory;
  },
  async send(text, mode, attachments, queueKey) {
    try {
      const response = await fetch("/api/message", {
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
      const response = await fetch(`/api/queue/${encodeURIComponent(id)}`, {
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
      const response = await fetch(`/api/queue/${encodeURIComponent(id)}`, {
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
      const response = await fetch(`/api/steer/${encodeURIComponent(id)}`, {
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
      await fetch("/api/stop", { method: "POST" });
    } catch {
      // Ignore; the run state event is authoritative.
    }
  },
  async dismissRunError(id) {
    await fetch("/api/run/error/dismiss", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => undefined);
  },
  openStream() {
    return new EventSource("/api/stream");
  },
};

export interface UseChatOptions {
  /** Load the whole transcript at once (activity and events pages). */
  fullHistory?: boolean;
  /** Required for any conversation other than the main chat. */
  transport?: ChatTransport;
  /** Observe each snapshot; the plan chat reads its pending question set from here. */
  onSnapshot?: (snapshot: Snapshot) => void;
}

export function useChat(options: UseChatOptions = {}) {
  const fullHistory = options.fullHistory === true;
  const transport = options.transport ?? MAIN_CHAT_TRANSPORT;
  const onSnapshotRef = useRef(options.onSnapshot);
  onSnapshotRef.current = options.onSnapshot;
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [liveTools, setLiveTools] = useState<ToolActivity[]>([]);
  const [draftText, setDraftText] = useState("");
  const [draftThinking, setDraftThinking] = useState("");
  const draftBatch = useMemo(
    () =>
      frameBatch<{ kind: "text" | "thinking"; delta: StreamTextDelta }>(
        (items) => {
          const text = items.filter((item) => item.kind === "text").map((item) => item.delta);
          const thinking = items
            .filter((item) => item.kind === "thinking")
            .map((item) => item.delta);
          if (text.length > 0) setDraftText((current) => reduceDraft(current, text));
          if (thinking.length > 0) setDraftThinking((current) => reduceDraft(current, thinking));
        },
        (run) => requestAnimationFrame(run),
        (id) => cancelAnimationFrame(id),
      ),
    [],
  );

  const [runState, setRunState] = useState<RunState>("idle");
  const [runError, setRunError] = useState<RunError | null>(null);
  /** Transport loss is shown by the same header, but never used to guess idle. */
  const [connectionError, setConnectionError] = useState<RunError | null>(null);
  const [dismissedErrors, setDismissedErrors] = useState<ReadonlySet<string>>(() => new Set());
  const [delegates, setDelegates] = useState<DelegateRunView[]>([]);
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  /** Newest queue/steer revision applied; a snapshot below it is stale for those lists. */
  const queueRevision = useRef(0);
  const [mcp, setMcp] = useState<McpStatus>({ servers: [], unavailable: [] });
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [context, setContext] = useState<ContextUsage | null>(null);
  const [mcpEvents, setMcpEvents] = useState<McpEventsState>(EMPTY_EVENTS);
  const [steers, setSteers] = useState<PendingSteer[]>([]);
  /** Sends painted before the server answers; each leaves on confirmation or failure. */
  const [optimistic, setOptimistic] = useState<OptimisticSend[]>([]);
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
  const initialLedger = { tasks: [], revision: -1 } satisfies TaskLedger;
  const taskLedgerRef = useRef<TaskLedger>(initialLedger);
  const [taskLedger, setTaskLedger] = useState<TaskLedger>(initialLedger);
  /** The current refresh function, so a retry timer never holds a stale closure. */
  const refreshRef = useRef<() => Promise<void>>(async () => undefined);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const retryDelay = useRef(RETRY_MIN_MS);

  const applyTasks = useCallback((ledger: TaskLedger) => {
    if (ledger.revision < taskRevision.current) return;
    taskRevision.current = ledger.revision;
    // A snapshot that omits run activity must not take a Working badge back down.
    const previous = taskLedgerRef.current;
    const next: TaskLedger = {
      ...ledger,
      planning: ledger.planning ?? previous.planning ?? [],
      activity: carryWorkingTraces(previous.activity, ledger.activity, ledger.tasks),
    };
    taskLedgerRef.current = next;
    setTaskLedger(next);
  }, []);

  const applyDraft = useCallback(
    (draft: StreamDraftSync, adoptLower = false) => {
      if (!adoptLower && draft.revision < draftRevision.current) return;
      draftRevision.current = adoptLower
        ? adoptSnapshotRevision(draftRevision.current, draft.revision)
        : draft.revision;
      draftBatch.clear();
      setDraftText(draft.text);
      setDraftThinking(draft.thinking);
    },
    [draftBatch],
  );

  const applyEvents = useCallback((state: McpEventsState) => {
    if (state.revision < eventsRevision.current) return;
    eventsRevision.current = state.revision;
    setMcpEvents(state);
  }, []);

  const scheduleRetry = useCallback(() => {
    if (retryTimer.current !== undefined) return;
    const delay = retryDelay.current;
    retryTimer.current = setTimeout(() => {
      retryTimer.current = undefined;
      void refreshRef.current();
    }, delay);
    retryDelay.current = Math.min(RETRY_MAX_MS, delay * 2);
  }, []);

  const clearRetry = useCallback(() => {
    if (retryTimer.current !== undefined) {
      clearTimeout(retryTimer.current);
      retryTimer.current = undefined;
    }
    retryDelay.current = RETRY_MIN_MS;
  }, []);

  /** True when this queue/steer update is at least as new as the one already shown. */
  const acceptQueueRevision = useCallback((revision: number | undefined): boolean => {
    if (revision === undefined) return true;
    if (revision < queueRevision.current) return false;
    queueRevision.current = revision;
    return true;
  }, []);

  const readState = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    try {
      const from = windowFrom.current ?? (fullHistory ? 0 : null);
      const read = await transport.readSnapshot(from);
      if (read === null) {
        scheduleRetry();
        return;
      }
      const { snapshot } = read;
      if (sequence !== refreshSequence.current) return;
      onSnapshotRef.current?.(snapshot);
      const snapshotFrom = snapshot.from ?? 0;
      // The first snapshot may have been read before a send committed. Keep what
      // the response or SSE already painted instead of taking it off screen.
      const firstSnapshot = conversationRef.current === null;
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
      if (sameConversation || firstSnapshot) {
        setMessages((current) => mergeWindow(current, snapshotFrom, fresh.messages, sameMessage));
        setActivity((current) => mergeWindow(current, snapshotFrom, freshActivity, sameActivity));
      } else {
        setMessages(fresh.messages);
        setActivity(freshActivity);
      }
      const persistedActivityIds = new Set(snapshot.activity.map((item) => item.id));
      // A restarted server counts from 1 again; its snapshot replaces our stale counter.
      if (snapshot.toolsRevision !== undefined) {
        toolsRevision.current = adoptSnapshotRevision(
          toolsRevision.current,
          snapshot.toolsRevision,
        );
      }
      if (snapshot.activeTools !== undefined) {
        setLiveTools(snapshot.activeTools.filter((item) => !persistedActivityIds.has(item.id)));
      } else {
        setLiveTools((current) => current.filter((item) => !persistedActivityIds.has(item.id)));
      }
      setRunState(snapshot.run);
      if (snapshot.runError !== undefined) setRunError(snapshot.runError);
      if (snapshot.delegates !== undefined) setDelegates(snapshot.delegates);
      // A send response or live queue update can land after this snapshot was
      // read. Its revision wins; otherwise the pending bubble would blink out.
      if (acceptQueueRevision(snapshot.queueRevision)) {
        setQueue(snapshot.queue);
        setSteers((current) =>
          rebuildSteersFromSnapshot(
            consumeSteersInMessages(current, snapshot.messages),
            // A snapshot read before the placement can still list a steer whose row is
            // already in `messages`; never paint the pending copy beside its delivered row.
            consumeSteersInMessages(snapshot.steers ?? [], snapshot.messages),
          ),
        );
      }
      setMcp(snapshot.mcp ?? { servers: [], unavailable: [] });
      setUsage(snapshot.usage ?? null);
      setContext(snapshot.context ?? null);
      if (snapshot.draft !== undefined) applyDraft(snapshot.draft, true);
      if (snapshot.mcpEvents !== undefined) applyEvents(snapshot.mcpEvents);
      if (snapshot.tasks !== undefined) applyTasks(snapshot.tasks);
      setReady(true);
      // A service worker may answer a failed request from its cache; keep what it showed,
      // but ask the network again instead of treating the cached render as hydrated.
      if (read.stale) scheduleRetry();
      else clearRetry();
    } catch {
      // Keep the state already on screen and try again rather than showing an empty chat.
      scheduleRetry();
    }
  }, [
    acceptQueueRevision,
    applyDraft,
    applyEvents,
    applyTasks,
    clearRetry,
    fullHistory,
    scheduleRetry,
    transport,
  ]);

  const refreshes = useMemo(() => refreshBatch(readState), [readState]);
  const refreshState = refreshes.request;
  useEffect(() => {
    refreshes.open();
    return () => refreshes.close();
  }, [refreshes]);

  refreshRef.current = refreshState;

  /** Fetches the page of transcript just older than what is held. */
  const loadEarlier = useCallback(async () => {
    const before = windowFrom.current;
    if (historyLoading.current || before === null || !hasEarlierRef.current) return;
    historyLoading.current = true;
    setLoadingEarlier(true);
    try {
      const page = await transport.readHistory(before, HISTORY_PAGE);
      if (page === null) return;
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
  }, [transport]);

  useEffect(() => {
    void refreshState();
    const source = transport.openStream();
    let active = true;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refreshState();
    };
    const refreshOnFocus = () => void refreshState();
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshOnFocus);
    window.addEventListener("pageshow", refreshOnFocus);
    const reportOfflineSteers = () => {
      const reason = "The connection to the server closed before the steer was delivered.";
      setSteers((current) => {
        let next = current;
        for (const steer of current) {
          if (steer.dropped === undefined) next = dropSteer(next, steer.id, reason);
        }
        return next;
      });
    };
    source.onopen = () => {
      setConnectionError(null);
      // A new process counts its stream revisions from 1 again.
      const revisions = resetStreamRevisions();
      draftRevision.current = revisions.draft;
      toolsRevision.current = revisions.tools;
      // A restarted server counts its queue revisions from zero again.
      queueRevision.current = 0;
      void refreshState();
    };
    source.onerror = () => {
      if (!active) return;
      if (source.readyState === EventSource.CLOSED) reportOfflineSteers();
      setConnectionError({
        id: `connection-${Date.now().toString(36)}`,
        class: "ConnectionError",
        message: "Lost the connection to the server; reconnecting.",
        at: new Date().toISOString(),
      });
    };

    // The server writes this on every heartbeat and on a new stream. Receiving
    // one is proof it is alive, so an old transport error cannot claim offline.
    source.addEventListener("liveness", () => {
      setConnectionError(null);
    });

    source.addEventListener("delegates", (event) => {
      const data = parseEvent<DelegateRunView[]>(event as MessageEvent<string>);
      if (Array.isArray(data)) setDelegates(data);
    });

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

    source.addEventListener("task.chat", (event) => {
      const data = parseEvent<{ taskId: string; event: string; data: unknown }>(
        event as MessageEvent<string>,
      );
      if (data && typeof data.taskId === "string" && typeof data.event === "string") {
        publishTaskChatEvent(data);
      }
    });

    source.addEventListener("diagram", (event) => {
      const data = parseEvent<DiagramRef>(event as MessageEvent<string>);
      if (!data || typeof data.id !== "string" || !Number.isSafeInteger(data.revision)) return;
      setMessages((current) =>
        current.map((message) => {
          if (message.parts === undefined) return message;
          let changed = false;
          const parts = message.parts.map((part) => {
            if (part.kind !== "diagram" || part.diagram.id !== data.id) return part;
            if (part.diagram.revision === data.revision) return part;
            changed = true;
            return {
              kind: "diagram" as const,
              diagram: { id: part.diagram.id, revision: data.revision },
            };
          });
          return changed ? { ...message, parts } : message;
        }),
      );
    });

    source.addEventListener("run.state", (event) => {
      const data = parseEvent<StreamRunState>(event as MessageEvent<string>);
      if (!data) return;
      setRunState(data.state);
      setRunError(data.runError ?? null);
      if (acceptQueueRevision(data.queueRevision)) {
        if (data.queue !== undefined) setQueue(data.queue);
        if (data.steers !== undefined) {
          setSteers((current) => mergeLiveSteers(current, data.steers ?? []));
        }
      }
      if (data.state !== "running") {
        draftBatch.clear();
        setDraftText("");
        setDraftThinking("");
        setLiveTools([]);
        void refreshState();
      }
    });

    source.addEventListener("steer.dropped", (event) => {
      const data = parseEvent<StreamSteerDropped>(event as MessageEvent<string>);
      if (!data) return;
      setSteers((current) => dropSteer(current, data.id, data.reason));
    });

    source.addEventListener("message.delta", (event) => {
      const data = parseEvent<StreamTextDelta>(event as MessageEvent<string>);
      if (!data) return;
      const revision = acceptDeltaRevision(draftRevision.current, data.revision);
      if (revision === null) return;
      draftRevision.current = revision;
      draftBatch.push({ kind: "text", delta: data });
    });

    source.addEventListener("thinking.delta", (event) => {
      const data = parseEvent<StreamTextDelta>(event as MessageEvent<string>);
      if (!data) return;
      const revision = acceptDeltaRevision(draftRevision.current, data.revision);
      if (revision === null) return;
      draftRevision.current = revision;
      draftBatch.push({ kind: "thinking", delta: data });
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
          setOptimistic((current) => current.filter((item) => !confirmedOptimistic(item, message)));
          if (message.steerKey !== undefined) {
            setSteers((current) => consumeSteer(current, message.steerKey));
          }
        }
        if (jobActivity.length > 0) setActivity((current) => addJobActivity(current, jobActivity));
        draftBatch.clear();
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
          current.some((item) => item.id === message.id)
            ? current.map((item) => (item.id === message.id ? message : item))
            : [...current, message],
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
      draftBatch.flush();
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
      // A task transition is visible as soon as its result confirms it; the snapshot
      // later reconciles this row by id (or task, tool and start) instead of adding it twice.
      setActivity((current) =>
        applyTaskToolResult(current, {
          toolCallId: data.toolCallId,
          name: data.name,
          isError: data.isError,
          activity: data.activity,
          timestamp: data.activity.timestamp,
        }),
      );
      if (typeof data.toolsRevision === "number") {
        toolsRevision.current = Math.max(toolsRevision.current, data.toolsRevision);
      }
      void refreshState();
    });

    return () => {
      active = false;
      if (retryTimer.current !== undefined) {
        clearTimeout(retryTimer.current);
        retryTimer.current = undefined;
      }
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshOnFocus);
      window.removeEventListener("pageshow", refreshOnFocus);
      source.close();
      draftBatch.clear();
    };
  }, [
    acceptQueueRevision,
    applyDraft,
    applyEvents,
    applyTasks,
    draftBatch,
    refreshState,
    transport,
  ]);

  // A snapshot, SSE message, queue update or older page can confirm a pending send at any
  // time. Retire the optimistic copy then, not only when its own fetch response arrives.
  useEffect(() => {
    if (optimistic.length === 0) return;
    setOptimistic((current) => {
      const next = current.filter(
        (item) =>
          !messages.some((message) => confirmedOptimistic(item, message)) &&
          !queue.some((item2) => queuedMessageId(item2) === optimisticId(item)) &&
          !(item.mode === "steer" && steers.some((steer) => steer.key === item.key)),
      );
      return next.length === current.length ? current : next;
    });
  }, [messages, queue, steers, optimistic]);

  if (draftThinking.length === 0) draftThinkingAt.current = null;
  else if (draftThinkingAt.current === null) draftThinkingAt.current = new Date().toISOString();

  const timeline = useMemo(
    () =>
      buildChatTimeline({
        messages,
        activity,
        liveTools,
        draftText,
        draftThinking,
        draftThinkingAt: draftThinkingAt.current,
        steers,
        queue,
        optimistic,
      }),
    [messages, activity, liveTools, draftText, draftThinking, steers, queue, optimistic],
  );

  const send = useCallback(
    async (
      text: string,
      mode: MessageMode = "queue",
      attachments: string[] = [],
    ): Promise<SendOutcome> => {
      const trimmed = text.trim();
      if (trimmed.length === 0 && attachments.length === 0) return { ok: false, error: null };

      // Paint the bubble now; the request only confirms it. The stable key lets the
      // queued/placed copy replace this one by id instead of remounting it.
      const key = newClientKey();
      const startMark = `pi.chat.send.start.${key}`;
      markSendTiming(startMark, mode);
      setOptimistic((current) => [
        ...current,
        {
          key,
          text: trimmed,
          mode,
          createdAt: new Date().toISOString(),
          attachments: [...attachments],
        },
      ]);
      requestAnimationFrame(() => {
        const paintMark = `pi.chat.send.paint.${key}`;
        markSendTiming(paintMark, mode);
        measureSendTiming("pi.chat.send.paint", startMark, paintMark);
      });
      const retire = () => setOptimistic((current) => current.filter((item) => item.key !== key));

      try {
        const result = await transport.send(trimmed, mode, attachments, key);
        const responseMark = `pi.chat.send.response.${key}`;
        markSendTiming(responseMark, mode);
        measureSendTiming("pi.chat.send.response", startMark, responseMark);
        if (!result.ok) {
          retire();
          if (result.conflict) await refreshState();
          return { ok: false, error: result.error };
        }
        const data = result.data;
        // The queue and the place message use the same client key, so dropping the
        // optimistic copy in this same batch never blanks the bubble.
        retire();
        const queueIsNewest = acceptQueueRevision(data.queueRevision);
        if (queueIsNewest) setQueue(data.queue);
        if (!data.queued && !(runState === "running")) {
          setRunState("running");
          draftBatch.clear();
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
          if (message !== undefined && message.steerKey !== undefined) {
            setSteers((current) => consumeSteer(current, message.steerKey));
          }
        }
        if (data.steers !== undefined && queueIsNewest) {
          setSteers((current) => rebuildSteersFromSnapshot(current, data.steers ?? []));
        }
        return { ok: true };
      } catch {
        retire();
        return { ok: false, error: "Message was not sent" };
      }
    },
    [runState, refreshState, draftBatch, acceptQueueRevision, transport],
  );

  const cancelQueued = useCallback(
    async (id: string): Promise<boolean> => {
      const data = await transport.cancelQueued(id);
      if (data === null) return false;
      if (acceptQueueRevision(data.queueRevision) && data.queue !== undefined) {
        setQueue(data.queue);
      }
      return true;
    },
    [acceptQueueRevision, transport],
  );

  /** Takes back the newest steer the run has not reached; null when there is none left to take. */
  const unsendSteer = useCallback(async (): Promise<QueuedMessage | null> => {
    let latest: PendingSteer | undefined;
    for (let index = steers.length - 1; index >= 0; index -= 1) {
      const candidate = steers[index];
      if (candidate !== undefined && candidate.dropped === undefined) {
        latest = candidate;
        break;
      }
    }
    if (latest === undefined) return null;
    const data = await transport.unsendSteer(latest.id);
    if (data === null) {
      await refreshState();
      return null;
    }
    if (acceptQueueRevision(data.queueRevision)) {
      setSteers((current) => rebuildSteersFromSnapshot(current, data.steers));
    }
    return data.steer;
  }, [steers, refreshState, acceptQueueRevision, transport]);

  const steerQueued = useCallback(
    async (id: string): Promise<boolean> => {
      const result = await transport.steerQueued(id);
      if (!result.ok) {
        if (result.conflict) await refreshState();
        return false;
      }
      if (acceptQueueRevision(result.data.queueRevision)) {
        setQueue(result.data.queue);
      }
      setRunState("running");
      return true;
    },
    [refreshState, acceptQueueRevision, transport],
  );

  const stop = useCallback(async () => {
    await transport.stop();
    await refreshState();
  }, [refreshState, transport]);

  const visibleError = useMemo(() => {
    for (const candidate of [connectionError, runError]) {
      if (candidate !== null && !dismissedErrors.has(candidate.id)) return candidate;
    }
    return null;
  }, [connectionError, dismissedErrors, runError]);

  const dismissRunError = useCallback(
    (id: string) => {
      setDismissedErrors((current) => new Set(current).add(id));
      setConnectionError((current) => (current?.id === id ? null : current));
      setRunError((current) => (current?.id === id ? null : current));
      void transport.dismissRunError(id);
    },
    [transport],
  );

  return {
    timeline,
    runError: visibleError,
    dismissRunError,
    delegates,
    running: runState === "running",
    thinking: runState === "running" && isThinking(draftThinking, draftText),
    interrupted: runState === "interrupted",
    queue,
    mcp,
    usage,
    context,
    refresh: refreshState,
    mcpEvents,
    tasks: taskLedger.tasks,
    planning: taskLedger.planning ?? [],
    taskActivity: taskLedger.activity,
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
