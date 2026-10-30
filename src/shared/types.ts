import type { ChatNotice, JobNoticeDetails } from "./notices.js";
export type RunState = "idle" | "running" | "interrupted";

/** Replies at least this long get a fast-model summary and an expand control. */
export const SUMMARY_MIN_CHARACTERS = 600;
/** Replies longer than this are not summarised. */
export const SUMMARY_MAX_CHARACTERS = 40_000;

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

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  /** A short fast-model summary of an assistant reply, when one was generated. */
  summary?: string;
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
  /** Stable key shared by a pending steer and the transcript entry that consumed it. */
  steerKey?: string;
  /** Why a pending steer never reached the transcript. */
  steerError?: string;
  /** Set when the message is an MCP event; the chat shows a one-line notice. */
  notice?: ChatNotice;
  /** Set on the pi-ui version-update note, so the chat can paint it with the theme accent. */
  version?: { from: string | null; to: string };
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

/** One message waiting for the current run to finish. */
export interface QueuedMessage {
  id: string;
  text: string;
  createdAt: string;
  /** Media ids sent with the message. */
  attachments?: string[];
  /** Stable key the transcript entry carries once this steer is placed. */
  key?: string;
}

export interface ToolActivity {
  kind: "tool";
  id: string;
  name: string;
  arguments: string;
  output?: string;
  /** Tool-specific UI data. Never sent to the model. */
  details?: string;
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
}

/** Per-server MCP availability, so a configured-but-unreachable server is visible. */
export interface McpStatus {
  servers: McpServerStatus[];
  unavailable: string[];
}

export interface McpSubscriptionView {
  id: string;
  server: string;
  name: string;
  status: string;
  arguments: Record<string, unknown>;
  /**
   * Last replay cursor the stream reported, null before the first one. A
   * cursor that moves while `events` stays empty means events are arriving
   * but being dropped; a still one means the subscription is just quiet.
   */
  cursor: string | null;
}

export interface McpEventView {
  id: string;
  server: string;
  name: string;
  timestamp: string;
  summary: string;
}

/** Shared across browsers. `notice` is `new event from <server>` for the latest event. */
export interface McpEventsState {
  subscriptions: McpSubscriptionView[];
  events: McpEventView[];
  notice: string | null;
  revision: number;
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

export type TaskStatus = "open" | "done";

/** What closing a task cost, and where a reviewer can check the work. */
export interface TaskCompletion {
  timeSpentMinutes: number;
  timeSpentText: string;
  tokens: number;
  evidence: string;
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
  /** Media ids attached when the task was created. */
  attachments?: string[];
  /** When the task was closed, or null while it is open. */
  completedAt: string | null;
  /** The report recorded when the task was closed, or null while it is open. */
  completion: TaskCompletion | null;
}

export interface TaskLedger {
  tasks: Task[];
  revision: number;
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
