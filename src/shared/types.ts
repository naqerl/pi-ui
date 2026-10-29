export type RunState = "idle" | "running" | "interrupted";

/** Entry kind used for a steered user message, so the transcript can mark it. */
export const STEER_ENTRY_KIND = "ui.steer";

export type MessageMode = "queue" | "steer";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  timestamp: string;
  /** Monotonic ordering key used to interleave messages and activity. */
  order: number;
  isError?: boolean;
  /** True for a message injected into a running turn. */
  steer?: boolean;
  /** True when a server restart cut off this assistant response. */
  partial?: boolean;
}

/** One message waiting for the current run to finish. */
export interface QueuedMessage {
  id: string;
  text: string;
  createdAt: string;
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
}

export interface ThinkingActivity {
  kind: "thinking";
  id: string;
  name: "thinking";
  text: string;
  timestamp: string;
  order: number;
  pending?: boolean;
}

export type ActivityItem = ToolActivity | ThinkingActivity;

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

/** One todo. Subtasks point at a parent. `blockedBy` names tasks that gate this one. */
export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  parentId: string | null;
  /** Other task ids. A done blocker no longer keeps this task blocked. */
  blockedBy: string[];
  createdAt: string;
}

export interface TaskLedger {
  tasks: Task[];
  revision: number;
}

export interface Snapshot {
  conversationId: string;
  messages: ChatMessage[];
  activity: ActivityItem[];
  run: RunState;
  runStartedAt?: string;
  queue: QueuedMessage[];
  usage: UsageSummary;
  context: ContextUsage;
  mcp: McpStatus;
  mcpEvents?: McpEventsState;
  draft?: DraftSync;
  tasks?: TaskLedger;
}

export interface SubmitMessageResponse {
  message: ChatMessage;
  mode: MessageMode;
  /** True while the message is held for the next run instead of being in the transcript. */
  queued: boolean;
  /** False when the transcript entry has not been placed yet. */
  placed: boolean;
  queue: QueuedMessage[];
}

export interface HealthResponse {
  ok: true;
}

export interface StreamMessageDone {
  message: ChatMessage | null;
}

export interface StreamToolStart {
  toolCallId: string;
  name: string;
  arguments: unknown;
  timestamp: string;
}

export interface StreamToolEnd {
  toolCallId: string;
  name: string;
  isError: boolean;
  output?: string;
  durationMs?: number;
  timestamp: string;
  activity: ToolActivity;
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
  startedAt?: string | null;
  queue?: QueuedMessage[];
}
