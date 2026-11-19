import type { BuiltinJob } from "./dashboard.js";
import type { MemoryToolDetails } from "./memory.js";
import type { ChatNotice, JobNoticeDetails } from "./notices.js";
export type RunState = "idle" | "running" | "interrupted";

export const STEER_ENTRY_KIND = "ui.steer";

export type MessageMode = "queue" | "steer";

export interface MediaRef {
  id: string;
  mimeType: string;
}

export interface DiagramRef {
  id: string;
  revision: number;
}

export type MessagePart = { kind: "diagram"; diagram: DiagramRef };

export interface QueuedNotice {
  kind: string;
  label: string;
  glyph: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  kind?: "session-reset";
  text: string;
  attachments?: MediaRef[];
  parts?: MessagePart[];
  timestamp: string;
  order: number;
  isError?: boolean;
  steer?: boolean;
  pendingSteer?: boolean;
  pendingQueue?: boolean;
  pendingSend?: boolean;
  queueId?: string;
  queueCount?: number;
  queueIds?: string[];
  steerKey?: string;
  steerError?: string;
  notice?: ChatNotice | QueuedNotice;
  version?: { from: string | null; to: string; changes?: string };
  repair?: { baseRevision: number };
  partial?: boolean;
  questionAnswers?: TaskQuestionAnswerBlock;
  usage?: TokenSpend;
}

export type TaskQuestionKind = "single" | "multi" | "text";

export interface TaskQuestionOption {
  value: string;
  label: string;
  detail?: string;
}

export interface TaskQuestion {
  id: string;
  prompt: string;
  kind: TaskQuestionKind;
  options?: TaskQuestionOption[];
  allowOther?: boolean;
}

export interface TaskQuestionSet {
  id: string;
  taskId: string;
  createdAt: string;
  questions: TaskQuestion[];
  askedBy?: string;
}

export interface TaskQuestionAnswer {
  id: string;
  values: string[];
  text: string;
}

export interface AnsweredQuestionItem {
  id: string;
  prompt: string;
  kind: TaskQuestionKind;
  values: string[];
  labels: string[];
  text: string;
}

export interface TaskQuestionAnswerBlock {
  setId: string;
  answers: AnsweredQuestionItem[];
}

export interface TaskQuestionAnswerRecord {
  setId: string;
  taskId: string;
  answeredAt: string;
  questions: TaskQuestion[];
  answers: TaskQuestionAnswer[];
  askedBy?: string;
}

export interface TokenSpend {
  input: number;
  output: number;
}

export type DelegateRunStatus =
  | "queued"
  | "running"
  | "idle"
  | "completed"
  | "failed"
  | "cancelled";

export type DelegateTurnOutcome = "completed" | "failed" | "cancelled";

export interface DelegateTokenUsage {
  input: number;
  output: number;
  total: number;
  cost: number;
}

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
  lastOutcome?: DelegateTurnOutcome;
  error?: string;
  resultPath: string;
  activityPath: string;
  resultUrl: string;
  activityUrl: string;
}

export interface QueuedMessage {
  id: string;
  text: string;
  createdAt: string;
  attachments?: string[];
  key?: string;
  requestId?: string;
  notice?: QueuedNotice;
  hidden?: boolean;
}

export interface ToolActivity {
  kind: "tool";
  id: string;
  name: string;
  arguments: string;
  toolCallId?: string;
  taskId?: string;
  optimistic?: boolean;
  output?: string;
  details?: string;
  memory?: MemoryToolDetails;
  isError: boolean;
  durationMs?: number;
  timestamp: string;
  order: number;
  pending?: boolean;
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
  usage?: TokenSpend;
}

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
  tools: string[];
  reason?: string;
}

export interface McpStatus {
  servers: McpServerStatus[];
  unavailable: string[];
  subscriptionConfig?: {
    path: string;
    present: boolean;
    error?: string;
    writeError?: string;
    entries: Array<{
      stableId: string;
      server: string;
      name: string;
      arguments: Record<string, unknown>;
      title?: string;
      state: "live" | "pending" | "missing-server";
    }>;
  };
}

export type McpSubscriptionState = "active" | "stalled" | "recovering" | "dead" | "cancelled";

export interface McpSubscriptionView {
  id: string;
  stableId: string;
  generation?: string | number;
  server: string;
  name: string;
  title?: string;
  status: string;
  state: McpSubscriptionState;
  arguments: Record<string, unknown>;
  cursor: string | null;
  lastEventAt?: string;
  lastHeartbeatAt?: string;
  lastPollAt?: string;
  lastError?: string;
  lastErrorAt?: string;
  recoveryFailures?: number;
  recoveryPending?: boolean;
  recoveryStartedAt?: string;
  reconnects?: number;
  lastReconnectReason?: string;
  endReason?: string;
}

export interface McpEventView {
  id: string;
  server: string;
  name: string;
  generation?: string | number;
  timestamp: string;
  summary: string;
  replayed?: boolean;
}

