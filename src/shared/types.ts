import type { MemoryToolDetails } from "./memory.js";
import type { ChatNotice, JobNoticeDetails } from "./notices.js";
export type RunState = "idle" | "running" | "interrupted";

/** Entry kind used for a steered user message, so the transcript can mark it. */
export const STEER_ENTRY_KIND = "ui.steer";

export type MessageMode = "queue" | "steer";

/** An image kept in `DATA_DIR/media`, served at `/api/media/<id>`. */
export interface MediaRef {
  id: string;
  mimeType: string;
}

/**
 * A pointer to a stored diagram, served at `/api/diagrams/<id>`. Only the revision travels in a
 * snapshot; the source is fetched by the client, so a replace re-renders in place.
 */
export interface DiagramRef {
  id: string;
  revision: number;
}

/** A non-text part of a message. It never carries the source, only where to read it. */
export type MessagePart = { kind: "diagram"; diagram: DiagramRef };

/** The short chip a queued machine notice shows before its transcript entry exists. */
export interface QueuedNotice {
  kind: string;
  /** Short chip text, such as `MCP events`; never the full notice body. */
  label: string;
  /** The kind's icon name, so a pending chip matches the notice it becomes. */
  glyph: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  /** Images sent with a user message. */
  attachments?: MediaRef[];
  /** Richer parts, such as a diagram drawn by a tool. */
  parts?: MessagePart[];
  timestamp: string;
  /** Monotonic ordering key used to interleave messages and activity. */
  order: number;
  isError?: boolean;
  /** True for a message injected into a running turn. */
  steer?: boolean;
  /** A steer still waiting for the run's next turn boundary; it can be taken back. */
  pendingSteer?: boolean;
  /** A follow-up the server holds until the running turn ends. */
  pendingQueue?: boolean;
  /** A user message painted optimistically, before the server has confirmed it. */
  pendingSend?: boolean;
  /** Submission id of a pending queued message, so its bubble can cancel it. */
  queueId?: string;
  /** How many consecutive queued notices this pending chip stands for. */
  queueCount?: number;
  /** Every submission id a grouped pending chip removes with one cancel. */
  queueIds?: string[];
  /** Stable key shared by a pending steer and the transcript entry that consumed it. */
  steerKey?: string;
  /** Why a pending steer never reached the transcript. */
  steerError?: string;
  /**
   * Set when the message is an MCP event; the chat shows a one-line notice. A queued machine
   * notice carries its short chip marker here until the transcript entry replaces it.
   */
  notice?: ChatNotice | QueuedNotice;
  /** Set on the pi-ui version-update note, so the chat can paint it with the theme accent. */
  version?: { from: string | null; to: string; changes?: string };
  /** Set on a durable-repair system line, so it gets its own carded row instead of a warning. */
  repair?: { baseRevision: number };
  /** True when a server restart cut off this assistant response. */
  partial?: boolean;
  /** Input and output tokens for this assistant call. Omitted when the call also produced activity. */
  usage?: TokenSpend;
}

/** Provider-reported input and output for one model call. Cache tokens are not included. */
export interface TokenSpend {
  input: number;
  output: number;
}

export type DelegateRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface DelegateTokenUsage {
  input: number;
  output: number;
  total: number;
  cost: number;
}

/** One sub-agent run, as the activity page and /api/state see it. */
export interface DelegateRunView {
  id: string;
  agent: string;
  task: string;
  taskFirstLine: string;
  cwd: string;
  status: DelegateRunStatus;
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number;
  duration: string;
  usage?: DelegateTokenUsage;
  error?: string;
  resultPath: string;
  activityPath: string;
  resultUrl: string;
  activityUrl: string;
}

/** One message waiting for the current run to finish. */
export interface QueuedMessage {
  id: string;
  text: string;
  createdAt: string;
  /** Media ids sent with the message. */
  attachments?: string[];
  /** Stable key the transcript entry carries once this steer is placed. */
  key?: string;
  /** Durable request id, so a restart replays the same submission instead of adding another. */
  requestId?: string;
  /** A machine notice queued as a chip instead of a user bubble. */
  notice?: QueuedNotice;
}

export interface ToolActivity {
  kind: "tool";
  id: string;
  name: string;
  arguments: string;
  output?: string;
  /** Tool-specific UI data. Never sent to the model. */
  details?: string;
  /** Typed memory-search or memory-read data, when this was a memory tool call. */
  memory?: MemoryToolDetails;
  isError: boolean;
  durationMs?: number;
  timestamp: string;
  order: number;
  pending?: boolean;
  /** Present on the single item that carries this model call's spend. */
  usage?: TokenSpend;
}

export interface ThinkingActivity {
  kind: "thinking";
  id: string;
  name: "thinking";
  text: string;
  timestamp: string;
  order: number;
  pending?: boolean;
  /** Present on the single item that carries this model call's spend. */
  usage?: TokenSpend;
}

