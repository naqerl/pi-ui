export type RunState = "idle" | "running" | "interrupted";

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: string;
  /** Monotonic ordering key used to interleave messages and activity. */
  order: number;
  isError?: boolean;
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

export interface Snapshot {
  conversationId: string;
  messages: ChatMessage[];
  activity: ActivityItem[];
  run: RunState;
  usage: UsageSummary;
  context: ContextUsage;
}

export interface SubmitMessageResponse {
  message: ChatMessage;
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
}

export interface StreamRunState {
  state: RunState;
}