export interface McpEventsState {
  subscriptions: McpSubscriptionView[];
  events: McpEventView[];
  notice: string | null;
  gap?: {
    dropped: number;
    at: string;
    from?: string | null;
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
  surface: string;
  foreground: string;
  muted: string;
  mutedForeground: string;
  border: string;
  accent: string;
  destructive: string;
  selection: string;
  palette: ThemePalette;
  radius: number;
}

export interface OmarchyTheme {
  slug: string;
  name: string;
  colors: ThemeColors;
}

export interface OmarchyThemes {
  current: string | null;
  selected: string | null;
  themes: OmarchyTheme[];
}

export interface StreamTheme {
  slug: string;
  colors: ThemeColors;
}

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

export type TaskStatus = "open" | "working" | "done" | "proposed" | "backlog" | "planning";

export interface TaskCompletion {
  evidence: string;
}

export interface TaskReopen {
  at: string;
  reason: string;
  by: "operator" | "agent";
}

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  parentId: string | null;
  blockedBy: string[];
  createdAt: string;
  proposedAt?: string | null;
  rationale?: string;
  body?: string;
  attachments?: string[];
  project?: string;
  createdBy?: "operator" | "agent";
  lastWorkedAt?: string | null;
  workingSince?: string;
  releasedAt?: string;
  releaseReason?: string;
  planning?: boolean;
  completedAt: string | null;
  completion: TaskCompletion | null;
  reopens?: TaskReopen[];
  reopenedAt?: string | null;
}

export interface TaskLedger {
  tasks: Task[];
  revision: number;
  planning?: string[];
  activity?: TaskActivity;
  reopenStats?: TaskReopenStats;
}

export type TaskState =
  | "proposed"
  | "backlog"
  | "planning"
  | "ready"
  | "working"
  | "blocked"
  | "failed"
  | "done"
  | "partial";

export type TaskRunOutcome = "running" | "ok" | "error" | "interrupted";

export interface TaskMeasured {
  runs: number;
  calls: number;
  activeMs: number;
  tokens: number;
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

export interface TaskHistoryEvent {
  at: string;
  kind: TaskHistoryKind;
  text: string;
}

export interface TaskTrace {
  lastActivityAt: string | null;
  lastRun: {
    id: string;
    outcome: TaskRunOutcome;
    reason?: string;
    at: string;
  } | null;
  measured: TaskMeasured;
  history: TaskHistoryEvent[];
}

export interface TaskActivity {
  now: string;
  running: boolean;
  runId: string | null;
  traces: Record<string, TaskTrace>;
  lastMemoryWriteAt?: string | null;
  memoryWriteAt?: string | null;
}

export interface RunError {
  id: string;
  class: string;
  message: string;
  detail?: string;
  at: string;
}

export interface Snapshot {
  conversationId: string;
  messages: ChatMessage[];
  activity: ActivityItem[];
  from?: number;
  hasEarlier?: boolean;
  run: RunState;
  runError?: RunError | null;
  queue: QueuedMessage[];
  steers?: QueuedMessage[];
  queueRevision?: number;
  usage: UsageSummary;
  context: ContextUsage;
  mcp: McpStatus;
  mcpEvents?: McpEventsState;
  draft?: DraftSync;
  tasks?: TaskLedger;
  delegates?: DelegateRunView[];
  jobs?: BuiltinJob[];
  activeTools?: ToolActivity[];
  toolsRevision?: number;
  resetAt?: string;
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
  queued: boolean;
  placed: boolean;
  queue: QueuedMessage[];
  steers?: QueuedMessage[];
  queueRevision?: number;
}

export interface HealthResponse {
  ok: true;
}

export interface StreamFrame {
  event: string;
  data: unknown;
}

export interface TaskChatFrame {
  taskId: string;
  event: string;
  data: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isTaskChatFrame(value: unknown): value is TaskChatFrame {
  return (
    isRecord(value) &&
    typeof value.taskId === "string" &&
    value.taskId.length > 0 &&
    typeof value.event === "string" &&
    value.event.length > 0 &&
    "data" in value
  );
}

export interface StreamQuestions {
  questions: TaskQuestionSet | null;
}

export interface StreamNotice {
  message: ChatMessage;
}

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
  runError?: RunError | null;
  queue?: QueuedMessage[];
  steers?: QueuedMessage[];
  queueRevision?: number;
}

export interface StreamSessionReset {
  order: number;
  resetAt: string;
  message?: ChatMessage;
}

export interface StreamSteerDropped {
  id: string;
  reason: string;
}

export interface TaskReopenProjectStats {
  project: string | null;
  reopenedTasks: number;
  reopens: number;
  reopensThisWeek: number;
}

export interface TaskReopenStats {
  totalReopenedTasks: number;
  totalReopens: number;
  reopensThisWeek: number;
  projects: TaskReopenProjectStats[];
}

export interface TaskDurationProjectStats {
  project: string;
  count: number;
  avgMinutes: number;
  p90Minutes: number;
}

export interface TaskDurationStats {
  count: number;
  avgMinutes: number;
  p50Minutes: number;
  p90Minutes: number;
  longestMinutes: number;
  projects: TaskDurationProjectStats[];
}