/** A background job result. It belongs on the activity page, not in the chat. */
export interface JobActivity {
  kind: "job";
  id: string;
  notice: JobNoticeDetails;
  timestamp: string;
  order: number;
}

export type ActivityItem = ToolActivity | ThinkingActivity | JobActivity;

export interface UsageSummary {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: number;
}

export interface ContextUsage {
  tokens: number;
  window: number | null;
  percent: number | null;
}

export interface McpServerStatus {
  name: string;
  available: boolean;
  authRejected: boolean;
  /** Registered tool names for this server; empty when the server is unavailable. */
  tools: string[];
  /** Transport-level reason while unavailable; never a secret. */
  reason?: string;
}

/** Per-server MCP availability, so a configured-but-unreachable server is visible. */
export interface McpStatus {
  servers: McpServerStatus[];
  unavailable: string[];
}

/** The health of one event stream, independent of the adapter's `status` spelling. */
export type McpSubscriptionState = "active" | "stalled" | "recovering" | "dead" | "cancelled";

export interface McpSubscriptionView {
  /** Adapter id minted by pi-mcp-events; it changes on a restart. */
  id: string;
  /** Durable identity derived from server, name and sorted arguments. */
  stableId: string;
  server: string;
  name: string;
  /** Optional human title; when absent clients fall back to `stableId`. */
  title?: string;
  status: string;
  /** What the watchdog currently believes, not merely what the stream last said. */
  state: McpSubscriptionState;
  arguments: Record<string, unknown>;
  /**
   * Last cursor the server reported, null before the first one. It is opaque:
   * never parse or compare it, and always keep the server's newest value.
   */
  cursor: string | null;
  /** ISO time of the last event delivered to this subscription. */
  lastEventAt?: string;
  /** ISO time of the last heartbeat from the push stream. */
  lastHeartbeatAt?: string;
  /** ISO time of the last poll, successful or failed. */
  lastPollAt?: string;
  /** Why the latest poll or recovery failed. Cleared by a healthy observation. */
  lastError?: string;
  /** ISO time of `lastError`. */
  lastErrorAt?: string;
  /** Consecutive automatic recovery attempts that failed. */
  recoveryFailures?: number;
  /** A re-subscribe succeeded but no post-recovery heartbeat/event has arrived yet. */
  recoveryPending?: boolean;
  /** ISO time of that re-subscribe, used as its silence grace window. */
  recoveryStartedAt?: string;
  /** Watchdog re-opens since the subscription was last healthy. */
  reconnects?: number;
  /** Why the last watchdog re-open happened. */
  lastReconnectReason?: string;
  /** Adapter end reason once the stream has stopped. */
  endReason?: string;
}

export interface McpEventView {
  id: string;
  server: string;
  name: string;
  timestamp: string;
  summary: string;
  /** The stable subscription already delivered this event before a restart. */
  replayed?: boolean;
}

/** Shared across browsers. `notice` is `new event from <server>` for the latest event. */
export interface McpEventsState {
  subscriptions: McpSubscriptionView[];
  events: McpEventView[];
  notice: string | null;
  /**
   * Set when the adapter reports that a window was skipped (a reconnecting
   * stream drops events rather than replaying them). `dropped` is the count it
   * named; the feed never invents one.
   */
  gap?: {
    dropped: number;
    at: string;
    /** Cursor the restore would have resumed from when it skipped an old backlog. */
    from?: string | null;
    /** The last event this process had seen before the skipped window. */
    missedSince?: string;
  };
  revision: number;
}

export interface ThemePalette {
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  orange: string;
  brown: string;
}

export interface ThemeColors {
  mode: "light" | "dark";
  background: string;
  /** Raised or recessed panel. Header, footer, and user bubbles use this, not `background`. */
  surface: string;
  foreground: string;
  muted: string;
  mutedForeground: string;
  border: string;
  accent: string;
  destructive: string;
  selection: string;
  /** The desktop theme's ANSI palette, used for plots and status colours. */
  palette: ThemePalette;
  /** Corner radius in pixels, from the theme's Hyprland `rounding`. `0` is square. */
  radius: number;
}

export interface OmarchyTheme {
  slug: string;
  name: string;
  colors: ThemeColors;
}

export interface OmarchyThemes {
  /** Omarchy's current desktop theme, when that theme is installed. */
  current: string | null;
  /** Slug saved for this server. Null until a theme is chosen here. */
  selected: string | null;
  themes: OmarchyTheme[];
}

/** Broadcast when the saved theme changes, and replayed to a client that just connected. */
export interface StreamTheme {
  slug: string;
  colors: ThemeColors;
}

