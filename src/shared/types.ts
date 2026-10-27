export type RunState = "idle" | "running";

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

export interface Snapshot {
  messages: ChatMessage[];
  activity: ActivityItem[];
  run: RunState;
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