/** One credentialed catalog model the menu can select. */
export interface ModelOption {
  provider: string;
  id: string;
  name: string;
}

export interface ModelList {
  current: ModelOption | null;
  models: ModelOption[];
}

export interface DraftSync {
  text: string;
  thinking: string;
  revision: number;
}

export type TaskStatus = "open" | "working" | "done" | "proposed" | "backlog";

/**
 * Where a reviewer can check the work. Time, tokens and cost are measured from the runs that
 * worked on the task (`TaskTrace.measured`), never self-reported.
 */
export interface TaskCompletion {
  evidence: string;
}

/** One time a finished task was reopened, with the reason that brought it back. */
export interface TaskReopen {
  /** ISO timestamp of the reopen. */
  at: string;
  /** What the operator or agent said was still wrong. */
  reason: string;
  /** Who reopened it. */
  by: "operator" | "agent";
}

/** One todo. Subtasks point at a parent. `blockedBy` names tasks that gate this one. */
export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  parentId: string | null;
  /** Other task ids. A done blocker no longer keeps this task blocked. */
  blockedBy: string[];
  createdAt: string;
  /** When this task was proposed, or null once a human approved it. */
  proposedAt?: string | null;
  /** Why the proposer thinks this task is worth doing. Kept after approval. */
  rationale?: string;
  /** Free markdown shown under the title. Not the proposer's rationale. */
  body?: string;
  /** Media ids attached when the task was created. */
  attachments?: string[];
  /** Short project name such as `pi-ui`. Absent means no project. */
  project?: string;
  /** Who put this task in the ledger. Absent on ledgers written before this field existed. */
  createdBy?: "operator" | "agent";
  /**
   * When a tool call was last attributed to this task while it was working, or null before the
   * first one and after the task is released, closed or reopened. The badge stays until it is
   * finished.
   */
  lastWorkedAt?: string | null;
  /**
   * When task_working last moved this task to working; cleared when it is released, closed or
   * reopened.
   */
  workingSince?: string;
  /** When task_release last moved this task back to open; cleared by the next transition. */
  releasedAt?: string;
  /** Why the task was released, shown in the task details; cleared by the next transition. */
  releaseReason?: string;
  /** When the task was closed, or null while it is open. */
  completedAt: string | null;
  /** The report recorded when the task was closed, or null while it is open. */
  completion: TaskCompletion | null;
  /** Every time this task was reopened, oldest first. Absent on older ledgers. */
  reopens?: TaskReopen[];
  /** Convenience mirror of reopens[reopens.length - 1].at, or null. */
  reopenedAt?: string | null;
}

export interface TaskLedger {
  tasks: Task[];
  revision: number;
  /** What the agent's runs did for each task. Absent from older servers and plain store reads. */
  activity?: TaskActivity;
  /** Reopen counts per project, computed from this ledger. Absent on plain store reads. */
  reopenStats?: TaskReopenStats;
}

/** A task's state as the UI shows it, derived from the ledger plus measured run activity. */
export type TaskState =
  | "proposed"
  | "backlog"
  | "ready"
  | "working"
  | "blocked"
  | "failed"
  | "done"
  | "partial";

/** How the run that last touched a task ended. `running` while it is still live. */
export type TaskRunOutcome = "running" | "ok" | "error" | "interrupted";

/** Totals from the runs whose calls were attributed to the task. */
export interface TaskMeasured {
  /** Runs that touched the task. Zero means nothing was measured. */
  runs: number;
  /** Attributed tool calls. */
  calls: number;
  /** Wall time from a run's first to last attributed call, summed over runs. */
  activeMs: number;
  /** Input plus output tokens of the model calls that made attributed tool calls. */
  tokens: number;
  /** Provider-reported cost of those model calls, in USD. */
  cost: number;
}

export type TaskHistoryKind =
  | "created"
  | "approved"
  | "blocked"
  | "unblocked"
  | "done"
  | "reopened"
  | "run-start"
  | "run-end"
  | "failed";

/** One line of a task's short history: status changes and runs, never individual tool calls. */
export interface TaskHistoryEvent {
  at: string;
  kind: TaskHistoryKind;
  text: string;
}

export interface TaskTrace {
  /** Last attributed tool call, start or end. */
  lastActivityAt: string | null;
  lastRun: {
    id: string;
    outcome: TaskRunOutcome;
    /** Why the run failed, when it did. */
    reason?: string;
    /** When the outcome was last set. */
    at: string;
  } | null;
  measured: TaskMeasured;
  /** Newest last, capped. */
  history: TaskHistoryEvent[];
}

export interface TaskActivity {
  /** The server's clock when this view was built, so recency does not depend on the browser's. */
  now: string;
  running: boolean;
  /** The live run, or null between runs. */
  runId: string | null;
  traces: Record<string, TaskTrace>;
  /** When the last `memory_write` or `memory_long_term` call started, or null. */
  lastMemoryWriteAt?: string | null;
  /** Alias for callers that name the event without the `last` prefix. */
  memoryWriteAt?: string | null;
}

export interface Snapshot {
  conversationId: string;
  /** The newest page of the transcript, or everything from the `from` the request asked for. */
  messages: ChatMessage[];
  activity: ActivityItem[];
  /** Lowest transcript order in this snapshot; `GET /api/history?before=<from>` reads older items. */
  from?: number;
  /** True when the transcript has messages older than `from`. */
  hasEarlier?: boolean;
  run: RunState;
  queue: QueuedMessage[];
  /** Steers waiting for the run's next turn boundary, oldest first. */
  steers?: QueuedMessage[];
  usage: UsageSummary;
  context: ContextUsage;
  mcp: McpStatus;
  mcpEvents?: McpEventsState;
  draft?: DraftSync;
  tasks?: TaskLedger;
  /** Sub-agent runs, with their own token usage rather than the main turn's. */
  delegates?: DelegateRunView[];
  /** Tools still running. A refresh uses this when `toolsRevision` is current. */
  activeTools?: ToolActivity[];
  toolsRevision?: number;
}

export interface TranscriptHistory {
  messages: ChatMessage[];
  activity: ActivityItem[];
  from: number;
  hasEarlier: boolean;
}

export interface SubmitMessageResponse {
  message: ChatMessage;
  mode: MessageMode;
  /** True while the message is held for the next run instead of being in the transcript. */
  queued: boolean;
  /** False when the transcript entry has not been placed yet. */
  placed: boolean;
  queue: QueuedMessage[];
  /** Steers waiting for the run's next turn boundary. */
  steers?: QueuedMessage[];
}

export interface HealthResponse {
  ok: true;
}

/** A one-line chat notice appended outside a run; clients add it without touching the draft. */
export interface StreamNotice {
  message: ChatMessage;
}

/** An activity item appended outside a run, such as a finished background job. */
export interface StreamActivity {
  activity: ActivityItem;
}

export interface StreamMessageDone {
  message: ChatMessage | null;
}

export interface StreamToolStart {
  toolCallId: string;
  name: string;
  arguments: unknown;
  timestamp: string;
  toolsRevision?: number;
}

export interface StreamToolEnd {
  toolCallId: string;
  name: string;
  isError: boolean;
  output?: string;
  durationMs?: number;
  timestamp: string;
  activity: ToolActivity;
  toolsRevision?: number;
}

export interface StreamTextDelta {
  text: string;
  /** Full draft after this change, so every client replaces instead of appending twice. */
  full?: string;
  revision?: number;
}

export interface StreamDraftSync {
  text: string;
  thinking: string;
  revision: number;
}

export interface StreamRunState {
  state: RunState;
  queue?: QueuedMessage[];
  steers?: QueuedMessage[];
}

/** A pending steer the server could not deliver; it leaves the queue with a reason. */
export interface StreamSteerDropped {
  id: string;
  reason: string;
}

/** Reopened tasks per project, for the stats page. */
export interface TaskReopenProjectStats {
  /** The project as the ledger spells it, or null for tasks without one. */
  project: string | null;
  /** Tasks in this project that have been reopened at least once. */
  reopenedTasks: number;
  /** Every reopen recorded in this project. */
  reopens: number;
  /** Reopens since the start of the current week. */
  reopensThisWeek: number;
}

export interface TaskReopenStats {
  /** Tasks that have been reopened at least once. */
  totalReopenedTasks: number;
  /** Every reopen recorded, across all tasks. */
  totalReopens: number;
  /** Reopens since the start of the current week. */
  reopensThisWeek: number;
  /** One row per project with reopens, busiest first. */
  projects: TaskReopenProjectStats[];
}

/** Closed-task durations per project, for the stats page. */
export interface TaskDurationProjectStats {
  /** The project as the ledger spells it, or "(none)" for tasks without one. */
  project: string;
  /** Closed tasks in this project with a positive duration. */
  count: number;
  /** Mean closed-task duration in this project, in minutes. */
  avgMinutes: number;
  /** 90th-percentile closed-task duration in this project, in minutes. */
  p90Minutes: number;
}

export interface TaskDurationStats {
  /** Closed tasks with both a creation and a completion time and a positive duration. */
  count: number;
  /** Mean closed-task duration, in minutes. */
  avgMinutes: number;
  /** Median closed-task duration, in minutes. */
  p50Minutes: number;
  /** 90th-percentile closed-task duration, in minutes. */
  p90Minutes: number;
  /** Longest closed-task duration, in minutes. */
  longestMinutes: number;
  /** One row per project with a closed task, busiest first. */
  projects: TaskDurationProjectStats[];
}
