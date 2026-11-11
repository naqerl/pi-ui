import { randomUUID } from "node:crypto";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  AssistantEntry,
  CompactionEntry,
  type Conversation,
  ConversationBusy,
  type ConversationView,
  type ConversationWatch,
  type EntryRecord,
  type Harness,
  InboxDoc,
  type InboxItem,
  type InputEntry,
  type LiveState,
  type SettledSubmissionRecord,
  type Submission,
  type SubmissionId,
  type ToolSlot,
} from "@earendil-works/pi-durable";
import { parseMemoryToolDetails } from "../shared/memory.js";
import {
  boundMcpEventBatch,
  isMcpEventEcho,
  MCP_EVENTS_HEAD,
  MCP_EVENTS_TRAILER,
  MCP_STATUS_HEAD,
  type MemoryDeltaTopic,
  memoryDeltaPrompt,
  type OperatorNoticeRecord,
  parseMcpEventPayload,
  parseNotice,
  type TaskDecisionNoticeRecord,
  taskDecisionPrompt,
} from "../shared/notices.js";
import { QUEUE_ENTRY_KIND, queuedNoticeGlyph, queueKeyFromEntryData } from "../shared/queue.js";
import {
  QUIET_AFTER_MS as DEFAULT_QUIET_AFTER_MS,
  type DurableRunFacts,
  reconcileRunState,
} from "../shared/run-health.js";
import { steerDropReason, steerFromInboxItem } from "../shared/steers.js";
import {
  type ChatMessage,
  type McpEventsState,
  type McpStatus,
  type MessageMode,
  type ModelList,
  type ModelOption,
  type QueuedMessage,
  type RunState,
  type Snapshot,
  STEER_ENTRY_KIND,
  type StreamActivity,
  type StreamDraftSync,
  type StreamMessageDone,
  type StreamNotice,
  type StreamRunState,
  type StreamSteerDropped,
  type StreamTextDelta,
  type StreamToolEnd,
  type StreamToolStart,
  type ToolActivity,
  type TranscriptHistory,
} from "../shared/types.js";
import type { BillionContextInline } from "./billion-context.js";
import type { DurableDoctorReport } from "./durable-doctor.js";
import {
  type IdleNudge,
  IdleNudge as IdleNudgeImpl,
  type IdleTask,
  idleNudgeMs,
  openTaskIds,
  StaleRunNudge,
  staleRunNudgeMs,
  workingTaskIds,
} from "./idle-nudge.js";
import { NoticeCoalescer } from "./mcp-event-policy.js";
import type { McpEventFeed } from "./mcp-events.js";
import { registerMcpQueueMerger, unregisterMcpQueueMerger } from "./mcp-queue-merge.js";
import { MEDIA_TYPES, MediaError, type MediaStore } from "./media.js";
import type { MemoryWriteRecord } from "./memory/tools.js";
import { listAvailableModels, modelOption } from "./models.js";
import { formatToolArguments, formatToolDetails, formatToolResult } from "./pi.js";
import { retryBudgetExhausted, retryBudgetMs, retryGiveUpMessage, retrySpentMs } from "./retry.js";
import type { RunMarker, RunMarkerStore } from "./run-marker.js";
import {
  appendAssistantError,
  appendJobNotice,
  appendMcpNotice,
  appendMemoryWriteNotice,
  appendOperatorNotice,
  assistantMessageFromEntry,
  buildTranscript,
  contextUsage,
  DELEGATE_NOTICE_ENTRY_KIND,
  type DiagramRevisionResolver,
  IDLE_NUDGE_ENTRY_KIND,
  JOB_NOTICE_ENTRY_KIND,
  MCP_NOTICE_ENTRY_KIND,
  MEMORY_DELTA_ENTRY_KIND,
  recordDurableRepairNotice,
  SESSION_CONTEXT,
  summarizeUsage,
  TASK_DECISION_ENTRY_KIND,
  toolActivityFromEntry,
} from "./session.js";
import type { SseFrame } from "./sse.js";
import type { StreamHub } from "./stream-hub.js";
import type { TaskActivityTracker } from "./task-activity.js";
import { type WindowRequest, windowTranscript } from "./transcript-window.js";

type IdleTaskSource = () => readonly IdleTask[] | readonly string[];

interface ActiveTool {
  name: string;
  args: unknown;
  timestamp: string;
  /** The task this call was attributed to when it started, if any. */
  taskId?: string;
}

/** A view revision as the event handlers below consume it; watches replaced the event stream in 1.5. */
type ViewMessageChange = { type: "message"; message: AssistantMessage };

type ViewSnapshot = {
  type: "snapshot";
  entries: readonly EntryRecord[];
  run?: { inputs: readonly SubmissionId[] };
  generation?: { attempt: number; message?: AssistantMessage };
  tools: readonly ToolSlot[];
  inbox: readonly unknown[];
};

type ViewToolEndResult = {
  output?: string;
  details?: unknown;
  isError?: boolean;
  durationMs?: number;
};

/** A repaired slot uses `interrupted`, which is terminal even though durable's ToolSlot type omits it. */
function isInterruptedSlot(slot: Pick<ToolSlot, "status"> | undefined): boolean {
  return (slot?.status as string | undefined) === "interrupted";
}

function isTerminalSlot(slot: Pick<ToolSlot, "status">): boolean {
  return slot.status === "done" || isInterruptedSlot(slot);
}

type ViewEvent =
  | ViewSnapshot
  | { type: "run_start" }
  | { type: "run_end" }
  | { type: "message_update"; changes: readonly ViewMessageChange[] }
  | { type: "message_end"; entry: EntryRecord }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
      parentToolCallId?: string;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      parentToolCallId?: string;
      args?: unknown;
      entry?: EntryRecord;
      result?: ViewToolEndResult;
    }
  | { type: "entry_appended"; entry: EntryRecord }
  | { type: "compaction_start"; reason: string }
  | { type: "compaction_end"; reason: string; error?: string }
  | { type: "auto_retry_start"; attempt: number; at: number; errorMessage: string }
  | { type: "auto_retry_end"; attempt: number };

interface QueuedRun {
  item: QueuedMessage;
  submission: Submission;
}

interface SubmitOptions {
  /** Durable deduplication key, used by recovery and queue restoration. */
  requestId?: string;
  /** Media ids sent as images after the text. */
  attachments?: string[];
  /** Place an input as this application entry instead of a normal user entry. */
  entry?: InputEntry & { label?: string };
  /** Stable key from the client (or a restart) so a pending bubble keeps its id. */
  queueKey?: string;
}

/** `PI_UI_QUIET_AFTER_MS` shortens the quiet threshold for tests. */
export const QUIET_AFTER_MS = positiveEnv("PI_UI_QUIET_AFTER_MS") ?? DEFAULT_QUIET_AFTER_MS;
const WATCHDOG_INTERVAL_MS = Math.min(10_000, QUIET_AFTER_MS);
const STREAM_RETRY_MS = 1_000;
const MCP_EVENT_HEAD = MCP_EVENTS_HEAD;

export interface McpEventEnvelope {
  /** The extension's full safety preamble, preserved verbatim. */
  readonly head: string;
  readonly items: unknown[];
  readonly dropped: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The envelope around an MCP event notice, or null for another kind of message. */
export function mcpEventEnvelope(text: string): McpEventEnvelope | null {
  if (!text.startsWith(MCP_EVENT_HEAD)) return null;
  const newline = text.indexOf("\n");
  if (newline < 0) return null;
  const payload = parseMcpEventPayload(text.slice(newline + 1));
  if (payload === null || !Array.isArray(payload.events)) return null;
  return {
    head: text.slice(0, newline),
    items: payload.events,
    dropped: typeof payload.dropped_events === "number" ? payload.dropped_events : 0,
  };
}

export function mcpEventText(envelope: McpEventEnvelope, items: readonly unknown[]): string {
  return `${envelope.head}\n${JSON.stringify({
    events: items,
    dropped_events: envelope.dropped,
  })}\n${MCP_EVENTS_TRAILER}`;
}

/** Longest merged MCP notice text before a second notice carries the rest. */
export const MCP_MERGED_NOTICE_TEXT_LIMIT = 20_000;

type InboxInputItem = Extract<InboxItem, { mode: "steer" | "followUp" }>;

interface MergedMcpEvents {
  readonly head: string;
  readonly events: unknown[];
  readonly dropped: number;
  readonly noticeIds: string[];
  readonly at: string;
  readonly createdAt: string;
}

interface McpQueueItemInfo {
  readonly id: SubmissionId;
  readonly text: string;
  readonly createdAt: string;
  readonly key: string;
  /** The durable key for a replacement submission a merge had to create. */
  readonly requestId?: string;
}

function inboxItemText(item: InboxInputItem): string | null {
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return null;
  const parts: string[] = [];
  for (const part of item.content) {
    if (!isRecord(part) || part.type !== "text" || typeof part.text !== "string") continue;
    parts.push(part.text);
  }
  return parts.length === 0 ? null : parts.join("\n");
}

function inboxItemData(item: InboxInputItem): Record<string, unknown> {
  const data = item.entry?.data;
  return isRecord(data) ? { ...data } : {};
}

function inboxMcpEnvelope(item: InboxInputItem): McpEventEnvelope | null {
  const text = inboxItemText(item);
  return text === null ? null : mcpEventEnvelope(text);
}

function isMcpNoticeItem(item: InboxItem): item is InboxInputItem {
  if (item.mode === "write" || item.entry?.kind !== MCP_NOTICE_ENTRY_KIND) return false;
  return inboxMcpEnvelope(item) !== null;
}

/** A part of an already-split merge keeps its own summary and is never merged again. */
function isMergeableMcpNoticeItem(item: InboxItem): item is InboxInputItem {
  return isMcpNoticeItem(item) && inboxItemData(item).mergedChunk !== true;
}

/** One envelope with every event of a run, in the order the entries arrived. */
function mergeMcpNoticeItems(run: readonly InboxInputItem[]): MergedMcpEvents | null {
  let head: string | null = null;
  let dropped = 0;
  let at = "";
  let createdAt = "";
  const events: unknown[] = [];
  const noticeIds: string[] = [];
  for (const item of run) {
    const envelope = inboxMcpEnvelope(item);
    if (envelope === null) return null;
    head ??= envelope.head;
    dropped += envelope.dropped;
    events.push(...envelope.items);
    const data = inboxItemData(item);
    if (typeof data.noticeId === "string" && !noticeIds.includes(data.noticeId)) {
      noticeIds.push(data.noticeId);
    }
    if (Array.isArray(data.noticeIds)) {
      for (const noticeId of data.noticeIds) {
        if (typeof noticeId === "string" && !noticeIds.includes(noticeId)) {
          noticeIds.push(noticeId);
        }
      }
    }
    if (typeof data.at === "string" && (at === "" || Date.parse(data.at) >= Date.parse(at))) {
      at = data.at;
    }
    if (
      typeof data.createdAt === "string" &&
      (createdAt === "" || Date.parse(data.createdAt) >= Date.parse(createdAt))
    ) {
      createdAt = data.createdAt;
    }
  }
  if (head === null || events.length === 0) return null;
  const now = new Date().toISOString();
  return {
    head,
    events,
    dropped,
    noticeIds,
    at: at === "" ? now : at,
    createdAt: createdAt === "" ? now : createdAt,
  };
}

/** Split events so a merged notice stays bounded; an oversized lone event stays whole. */
function splitMcpEvents(envelope: McpEventEnvelope, events: readonly unknown[]): unknown[][] {
  const chunks: unknown[][] = [];
  let current: unknown[] = [];
  for (const event of events) {
    const candidate = [...current, event];
    if (
      current.length > 0 &&
      mcpEventText(envelope, candidate).length > MCP_MERGED_NOTICE_TEXT_LIMIT - 256
    ) {
      chunks.push(current);
      current = [event];
      continue;
    }
    current = candidate;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Batch idle news into bounded turns; busy news keeps per-event queue/cancel identity. */
export function mcpDeliveryTexts(envelope: McpEventEnvelope, busy: boolean): string[] {
  const bounded = boundMcpEventBatch(envelope.items);
  const boundedEnvelope = {
    ...envelope,
    items: bounded.items,
    dropped: envelope.dropped + bounded.dropped,
  };
  const chunks = busy
    ? boundedEnvelope.items.map((item) => [item])
    : splitMcpEvents(boundedEnvelope, boundedEnvelope.items);
  if (chunks.length === 0 && boundedEnvelope.dropped > 0) chunks.push([]);
  return chunks.map((items, index) =>
    mcpEventText({ ...boundedEnvelope, dropped: index === 0 ? boundedEnvelope.dropped : 0 }, items),
  );
}

/**
 * A restored subscription may replay continuously. Unlike a busy live stream,
 * it must not produce one delivery per event: cap the batch at the merge limit
 * and turn the remainder into one gap text. The result is at most one event
 * chip and one gap chip, however long the replay runs.
 */
export function mcpRestoreDeliveryTexts(envelope: McpEventEnvelope): string[] {
  const bounded = boundMcpEventBatch(envelope.items);
  const dropped = envelope.dropped + bounded.dropped;
  const boundedEnvelope = { ...envelope, items: bounded.items, dropped };
  if (bounded.items.length === 0) {
    return dropped > 0 ? [mcpEventText(boundedEnvelope, [])] : [];
  }
  const events = mcpEventText({ ...boundedEnvelope, dropped: 0 }, bounded.items);
  if (dropped === 0) return [events];
  return [events, mcpEventText(boundedEnvelope, [])];
}

function mergedNoticeText(
  head: string,
  totalEvents: number,
  dropped: number,
  events: readonly unknown[],
  part: number,
  parts: number,
  carriedBefore: number,
): string {
  if (parts <= 1) {
    return mcpEventText({ head, items: [...events], dropped }, [...events]);
  }
  const remain = totalEvents - (carriedBefore + events.length);
  const summary = `${head} This notice carries ${events.length} of ${totalEvents} merged events; ${remain} remain.`;
  return mcpEventText({ head: summary, items: [...events], dropped: part === 0 ? dropped : 0 }, [
    ...events,
  ]);
}

/** The bounded texts one merged run produces, with the remaining count on every part. */
export function mcpMergedNoticeTexts(
  envelope: McpEventEnvelope,
  events: readonly unknown[],
): string[] {
  const chunks = splitMcpEvents(envelope, events);
  const texts: string[] = [];
  let carriedBefore = 0;
  for (let part = 0; part < chunks.length; part++) {
    const chunk = chunks[part] ?? [];
    texts.push(
      mergedNoticeText(
        envelope.head,
        events.length,
        envelope.dropped,
        chunk,
        part,
        chunks.length,
        carriedBefore,
      ),
    );
    carriedBefore += chunk.length;
  }
  return texts;
}

function positiveEnv(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** Debug-gated submit breakdown: cheap enough to leave on for every send. */
function logSubmitTiming(timing: {
  mediaMs: number;
  beforeTurnMs: number;
  markerMs: number;
  conversationMs: number;
  statusMs: number;
  broadcastMs: number;
  totalMs: number;
  queueDepth: number;
}): void {
  if (!submitTimingEnabled()) return;
  console.debug(
    `[pi] submit timing mediaMs=${timing.mediaMs} beforeTurnMs=${timing.beforeTurnMs} ` +
      `markerMs=${timing.markerMs} conversationMs=${timing.conversationMs} ` +
      `statusMs=${timing.statusMs} broadcastMs=${timing.broadcastMs} ` +
      `totalMs=${timing.totalMs} queueDepth=${timing.queueDepth}`,
  );
}

function submitTimingEnabled(): boolean {
  const flag = process.env.PI_UI_DEBUG;
  if (flag === "1" || flag === "true") return true;
  return (process.env.DEBUG ?? "")
    .split(",")
    .some((part) => part === "pi" || part === "pi:*" || part === "*");
}

/** The durable key for a queued submission, reused when a restart replays its marker item. */
function queueRequestId(queueKey: string): string {
  return `queue:${queueKey}`;
}

/** The durable key for a proposal decision, so a retried approval cannot place two entries. */
function decisionRequestId(proposalId: string): string {
  return `decision:${proposalId}`;
}

/** The client key an entry carries, for matching a retried send to its placed message. */
function clientKeyFromEntry(entry: EntryRecord): string | undefined {
  if (!isRecord(entry.data)) return undefined;
  if (typeof entry.data.queueKey === "string" && entry.data.queueKey.length > 0) {
    return entry.data.queueKey;
  }
  if (entry.kind !== QUEUE_ENTRY_KIND && entry.kind !== STEER_ENTRY_KIND) return undefined;
  return queueKeyFromEntryData(entry.data);
}

/** The queued application entry, carrying a stable key so its chip and placed notice share an id. */
function entryWithQueueKey(entry: InputEntry, key: string | undefined): InputEntry {
  if (key === undefined) return entry;
  const data = isRecord(entry.data) ? entry.data : {};
  return { kind: entry.kind, data: { ...data, queueKey: key } as InputEntry["data"] };
}

/** The topic details a long-term memory write contributes to the tail delta. */
function memoryDeltaTopic(record: MemoryWriteRecord): MemoryDeltaTopic | undefined {
  if (!record.path.startsWith("topics/")) return undefined;
  const heading = /^#{1,3} (.+)$/m.exec(record.text)?.[1]?.trim();
  const title =
    record.title?.trim() || heading || record.path.split("/").at(-1)?.replace(/\.md$/, "");
  return {
    path: record.path,
    title: title === undefined || title.length === 0 ? "Untitled" : title,
    chars: record.chars ?? record.text.length,
    updated: record.updated ?? new Date().toISOString().slice(0, 10),
  };
}

/** The short chip text for a queued application entry. */
function entryNoticeLabel(kind: string, label?: string): string {
  if (label !== undefined && label.trim().length > 0) return label.trim();
  if (kind === MCP_NOTICE_ENTRY_KIND) return "MCP events";
  if (kind === JOB_NOTICE_ENTRY_KIND) return "Background job";
  if (kind === DELEGATE_NOTICE_ENTRY_KIND) return "Delegate run";
  if (kind === IDLE_NUDGE_ENTRY_KIND) return "Idle nudge";
  if (kind === TASK_DECISION_ENTRY_KIND) return "Proposal decision";
  const readable = kind
    .replace(/^ui[.-]/, "")
    .replace(/[-_.]+/g, " ")
    .trim();
  return readable.length === 0 ? "Notice" : readable.charAt(0).toUpperCase() + readable.slice(1);
}

export interface SubmittedMessage {
  message: ChatMessage;
  mode: MessageMode;
  queued: boolean;
  placed: boolean;
  queue: QueuedMessage[];
  steers: QueuedMessage[];
}

export class ChatService {
  private runState: RunState;
  private currentText = "";
  private currentThinking = "";
  private draftRevision = 0;
  private toolsRevision = 0;
  private eventFeed: McpEventFeed | undefined;
  private taskActivity: TaskActivityTracker | undefined;
  private readonly mcpNotices = new NoticeCoalescer();
  /** Events shown by each open notice window, so an update carries the full text. */
  private readonly mcpNoticeEvents = new Map<string, unknown[]>();
  /** The most recent MCP notice text delivered here, used to spot an assistant echo. */
  private lastMcpNoticeText: string | null = null;
  /** Proposal ids whose decision already reached the conversation. */
  private readonly taskDecisions = new Set<string>();
  /** Long-term topics written during this turn, keyed by path so the tail delta is one line. */
  private readonly memoryDeltas = new Map<string, MemoryDeltaTopic>();
  /** Stable id for the pending delta batch, so a retry never appends a second notice. */
  private memoryDeltaId: string | undefined;
  private flushingMemoryDelta = false;
  private readonly activeTools = new Map<string, ActiveTool>();
  private stream: ConversationWatch | undefined;
  private closed = false;
  /** The newest entry in the attached view, so a later revision only reports what it appended. */
  private lastViewEntryId: EntryRecord["id"] | undefined;
  /** The last view's live state, diffed to recover run, tool, retry, and compaction changes. */
  private viewLive: LiveState | undefined;
  /** Compaction tasks whose checkpoint already refreshed the turn memory. */
  private readonly compactionRefreshes = new Set<string>();
  /** When the conversation watch last delivered anything; see `QUIET_AFTER_MS`. */
  private lastEventAt = Date.now();
  /** Submissions sent to durable that it has not recorded yet. */
  private submitting = 0;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private idleNudgeTimer: ReturnType<typeof setInterval> | undefined;
  private readonly idleNudge: IdleNudge;
  private readonly staleRunNudge: StaleRunNudge;
  private readonly idleTasks: IdleTaskSource;
  private checkingRun = false;
  private checkingIdleNudge = false;
  private checkingStaleRunNudge = false;
  private quietLogged = false;
  private readonly queued = new Map<string, QueuedRun>();
  /** Steers durable holds in its inbox for the next turn boundary, by submission id. */
  private readonly steers = new Map<string, QueuedMessage>();
  /** One event-driven wake for inputs a finished run left queued; see `drainQueuedInputs`. */
  private queueDrain: Promise<void> | undefined;
  private marker: RunMarker | undefined;
  private markerWrites: Promise<void> = Promise.resolve();
  /** Coalesced state writes: many queue mutations in one tick become one marker write. */
  private markerTimer: ReturnType<typeof setTimeout> | undefined;
  private shuttingDown = false;
  private modelWindow: number | undefined;
  /** First retry of the current episode; the budget is measured from here. */
  private retryStartedAt: number | undefined;
  /** How many retries this episode has already asked for. */
  private retryAttempts = 0;
  /** Guards the abort path so a burst of retry events abandons a turn once. */
  private abandoning = false;
  /** Guards the pre-boundary merge so a nested commit cannot start it twice. */
  private mergingMcpQueue = false;
  private readonly mergeMcpQueue = () => this.mergeQueuedMcpNotices();
  private selected: ModelOption | null;
  /** Read on every snapshot, so a server may recover after its boot probe fails. */
  private readonly mcpStatus: () => McpStatus;

  constructor(
    private readonly harness: Harness,
    private readonly conversation: Conversation,
    private readonly hub: StreamHub,
    modelWindow: number | undefined,
    interrupted: boolean,
    private readonly markerStore: RunMarkerStore,
    initialMarker: RunMarker | undefined,
    mcpStatus: McpStatus | (() => McpStatus),
    private readonly catalog: ModelRuntime,
    initialModel: Model<Api> | undefined,
    private readonly bili: BillionContextInline,
    private readonly media: MediaStore,
    /** Refresh the injected memory block at a turn/compaction checkpoint. */
    private readonly beforeTurn: (reason?: string) => Promise<void> = async () => undefined,
    /** Reads a stored diagram's current revision for the transcript's message part. */
    private readonly diagramRevision: DiagramRevisionResolver = () => undefined,
    /**
     * The ledger tasks read when an idle window expires. Tests and older callers
     * may still pass the ready task ids directly instead of the whole task list.
     */
    idleTasks: IdleTaskSource = () => [],
    /** The app data directory, so the nudged task set survives a restart. */
    idleNudgeDataDirOrTasks?: string | IdleTaskSource,
    /** Re-run the durable doctor when a view read throws; it repairs and the read is retried. */
    private readonly repairDurableState?: () => Promise<DurableDoctorReport>,
  ) {
    this.mcpStatus = typeof mcpStatus === "function" ? mcpStatus : () => mcpStatus;
    let idleTasksSource: IdleTaskSource;
    let idleNudgeDataDir: string | undefined;
    if (typeof idleTasks === "string") {
      idleNudgeDataDir = idleTasks;
      idleTasksSource =
        typeof idleNudgeDataDirOrTasks === "function" ? idleNudgeDataDirOrTasks : () => [];
    } else {
      idleTasksSource = idleTasks;
      idleNudgeDataDir =
        typeof idleNudgeDataDirOrTasks === "string" ? idleNudgeDataDirOrTasks : undefined;
    }
    this.idleTasks = idleTasksSource;
    this.idleNudge = new IdleNudgeImpl(idleNudgeMs(), Date.now(), idleNudgeDataDir);
    this.staleRunNudge = new StaleRunNudge(staleRunNudgeMs(), idleNudgeDataDir);
    this.runState = interrupted ? "interrupted" : "idle";
    this.modelWindow = modelWindow;
    this.selected = initialModel === undefined ? null : modelOption(initialModel);
    this.marker = initialMarker;
    registerMcpQueueMerger(this.conversation.id, this.mergeMcpQueue);
  }

  /**
   * pi-ai swaps images for an "image omitted" note when the model is text-only, so the agent
   * would never see them. Refuse up front instead. With no model chosen the run fails anyway.
   */
  private assertAcceptsImages(): void {
    if (this.selected === null) return;
    const model = this.catalog.getModel(this.selected.provider, this.selected.id);
    if (model === undefined || model.input.includes("image")) return;
    throw new MediaError(`${this.selected.name} does not accept images`, 400);
  }

  private readonly mediaRef = (data: string, mimeType: string) => this.media.refFor(data, mimeType);

  async start(): Promise<void> {
    if (this.repairDurableState !== undefined) {
      try {
        await recordDurableRepairNotice(this.conversation, await this.repairDurableState());
      } catch (error) {
        console.error("[durable] pre-resume doctor failed", error);
      }
    }
    const stream = await this.watchConversation();
    this.stream = stream;
    const snapshot = this.resetView(stream.value);
    this.applySnapshot(snapshot);
    if (snapshot.run !== undefined) {
      this.setRunState("running");
    }
    this.listenToView(stream);
    this.watchStreamEnd(stream);
    this.watchdog = setInterval(() => void this.checkQuietRun(), WATCHDOG_INTERVAL_MS);
    this.watchdog.unref?.();
    await this.restorePersistedQueue();
    await this.restorePendingSteers();
    this.startIdleNudge();
    // Durable carries a turn across a restart from its committed checkpoint. A
    // stop requested before the restart was settled in recovery, so leave it be.
    if (this.marker?.stopRequested !== true) this.harness.resume();
  }

  async close(): Promise<void> {
    this.closed = true;
    unregisterMcpQueueMerger(this.conversation.id, this.mergeMcpQueue);
    if (this.watchdog !== undefined) clearInterval(this.watchdog);
    if (this.idleNudgeTimer !== undefined) clearInterval(this.idleNudgeTimer);
    await this.flushMarkerState();
    await this.stream?.stop();
  }

  /**
   * Check often enough that a short test window still fires near its deadline,
   * without waking the process every millisecond in normal use.
   */
  private startIdleNudge(): void {
    const windows = [
      ...(this.idleNudge.enabled ? [this.idleNudge.intervalMs] : []),
      ...(this.staleRunNudge.enabled ? [this.staleRunNudge.intervalMs] : []),
    ];
    if (windows.length === 0) return;
    const interval = Math.min(10_000, Math.max(10, ...windows));
    this.idleNudgeTimer = setInterval(() => {
      void this.checkIdleNudge();
      void this.checkStaleRunNudge();
    }, interval);
    this.idleNudgeTimer.unref?.();
  }

  /**
   * Sends one automated prompt after an idle window with open work. It uses the
   * normal queue path, never a steer, and only while no turn or submission waits.
   */
  private async checkIdleNudge(): Promise<void> {
    if (this.closed || this.checkingIdleNudge || !this.idleNudge.enabled) return;
    const tasks = this.idleTasks();
    const titled = tasks.every((task): task is string => typeof task === "string")
      ? undefined
      : (tasks as readonly IdleTask[]);
    let openIds: readonly string[];
    let workingIds: readonly string[] = [];
    if (titled === undefined) {
      openIds = tasks as readonly string[];
    } else {
      openIds = openTaskIds(titled);
      workingIds = workingTaskIds(titled);
    }
    const namedIds = [...new Set([...openIds, ...workingIds])];
    const activity = this.taskActivity?.view();
    const text = this.idleNudge.maybeNudge({
      active: this.runState === "running" || this.submitting > 0,
      queued: this.queued.size + this.steers.size,
      openTaskIds: openIds,
      workingTaskIds: workingIds,
      ...(titled === undefined ? {} : { tasks: titled }),
      ...(activity === undefined ? {} : { activity }),
    });
    if (text === null) return;
    this.checkingIdleNudge = true;
    const createdAt = new Date().toISOString();
    try {
      await this.submit(text, "queue", {
        entry: {
          kind: IDLE_NUDGE_ENTRY_KIND,
          label: "Idle nudge",
          data: { text, taskIds: namedIds, createdAt },
        },
      });
    } catch (error) {
      // Nothing reached the chat, so let the same task set try again after re-arming.
      this.idleNudge.forgetNudge();
      this.idleNudge.noteActivity();
      console.error("[pi] could not submit the idle nudge", error);
    } finally {
      this.checkingIdleNudge = false;
    }
  }

  /**
   * A live run that has not called a tool for an hour on one of its working tasks gets
   * one status check. It uses the same notice chip and queue path as the idle nudge,
   * never a steer, and is silent for terminal, blocked or waiting runs.
   */
  private async checkStaleRunNudge(): Promise<void> {
    if (this.closed || this.checkingStaleRunNudge || !this.staleRunNudge.enabled) return;
    if (this.runState !== "running" || this.submitting > 0) return;
    if (this.queued.size > 0 || this.steers.size > 0) return;
    const tasks = this.idleTasks();
    if (tasks.every((task): task is string => typeof task === "string")) return;
    const plan = this.staleRunNudge.maybeNudge(tasks, this.taskActivity?.view());
    if (plan === null) return;
    this.checkingStaleRunNudge = true;
    const createdAt = new Date().toISOString();
    try {
      await this.submit(plan.text, "queue", {
        entry: {
          kind: IDLE_NUDGE_ENTRY_KIND,
          label: "Status check",
          data: { text: plan.text, taskIds: [...plan.taskIds], createdAt },
        },
      });
    } catch (error) {
      // Nothing reached the chat, so let the same task try again instead of waiting an hour.
      this.staleRunNudge.forget(plan.taskIds);
      console.error("[pi] could not submit the stale-run nudge", error);
    } finally {
      this.checkingStaleRunNudge = false;
    }
  }

  /**
   * The conversation view is the only thing that ends a run in this server. When durable ends
   * it (a failed Session, a listener error), attach a new one; its snapshot settles the run state.
   */
  private watchStreamEnd(stream: ConversationWatch): void {
    void stream.closed.then((end) => {
      if (this.closed || stream !== this.stream) return;
      console.error(
        `[pi] conversation watch ended (${end.kind}); reattaching`,
        end.kind === "failed" || end.kind === "listener_error" ? end.error : "",
      );
      void this.reattachStream();
    });
  }

  private listenToView(stream: ConversationWatch): void {
    stream.start(async (call) => {
      if (call.kind === "failed") {
        console.error("[pi] conversation view failed", call.error);
        return;
      }
      try {
        await this.handleView(call.value);
      } catch (error) {
        console.error("[pi] view handling failed", error);
      }
    });
  }

  private async reattachStream(): Promise<void> {
    while (!this.closed) {
      await new Promise((resolve) => setTimeout(resolve, STREAM_RETRY_MS));
      if (this.closed) return;
      try {
        const stream = await this.watchConversation();
        this.stream = stream;
        await this.handleEvent(this.resetView(stream.value));
        this.listenToView(stream);
        this.watchStreamEnd(stream);
        console.log("[pi] conversation view reattached");
        return;
      } catch (error) {
        console.error("[pi] could not reattach the conversation view", error);
      }
    }
  }

  /**
   * A run that has been quiet for `QUIET_AFTER_MS` is checked against durable's live state, so a
   * lost end event cannot leave the chat working forever. A run durable still has stays running.
   */
  private async checkQuietRun(): Promise<void> {
    if (this.closed || this.checkingRun || this.runState !== "running") {
      this.quietLogged = false;
      return;
    }
    const quietMs = Date.now() - this.lastEventAt;
    if (quietMs < QUIET_AFTER_MS) {
      this.quietLogged = false;
      return;
    }
    this.checkingRun = true;
    try {
      const facts = await this.durableRunFacts();
      if (!this.quietLogged) {
        this.quietLogged = true;
        console.warn(
          `[pi] no agent events for ${Math.round(quietMs / 1_000)}s while running ` +
            `(durable run: ${facts.run ? "live" : "none"}, inbox: ${facts.inbox}, submitting: ${facts.submitting})`,
        );
      }
      this.reconcileRun(facts);
      // A failed run keeps its queued inputs. No nudge should be needed to start them.
      if (!facts.run) void this.drainQueuedInputs(facts);
    } catch (error) {
      console.error("[pi] could not check the run state", error);
    } finally {
      this.checkingRun = false;
    }
  }

  private async durableRunFacts(): Promise<DurableRunFacts> {
    const view = await this.readView();
    const live = view.docs["pi.live"] as { run?: unknown } | undefined;
    const inbox = view.docs["pi.inbox"] as { items?: unknown[] } | undefined;
    return {
      run: live?.run !== undefined && live.run !== null,
      inbox: inbox?.items?.length ?? 0,
      submitting: this.submitting,
    };
  }

  private reconcileRun(facts: DurableRunFacts): void {
    // Our own queue still waits on durable, so it keeps the run alive too.
    const next = reconcileRunState(this.runState, {
      ...facts,
      inbox: facts.inbox + this.queued.size,
    });
    if (next === this.runState) return;
    console.warn(`[pi] run state reconciled with durable: ${this.runState} -> ${next}`);
    this.setRunState(next);
    if (next !== "running") void this.drainQueuedInputs(facts);
  }

  /**
   * Starts a run for inputs a finished run left queued. Durable keeps follow-ups after a
   * failed run until the next submission; without this wake a queued message (or an
   * approval) waits for the idle nudge, which is minutes away and unrelated to delivery.
   * Submissions wake the drain on admission; this covers a run that ended after them.
   */
  private drainQueuedInputs(known?: DurableRunFacts): Promise<void> {
    if (this.closed || this.shuttingDown || this.marker?.stopRequested === true) {
      return Promise.resolve();
    }
    if (this.queued.size === 0 && this.steers.size === 0) return Promise.resolve();
    // Known-stale facts need no drain at all, not even a resolved guard; a caller may
    // hand fresh facts in the same tick after an early return.
    if (known !== undefined && (known.run || known.inbox === 0)) return Promise.resolve();
    if (this.queueDrain !== undefined) return this.queueDrain;
    const work = (async () => {
      try {
        const facts = known ?? (await this.durableRunFacts());
        // A live run already owns its boundary; an empty inbox has nothing to start.
        if (facts.run || facts.inbox === 0) return;
        // A stop that arrived while the view was read owns the queue now.
        if (this.marker?.stopRequested === true) return;
        await this.conversation.submit({ type: "continue" }, SESSION_CONTEXT);
      } catch (error) {
        // A run that started between the check and the continue owns the queue now.
        if (!(error instanceof ConversationBusy)) {
          console.error("[pi] could not drain the queued inputs", error);
        }
      }
    })();
    // Attach cleanup before storing the guard. A known-facts early return resolves in a
    // microtask, so clearing in the work itself could race the assignment and leave a
    // resolved promise here forever. The identity check keeps a later drain untouched.
    let run: Promise<void>;
    run = work.finally(() => {
      if (this.queueDrain === run) this.queueDrain = undefined;
    });
    this.queueDrain = run;
    return run;
  }

  /** Keep the run marker on disk while the process winds down. */
  beginShutdown(): void {
    this.shuttingDown = true;
  }

  getState(): RunState {
    return this.runState;
  }

  setEventFeed(feed: McpEventFeed): void {
    this.eventFeed = feed;
  }

  /** Measure which task each run works on from the single task marked working. */
  setTaskActivity(tracker: TaskActivityTracker): void {
    this.taskActivity = tracker;
    if (this.runState === "running") tracker.runStarted();
  }

  mcpEventsState(): McpEventsState {
    return this.eventFeed?.state ?? { subscriptions: [], events: [], notice: null, revision: 0 };
  }

  getRunStatus(): StreamRunState {
    return {
      state: this.runState,
      queue: this.queueItems(),
      steers: this.steerItems(),
    };
  }

  currentModel(): ModelOption | null {
    return this.selected;
  }

  async modelsView(): Promise<ModelList> {
    const models = await listAvailableModels(this.catalog);
    const current = this.selected;
    if (
      current !== null &&
      !models.some((item) => item.provider === current.provider && item.id === current.id)
    ) {
      models.unshift(current);
    }
    return { current, models };
  }

  /** Store the choice on the conversation. An in-flight turn keeps the model it started with. */
  async setModel(provider: string, id: string): Promise<ModelOption | undefined> {
    const model = this.catalog.getModel(provider, id);
    if (model === undefined) return undefined;
    const available = await listAvailableModels(this.catalog);
    const allowed = available.some((item) => item.provider === provider && item.id === id);
    const already = this.selected?.provider === provider && this.selected.id === id;
    if (!allowed && !already) return undefined;
    const choice = modelOption(model);
    if (!already) {
      await this.conversation.configure(
        { model: { provider: model.provider, modelId: model.id } },
        SESSION_CONTEXT,
      );
      this.modelWindow = model.contextWindow;
      this.selected = choice;
      this.bili.setModelMetadata({
        model: model.id,
        contextWindow: model.contextWindow,
        maxOutput: model.maxTokens,
      });
      console.log(`[pi] model: ${model.provider}/${model.id}`);
      this.hub.broadcast({ event: "model", data: choice });
    }
    return choice;
  }

  /** One page of older transcript, ending just below `request.before`. */
  async getHistory(request: WindowRequest): Promise<TranscriptHistory> {
    const context = await this.conversation.context(SESSION_CONTEXT);
    const transcript = buildTranscript(context.entries, this.mediaRef, this.diagramRevision);
    return windowTranscript(transcript, request);
  }

  /** Usage, context and MCP status without building the transcript window. */
  async statsSnapshot(): Promise<Pick<Snapshot, "usage" | "context" | "mcp" | "conversationId">> {
    const context = await this.conversation.context(SESSION_CONTEXT);
    const usage = await this.harness.usage(SESSION_CONTEXT);
    return {
      conversationId: String(this.conversation.id),
      usage: summarizeUsage(usage),
      context: contextUsage(context.entries, this.modelWindow),
      mcp: this.mcpStatus(),
    };
  }

  async getSnapshot(request: WindowRequest = {}): Promise<Snapshot> {
    const context = await this.conversation.context(SESSION_CONTEXT);
    const usage = await this.harness.usage(SESSION_CONTEXT);
    const built = buildTranscript(context.entries, this.mediaRef, this.diagramRevision);
    const transcript = windowTranscript(built, request.before === undefined ? request : {});
    return {
      conversationId: String(this.conversation.id),
      messages: transcript.messages,
      activity: transcript.activity,
      from: transcript.from,
      hasEarlier: transcript.hasEarlier,
      run: this.runState,
      queue: this.queueItems(),
      steers: this.steerItems(),
      usage: summarizeUsage(usage),
      context: contextUsage(context.entries, this.modelWindow),
      mcp: this.mcpStatus(),
      mcpEvents: this.mcpEventsState(),
      draft: {
        text: this.currentText,
        thinking: this.currentThinking,
        revision: this.draftRevision,
      },
      activeTools: this.activeToolActivities(),
      toolsRevision: this.toolsRevision,
    };
  }

  private bumpDraft(): number {
    this.draftRevision += 1;
    return this.draftRevision;
  }

  private broadcastText(): void {
    const revision = this.bumpDraft();
    this.hub.broadcast({
      event: "message.delta",
      data: {
        text: "",
        full: this.currentText,
        revision,
      } satisfies StreamTextDelta,
    });
  }

  private broadcastThinking(): void {
    const revision = this.bumpDraft();
    this.hub.broadcast({
      event: "thinking.delta",
      data: {
        text: "",
        full: this.currentThinking,
        revision,
      } satisfies StreamTextDelta,
    });
  }

  private publishDraft(previousText: string, previousThinking: string): void {
    if (this.currentText !== previousText) this.broadcastText();
    if (this.currentThinking !== previousThinking) this.broadcastThinking();
  }

  private activeToolActivities(): ToolActivity[] {
    const items: ToolActivity[] = [];
    for (const [toolCallId, tool] of this.activeTools) {
      items.push({
        kind: "tool",
        id: `live-${toolCallId}`,
        name: tool.name,
        arguments: formatToolArguments(tool.args),
        isError: false,
        timestamp: tool.timestamp,
        order: Number.MAX_SAFE_INTEGER - 1,
        pending: true,
      });
    }
    return items;
  }

  replayFrames(): SseFrame[] {
    const revision = this.bumpDraft();
    const frames: SseFrame[] = [
      {
        event: "draft.sync",
        data: {
          text: this.currentText,
          thinking: this.currentThinking,
          revision,
        } satisfies StreamDraftSync,
      },
      { event: "mcp.events", data: this.mcpEventsState() },
    ];
    if (this.runState !== "running") return frames;
    for (const [toolCallId, tool] of this.activeTools) {
      frames.push({
        event: "tool.start",
        data: {
          toolCallId,
          name: tool.name,
          arguments: tool.args,
          timestamp: tool.timestamp,
          toolsRevision: this.toolsRevision,
        } satisfies StreamToolStart,
      });
    }
    return frames;
  }

  async submit(
    text: string,
    mode: MessageMode = "queue",
    options: SubmitOptions = {},
  ): Promise<SubmittedMessage> {
    const timingStart = Date.now();
    const timing = {
      mediaMs: 0,
      beforeTurnMs: 0,
      markerMs: 0,
      conversationMs: 0,
      statusMs: 0,
      broadcastMs: 0,
    };
    this.idleNudge.noteActivity();
    // A retried send whose client message id is already on the transcript is the same
    // message: return that entry instead of placing a second one and starting a turn.
    const duplicate =
      options.queueKey === undefined ? undefined : await this.placedClientMessage(options.queueKey);
    if (duplicate !== undefined) {
      return {
        message: duplicate,
        mode,
        queued: false,
        placed: true,
        queue: this.queueItems(),
        steers: this.steerItems(),
      };
    }
    const steer = mode === "steer";
    const attachments = options.attachments ?? [];
    if (attachments.length > 0) this.assertAcceptsImages();
    // Read the images first, so an unknown id fails before the run state changes.
    const mediaStart = Date.now();
    const images = attachments.length === 0 ? [] : await this.media.images(attachments);
    timing.mediaMs = Date.now() - mediaStart;
    const content =
      images.length === 0
        ? text
        : [...(text.length > 0 ? [{ type: "text" as const, text }] : []), ...images];
    // The memory snapshot is keyed on a stable prefix. Refresh it at the turn
    // boundary: a day rollover or long-term write reconfigures instructions;
    // daily and scratchpad writes leave the cached block untouched. Deployments
    // pass memoryCheckpoints.refresh here, so time the real callback.
    const beforeTurnStart = Date.now();
    await this.beforeTurn();
    timing.beforeTurnMs = Date.now() - beforeTurnStart;
    const startsRun = this.runState !== "running" && this.queued.size === 0;
    const startedAt = new Date().toISOString();
    const steerKey = steer ? (options.queueKey ?? randomUUID()) : undefined;
    // A queued follow-up gets an application entry with a stable key, so its pending bubble
    // and the placed transcript message share one id instead of remounting at the handoff.
    const queueKey =
      !steer && !startsRun && options.entry === undefined
        ? (options.queueKey ?? randomUUID())
        : undefined;
    const entryKey =
      !steer && !startsRun && options.entry !== undefined
        ? (options.queueKey ?? randomUUID())
        : undefined;
    // An idle client send also carries its key into the placed entry, so the optimistic
    // bubble and its transcript message share one id even though nothing is queued.
    const placedKey =
      !steer && startsRun && options.entry === undefined ? options.queueKey : undefined;
    // A submit that checked startsRun before another one won the run can still be queued
    // by durable. Reuse the placed key there too, or the chip and the optimistic bubble
    // would get different ids and render the same message twice.
    const pendingKey = queueKey ?? entryKey ?? placedKey;
    // The same durable key is stored on the queued item, so restoration replays the
    // original submission instead of admitting a second one for the same message.
    const requestId =
      options.requestId ?? (pendingKey === undefined ? undefined : queueRequestId(pendingKey));
    const notice =
      options.entry === undefined
        ? undefined
        : {
            kind: options.entry.kind,
            label: entryNoticeLabel(options.entry.kind, options.entry.label),
            glyph: queuedNoticeGlyph(options.entry.kind),
          };
    if (startsRun) {
      const marker: RunMarker = {
        version: 1,
        userMessage: text,
        startedAt,
        mode,
        stopRequested: false,
        idempotencyKey: randomUUID(),
        queue: this.queueItems(),
        partialEntryId: null,
        updatedAt: new Date().toISOString(),
      };
      this.marker = marker;
      const markerStart = Date.now();
      await this.writeMarker(marker);
      timing.markerMs += Date.now() - markerStart;
      this.setRunState("running");
    }

    let submission: Submission;
    this.submitting += 1;
    const conversationStart = Date.now();
    try {
      submission = await this.conversation.submit(
        {
          type: "input",
          content,
          whenBusy: steer ? "steer" : "followUp",
          ...(requestId === undefined ? {} : { requestId }),
          ...(steer
            ? {
                entry: {
                  kind: STEER_ENTRY_KIND,
                  data: {
                    ...(steerKey === undefined ? {} : { key: steerKey }),
                    createdAt: startedAt,
                  },
                },
              }
            : queueKey !== undefined
              ? {
                  entry: {
                    kind: QUEUE_ENTRY_KIND,
                    data: { key: queueKey, createdAt: startedAt },
                  },
                }
              : options.entry === undefined
                ? placedKey === undefined
                  ? {}
                  : {
                      entry: {
                        kind: QUEUE_ENTRY_KIND,
                        data: { key: placedKey, createdAt: startedAt },
                      },
                    }
                : { entry: entryWithQueueKey(options.entry, entryKey) }),
        },
        SESSION_CONTEXT,
      );
    } catch (error) {
      if (startsRun) this.setRunState(this.marker === undefined ? "idle" : "interrupted");
      throw error;
    } finally {
      timing.conversationMs = Date.now() - conversationStart;
      this.submitting -= 1;
    }

    const id = String(submission.id);
    const queueMode = !steer;
    const queuedInitially = queueMode && !startsRun;
    if (queuedInitially) {
      this.queued.set(id, {
        item: {
          id,
          text,
          createdAt: new Date().toISOString(),
          ...(pendingKey === undefined ? {} : { key: pendingKey }),
          ...(requestId === undefined ? {} : { requestId }),
          ...(notice === undefined ? {} : { notice }),
          ...(attachments.length > 0 ? { attachments } : {}),
        },
        submission,
      });
      const markerStart = Date.now();
      await this.persistMarkerState();
      timing.markerMs += Date.now() - markerStart;
      const broadcastStart = Date.now();
      this.broadcastQueue();
      timing.broadcastMs += Date.now() - broadcastStart;
    }
    if (steer) {
      this.steers.set(id, {
        id,
        text,
        createdAt: new Date().toISOString(),
        ...(steerKey === undefined ? {} : { key: steerKey }),
        ...(notice === undefined ? {} : { notice }),
        ...(attachments.length > 0 ? { attachments } : {}),
      });
    }

    const statusStart = Date.now();
    const { message, placed } = await this.submittedMessage(
      submission,
      text,
      steer,
      attachments,
      steerKey,
    );
    timing.statusMs = Date.now() - statusStart;
    // An idle steer is already in the transcript; the response carries it, so no pending bubble
    // is left behind. A queued steer stays tracked until its entry is actually appended.
    if (steer && placed) this.steers.delete(id);
    if (steer) {
      const broadcastStart = Date.now();
      this.broadcastQueue();
      timing.broadcastMs += Date.now() - broadcastStart;
    }
    const queued = queueMode && !placed;
    if (queued && !queuedInitially) {
      this.queued.set(id, {
        item: {
          id,
          text,
          createdAt: new Date().toISOString(),
          ...(pendingKey === undefined ? {} : { key: pendingKey }),
          ...(requestId === undefined ? {} : { requestId }),
          ...(notice === undefined ? {} : { notice }),
          ...(attachments.length > 0 ? { attachments } : {}),
        },
        submission,
      });
      const markerStart = Date.now();
      await this.persistMarkerState();
      timing.markerMs += Date.now() - markerStart;
      const broadcastStart = Date.now();
      this.broadcastQueue();
      timing.broadcastMs += Date.now() - broadcastStart;
    } else if (!queued && queuedInitially && this.queued.delete(id)) {
      const markerStart = Date.now();
      await this.persistMarkerState();
      timing.markerMs += Date.now() - markerStart;
      const broadcastStart = Date.now();
      this.broadcastQueue();
      timing.broadcastMs += Date.now() - broadcastStart;
    }

    // Placement wakes the drain at once: a queue admitted after a failed run must not
    // wait for the next nudge or an unrelated message before it starts.
    if (queued) void this.drainQueuedInputs();
    void this.monitorSubmission(submission, startsRun, queued ? id : undefined);
    logSubmitTiming({
      ...timing,
      totalMs: Date.now() - timingStart,
      queueDepth: this.queued.size + this.steers.size,
    });
    return { message, mode, queued, placed, queue: this.queueItems(), steers: this.steerItems() };
  }

  async cancelQueued(id: string): Promise<boolean> {
    const queued = this.queued.get(id);
    if (!queued) return false;
    this.queued.delete(id);
    await this.persistMarkerState();
    this.broadcastQueue();
    const aborted = await this.withdraw(id, "cancel a queued message");
    this.maybeClearMarker();
    return aborted;
  }

  /**
   * Takes back a steer durable has not placed yet and returns it, so its text can go back to the
   * composer. Null when it is unknown or already in the transcript; a delivered steer stays.
   */
  async unsendSteer(id: string): Promise<QueuedMessage | null> {
    const item = this.steers.get(id);
    if (item === undefined) return null;
    const aborted = await this.withdraw(id, "take back a steer");
    this.steers.delete(id);
    this.broadcastQueue();
    return aborted ? item : null;
  }

  /** Withdraws a submission still in durable's inbox; false when it was placed or settled. */
  private async withdraw(id: string, what: string): Promise<boolean> {
    try {
      const result = await this.harness.abortSubmission(
        Number(id) as SubmissionId,
        SESSION_CONTEXT,
        this.conversation.id,
      );
      return result === "aborted";
    } catch (error) {
      console.error(`[pi] could not ${what}`, error);
      return false;
    }
  }

  async steerQueued(id: string): Promise<SubmittedMessage | null> {
    const queued = this.queued.get(id);
    if (!queued) return null;
    this.queued.delete(id);
    await this.persistMarkerState();
    this.broadcastQueue();
    // A message durable already placed is in the transcript; sending it again would duplicate it.
    if (!(await this.withdraw(id, "move a queued message into the run"))) return null;
    return this.submit(queued.item.text, "steer", {
      ...(queued.item.attachments === undefined ? {} : { attachments: queued.item.attachments }),
    });
  }

  async stop(): Promise<void> {
    if (this.runState !== "running" && this.queued.size === 0) return;
    const wasRunning = this.runState === "running";
    if (wasRunning && this.marker !== undefined) {
      this.marker = {
        ...this.marker,
        stopRequested: true,
        updatedAt: new Date().toISOString(),
      };
      await this.writeMarker(this.marker);
    }
    if (wasRunning) this.taskActivity?.runFailed("interrupted", "stopped from the chat");
    try {
      await this.conversation.abort(SESSION_CONTEXT);
    } catch (error) {
      console.error("[pi] abort failed", error);
    } finally {
      this.queued.clear();
      // Pending steers stay until their submissions settle, so each one can be reported as
      // dropped with the reason instead of vanishing when the run stops.
      if (wasRunning) {
        this.setRunState("idle");
      } else {
        await this.persistMarkerState();
        this.broadcastQueue();
      }
    }
  }

  private async restorePersistedQueue(): Promise<void> {
    const marker = this.marker;
    if (marker === undefined || marker.stopRequested) return;
    // Reacquire the submissions a pre-requestId marker named, instead of admitting
    // them again under a new key. The old restore used `run-queue:<marker>:<item>`;
    // newer markers carry the request id they admitted.
    let live: Awaited<ReturnType<Harness["inspect"]>>["submissions"] = [];
    try {
      const inspection = await this.harness.inspect(SESSION_CONTEXT);
      live = inspection.submissions.filter(
        (record) => String(record.conversationId) === String(this.conversation.id),
      );
    } catch (error) {
      console.error("[pi] could not inspect queued submissions", error);
    }
    const byId = new Map(live.map((record) => [String(record.id), record]));
    const byRequest = new Map(
      live.flatMap((record) =>
        record.requestId === undefined ? [] : [[record.requestId, record] as const],
      ),
    );
    const failed: QueuedMessage[] = [];
    let adopted = false;
    for (const item of marker.queue) {
      const queueKey = item.key ?? `q-${item.id}`;
      const legacyRequestId = `run-queue:${marker.idempotencyKey}:${item.id}`;
      const existing =
        byId.get(item.id) ??
        (item.requestId === undefined ? undefined : byRequest.get(item.requestId)) ??
        byRequest.get(legacyRequestId);
      if (existing !== undefined) {
        if (existing.status !== "queued") continue;
        const submission = await this.harness.submission(existing.id, SESSION_CONTEXT);
        if (submission === undefined) {
          failed.push(item);
          continue;
        }
        const id = String(existing.id);
        this.queued.set(id, {
          item: {
            ...item,
            id,
            key: queueKey,
            requestId: existing.requestId ?? item.requestId ?? legacyRequestId,
          },
          submission,
        });
        adopted = true;
        void this.monitorSubmission(submission, false, id);
        continue;
      }
      try {
        await this.submit(item.text, "queue", {
          requestId: item.requestId ?? legacyRequestId,
          queueKey,
          ...(item.attachments === undefined ? {} : { attachments: item.attachments }),
        });
      } catch (error) {
        console.error("[pi] could not restore a queued message", error);
        failed.push(item);
      }
    }
    // Adopted submissions do not themselves ask durable for a boundary. If they are
    // still waiting and no run is live, continue once so they are placed and answered.
    if (this.queued.size > 0) {
      try {
        const facts = await this.durableRunFacts();
        if (!facts.run) {
          await this.conversation.submit({ type: "continue" }, SESSION_CONTEXT);
        }
      } catch (error) {
        console.error("[pi] could not resume the restored queue", error);
      }
    }
    if (adopted) this.broadcastQueue();
    // Retire only items this pass actually handled; a failed restore stays in the
    // marker so the next restart can retry it instead of dropping the message.
    const current = this.marker ?? marker;
    const queue = [...this.queueItems()];
    for (const item of failed) {
      const tracked = queue.some(
        (candidate) =>
          candidate.id === item.id ||
          (item.key !== undefined && candidate.key !== undefined && candidate.key === item.key),
      );
      if (!tracked) queue.push(item);
    }
    this.marker = { ...current, queue, updatedAt: new Date().toISOString() };
    await this.flushMarkerState();
  }

  private async persistMarkerState(flush = false): Promise<void> {
    const marker = this.marker;
    if (marker === undefined) return;
    this.marker = {
      ...marker,
      queue: this.queueItems(),
      updatedAt: new Date().toISOString(),
    };
    // The in-memory marker is authoritative and last-write-wins; one disk write per
    // tick is enough, and the caller no longer waits for it before broadcasting.
    if (flush) {
      await this.flushMarkerState();
      return;
    }
    this.scheduleMarkerWrite();
  }

  private scheduleMarkerWrite(): void {
    if (this.markerTimer !== undefined) return;
    this.markerTimer = setTimeout(() => {
      this.markerTimer = undefined;
      const marker = this.marker;
      if (marker !== undefined) void this.writeMarker(marker);
    }, 0);
    this.markerTimer.unref?.();
  }

  /** Writes the newest marker before the process closes, without reviving a cleared one. */
  private async flushMarkerState(): Promise<void> {
    if (this.markerTimer !== undefined) {
      clearTimeout(this.markerTimer);
      this.markerTimer = undefined;
    }
    const marker = this.marker;
    if (marker !== undefined) await this.writeMarker(marker);
    else await this.markerWrites;
  }

  private async writeMarker(marker: RunMarker): Promise<void> {
    this.markerWrites = this.markerWrites
      .then(() => this.markerStore.write(marker))
      .catch((error: unknown) => {
        console.error("[pi] could not persist the run marker", error);
      });
    await this.markerWrites;
  }

  private async clearMarker(): Promise<void> {
    this.marker = undefined;
    if (this.markerTimer !== undefined) {
      clearTimeout(this.markerTimer);
      this.markerTimer = undefined;
    }
    this.markerWrites = this.markerWrites
      .then(() => this.markerStore.clear())
      .catch((error: unknown) => {
        console.error("[pi] could not clear the run marker", error);
      });
    await this.markerWrites;
  }

  /** The transcript message a retried client send already produced, if it is placed. */
  private async placedClientMessage(queueKey: string): Promise<ChatMessage | undefined> {
    const context = await this.conversation.context(SESSION_CONTEXT);
    const entry = context.entries.find((candidate) => clientKeyFromEntry(candidate) === queueKey);
    if (entry === undefined) return undefined;
    return buildTranscript([entry], this.mediaRef, this.diagramRevision).messages[0];
  }

  private async submittedMessage(
    submission: Submission,
    text: string,
    steer: boolean,
    attachments: string[] = [],
    steerKey?: string,
  ): Promise<{ message: ChatMessage; placed: boolean }> {
    const record = await submission.status(SESSION_CONTEXT);
    const entryId = "entry" in record ? record.entry : undefined;
    const placed = record.status === "placed" || record.status === "done";
    if (entryId !== undefined) {
      const context = await this.conversation.context(SESSION_CONTEXT);
      const entry = context.entries.find((candidate) => candidate.id === entryId);
      if (entry) {
        const message = buildTranscript([entry], this.mediaRef, this.diagramRevision).messages[0];
        if (message) {
          return {
            message: steer ? { ...message, steer: true } : message,
            placed,
          };
        }
      }
    }

    const notice = parseNotice(text);
    return {
      message: {
        id: `m-pending-${submission.id}`,
        role: "user",
        text,
        ...(notice === null ? {} : { notice }),
        ...(attachments.length > 0
          ? {
              attachments: attachments.map((id) => ({
                id,
                mimeType:
                  Object.entries(MEDIA_TYPES).find(([, ext]) => id.endsWith(`.${ext}`))?.[0] ??
                  "image/png",
              })),
            }
          : {}),
        timestamp: new Date().toISOString(),
        order: entryId ?? Number.MAX_SAFE_INTEGER,
        ...(steer ? { steer: true } : {}),
        ...(steerKey === undefined ? {} : { steerKey }),
      },
      placed,
    };
  }

  private async monitorSubmission(
    submission: Submission,
    startsRun: boolean,
    queuedId: string | undefined,
  ): Promise<void> {
    const steerId = String(submission.id);
    let final: SettledSubmissionRecord | undefined;
    try {
      const settled = await submission.wait(SESSION_CONTEXT);
      final = settled;
      if (settled.status === "unanswered") {
        if (settled.reason !== "merged_into_mcp_notice") {
          console.warn(
            `[pi] run ${submission.id} ended without an answer: ${settled.reason}` +
              (settled.detail === undefined ? "" : ` (${JSON.stringify(settled.detail)})`),
          );
        }
        if (settled.reason === "no_model") {
          await this.appendNoModelMessage();
        }
      }
    } catch (error) {
      console.error("[pi] submission wait failed", error);
    } finally {
      if (this.steers.has(steerId)) {
        if (final?.status === "unanswered") {
          this.dropSteer(steerId, steerDropReason(final.reason, final.detail));
        } else if (final?.type === "input" && final.status === "done") {
          await this.consumeSteerEntry(final.entry, steerId);
          if (this.steers.has(steerId)) {
            this.dropSteer(steerId, "The run ended before the steer was delivered.");
          }
        } else {
          this.dropSteer(steerId, "The server lost track of the steer before it was delivered.");
        }
      }
      if (queuedId !== undefined && this.queued.delete(queuedId)) {
        // Delivery is the point this queue item must leave the durable marker too.
        await this.persistMarkerState(true);
        this.broadcastQueue();
      }
      // A withdrawn queue item can leave successors behind after a failed run.
      if (queuedId !== undefined) void this.drainQueuedInputs();
      if (startsRun && this.queued.size === 0) this.setRunState("idle");
      else this.maybeClearMarker();
    }
  }

  /** Removes the pending steer an entry consumed and shows the entry in the same update. */
  private consumeSteerEntryRecord(entry: EntryRecord, submissionId?: string): boolean {
    const message = buildTranscript([entry], this.mediaRef, this.diagramRevision).messages[0];
    if (message === undefined) return false;
    if (!this.takeTrackedSteer(message, submissionId)) return false;
    this.hub.broadcast([
      {
        event: "message.done",
        data: { message } satisfies StreamMessageDone,
      },
      {
        event: "run.state",
        data: this.getRunStatus() satisfies StreamRunState,
      },
    ]);
    return true;
  }

  /** Reads an entry by id and consumes its pending steer, for events that arrived out of order. */
  private async consumeSteerEntry(entryId: number, submissionId?: string): Promise<boolean> {
    const context = await this.conversation.context(SESSION_CONTEXT);
    const entry = context.entries.find((candidate) => candidate.id === entryId);
    return entry === undefined ? false : this.consumeSteerEntryRecord(entry, submissionId);
  }

  /** Takes a tracked steer off the queue when its transcript entry carries the same key. */
  private takeTrackedSteer(message: ChatMessage, submissionId?: string): boolean {
    let removed = false;
    if (submissionId !== undefined && this.steers.delete(submissionId)) removed = true;
    if (message.steerKey !== undefined) {
      for (const [id, steer] of this.steers) {
        if (steer.key !== message.steerKey) continue;
        this.steers.delete(id);
        removed = true;
      }
    }
    return removed;
  }

  /** Consumes every pending steer already present in a snapshot's entries. */
  private consumeSteersInEntries(entries: readonly EntryRecord[]): ChatMessage[] {
    const consumed: ChatMessage[] = [];
    for (const entry of entries) {
      if (entry.kind !== STEER_ENTRY_KIND) continue;
      const message = buildTranscript([entry], this.mediaRef, this.diagramRevision).messages[0];
      if (message !== undefined && this.takeTrackedSteer(message)) consumed.push(message);
    }
    return consumed;
  }

  /** A pending steer durable dropped is reported as failed, never silently removed. */
  private dropSteer(id: string, reason: string): boolean {
    if (!this.steers.delete(id)) return false;
    this.hub.broadcast([
      {
        event: "steer.dropped",
        data: { id, reason } satisfies StreamSteerDropped,
      },
      {
        event: "run.state",
        data: this.getRunStatus() satisfies StreamRunState,
      },
    ]);
    return true;
  }

  /**
   * Collapses each run of consecutive queued MCP notices into one entry, just
   * before durable's final boundary places the oldest follow-up. The run rule
   * matches `mergeQueuedNotices`: a human message (or another notice kind) ends
   * the run. A run larger than the text cap becomes several merged entries, each
   * saying how many events it carries and how many remain.
   */
  private async mergeQueuedMcpNotices(): Promise<void> {
    if (this.closed || this.mergingMcpQueue) return;
    let runLength = 0;
    let longest = 0;
    for (const item of this.queueItems()) {
      if (item.notice?.kind === MCP_NOTICE_ENTRY_KIND) {
        runLength += 1;
        longest = Math.max(longest, runLength);
      } else {
        runLength = 0;
      }
    }
    if (longest < 2) return;

    this.mergingMcpQueue = true;
    try {
      const changes = await this.conversation.commit(async (tx) => {
        const inbox = await tx.doc(InboxDoc, this.conversation.id);
        const items = inbox.items;
        const infos: McpQueueItemInfo[] = [];
        const removed: string[] = [];
        for (let index = 0; index < items.length; ) {
          const first = items[index];
          if (first === undefined || !isMergeableMcpNoticeItem(first)) {
            index += 1;
            continue;
          }
          let end = index + 1;
          while (end < items.length) {
            const next = items[end];
            if (next === undefined || !isMergeableMcpNoticeItem(next)) break;
            end += 1;
          }
          if (end - index < 2) {
            index = end;
            continue;
          }
          const run = items.slice(index, end) as InboxInputItem[];
          const merged = mergeMcpNoticeItems(run);
          if (merged === null) {
            index = end;
            continue;
          }
          const chunks = splitMcpEvents(
            { head: merged.head, items: merged.events, dropped: merged.dropped },
            merged.events,
          );
          const replacements: InboxItem[] = [];
          let carriedBefore = 0;
          for (let part = 0; part < chunks.length; part++) {
            const events = chunks[part] ?? [];
            const reused = part < run.length ? run[part] : undefined;
            const base = inboxItemData(reused ?? run[0] ?? run[run.length - 1]);
            const text = mergedNoticeText(
              merged.head,
              merged.events.length,
              merged.dropped,
              events,
              part,
              chunks.length,
              carriedBefore,
            );
            const queueKey =
              reused !== undefined && typeof base.queueKey === "string" && base.queueKey.length > 0
                ? base.queueKey
                : randomUUID();
            const requestId = reused === undefined ? queueRequestId(queueKey) : undefined;
            // A fresh id keeps a later display update for one source notice
            // from becoming the group's first entry and hiding the merge.
            const noticeId = `mcp/merged#${randomUUID()}`;
            const data = {
              ...base,
              noticeId,
              noticeIds: [...merged.noticeIds],
              key: typeof base.key === "string" ? base.key : "mcp/merged",
              text,
              at: merged.at,
              createdAt: merged.createdAt,
              queueKey,
              ...(chunks.length > 1 ? { mergedChunk: true } : {}),
            };
            if (reused !== undefined) {
              reused.content = text;
              reused.entry = { kind: MCP_NOTICE_ENTRY_KIND, data };
              replacements.push(reused);
            } else {
              const record = await tx.createSubmission({
                conversationId: this.conversation.id,
                type: "input",
                status: "queued",
                ...(requestId === undefined ? {} : { requestId }),
              });
              replacements.push({
                id: record.id,
                mode: "followUp",
                content: text,
                entry: { kind: MCP_NOTICE_ENTRY_KIND, data },
              });
            }
            const replacement = replacements[replacements.length - 1];
            if (replacement !== undefined) {
              infos.push({
                id: replacement.id,
                text,
                createdAt: merged.createdAt,
                key: queueKey,
                ...(requestId === undefined ? {} : { requestId }),
              });
            }
            carriedBefore += events.length;
          }
          for (let part = chunks.length; part < run.length; part++) {
            const item = run[part];
            if (item === undefined) continue;
            tx.settleSubmission(item.id, {
              status: "unanswered",
              reason: "merged_into_mcp_notice",
            });
            removed.push(String(item.id));
          }
          items.splice(index, run.length, ...replacements);
          index += replacements.length;
        }
        return { infos, removed };
      }, SESSION_CONTEXT);

      if (changes.infos.length === 0 && changes.removed.length === 0) return;
      for (const id of changes.removed) this.queued.delete(id);
      for (const info of changes.infos) {
        const id = String(info.id);
        const existing = this.queued.get(id);
        if (existing !== undefined) {
          existing.item.text = info.text;
          existing.item.createdAt = info.createdAt;
          continue;
        }
        const submission = await this.harness.submission(info.id, SESSION_CONTEXT);
        if (submission === undefined) continue;
        this.queued.set(id, {
          item: {
            id,
            text: info.text,
            createdAt: info.createdAt,
            key: info.key,
            ...(info.requestId === undefined ? {} : { requestId: info.requestId }),
            notice: {
              kind: MCP_NOTICE_ENTRY_KIND,
              label: "MCP events",
              glyph: queuedNoticeGlyph(MCP_NOTICE_ENTRY_KIND),
            },
          },
          submission,
        });
      }
      await this.persistMarkerState();
      this.broadcastQueue();
    } catch (error) {
      console.error("[pi] could not merge queued MCP notices", error);
    } finally {
      this.mergingMcpQueue = false;
    }
  }

  /**
   * Applies the MCP event policy to one event notice. The first event of a key
   * starts a normal notice/turn; later events in its window replace that
   * notice's text without appending a turn; redundant events are dropped.
   */
  async submitMcpEventNotice(
    text: string,
    deliverAs?: "steer" | "followUp" | "nextTurn",
  ): Promise<void> {
    const envelope = mcpEventEnvelope(text);
    if (envelope === null) {
      const at = new Date().toISOString();
      const status = text.startsWith(MCP_STATUS_HEAD);
      const kind = status ? "status" : "notice";
      await this.submit(text, deliverAs === "steer" ? "steer" : "queue", {
        entry: {
          kind: MCP_NOTICE_ENTRY_KIND,
          label: status ? "MCP status" : "MCP notice",
          data: {
            noticeId: `mcp/${kind}#${randomUUID()}`,
            key: `mcp/${kind}`,
            text,
            at,
            createdAt: at,
          },
        },
      });
      return;
    }

    const byNotice = new Map<string, { key: string; events: unknown[] }>();
    const firstNotices = new Set<string>();
    const immediate: unknown[] = [];
    const committed: unknown[] = [];
    for (const item of envelope.items) {
      const decision = this.mcpNotices.observe(item);
      if (decision.mode === "immediate") {
        immediate.push(item);
        committed.push(item);
        for (const noticeId of this.mcpNoticeEvents.keys()) {
          if (noticeId === decision.key || noticeId.startsWith(`${decision.key}#`)) {
            this.mcpNoticeEvents.delete(noticeId);
          }
        }
        continue;
      }
      if (decision.mode === "drop" && !decision.fold) continue;
      const noticeId = decision.noticeId;
      if (noticeId === null) continue;
      const fresh = decision.action === "deliver" && decision.first;
      if (fresh) {
        for (const previousId of this.mcpNoticeEvents.keys()) {
          if (
            previousId !== noticeId &&
            (previousId === decision.key || previousId.startsWith(`${decision.key}#`))
          ) {
            this.mcpNoticeEvents.delete(previousId);
          }
        }
      }
      const current = fresh
        ? { key: decision.key, events: [] }
        : (byNotice.get(noticeId) ??
          (this.mcpNoticeEvents.has(noticeId)
            ? { key: decision.key, events: this.mcpNoticeEvents.get(noticeId) ?? [] }
            : { key: decision.key, events: [] }));
      const next = [...current.events, item];
      byNotice.set(noticeId, { key: current.key, events: next });
      committed.push(item);
      if (fresh) firstNotices.add(noticeId);
    }

    for (const [noticeId, notice] of byNotice) {
      this.mcpNoticeEvents.set(noticeId, notice.events);
      const at = new Date().toISOString();
      const latest = mcpEventText(envelope, notice.events);
      this.lastMcpNoticeText = latest;
      if (firstNotices.has(noticeId)) {
        await this.submit(latest, "queue", {
          entry: {
            kind: MCP_NOTICE_ENTRY_KIND,
            label: "MCP events",
            data: {
              noticeId,
              key: notice.key,
              text: latest,
              at,
              createdAt: at,
            },
          },
        });
      } else {
        const message = await appendMcpNotice(this.conversation, {
          noticeId,
          key: notice.key,
          text: latest,
          at,
        });
        if (message !== undefined) this.hub.broadcast({ event: "notice", data: { message } });
      }
    }

    if (immediate.length > 0) {
      const text = mcpEventText(envelope, immediate);
      this.lastMcpNoticeText = text;
      const at = new Date().toISOString();
      await this.submit(text, "queue", {
        entry: {
          kind: MCP_NOTICE_ENTRY_KIND,
          label: "MCP events",
          data: {
            // An immediate event is a new notice, never an update of an earlier window.
            noticeId: `mcp/immediate#${randomUUID()}`,
            key: "mcp/immediate",
            text,
            at,
            createdAt: at,
          },
        },
      });
    }

    // The durable delivered set may only name ids whose notice was submitted.
    // A failure above leaves them novel so the retry can still produce a chip.
    this.eventFeed?.markDelivered(committed);
  }

  /** Durable outbox batches already contain only novel events. Use the same request id
   * on every retry/restart; durable deduplicates both queued and placed submissions.
   * An over-cap merge keeps one logical delivery but submits each bounded part with
   * its own queue/cancel identity, in order. */
  async submitMcpDelivery(item: {
    id: string;
    text: string;
    at: string;
    texts?: string[];
    mergedChunk?: boolean;
  }): Promise<void> {
    const texts = item.texts !== undefined && item.texts.length > 0 ? item.texts : [item.text];
    const base = `mcp-delivery:${item.id}`;
    const multiPart = texts.length > 1 || item.mergedChunk === true;
    for (let index = 0; index < texts.length; index++) {
      const text = texts[index] ?? "";
      const identity = texts.length === 1 ? base : `${base}:${index}`;
      this.lastMcpNoticeText = text;
      await this.submit(text, "queue", {
        requestId: identity,
        queueKey: identity,
        entry: {
          kind: MCP_NOTICE_ENTRY_KIND,
          label: "MCP events",
          data: {
            noticeId: identity,
            key: identity,
            text,
            at: item.at,
            createdAt: item.at,
            // These parts already carry their own carried/remaining summary, so
            // the queue merger must not merge them again and duplicate the head.
            ...(multiPart ? { mergedChunk: true } : {}),
          },
        },
      });
    }
    // Only a fully submitted delivery may remove its ids from the novel set, so a
    // retry after a failed part still has the whole delivery to replay.
    for (const text of texts) {
      const envelope = mcpEventEnvelope(text);
      if (envelope !== null) this.eventFeed?.markDelivered(envelope.items);
    }
  }

  /** Sends a job result to the agent without placing a user message in the chat. */
  async submitJobNotice(text: string): Promise<void> {
    await this.submit(text, "queue", {
      entry: {
        kind: JOB_NOTICE_ENTRY_KIND,
        label: "Background job",
        data: { text, createdAt: new Date().toISOString() },
      },
    });
  }

  /** Sends one finished delegate result to the agent as a notice chip, never a user bubble. */
  async submitDelegateNotice(text: string): Promise<void> {
    await this.submit(text, "queue", {
      entry: {
        kind: DELEGATE_NOTICE_ENTRY_KIND,
        label: "Delegate run",
        data: { text, createdAt: new Date().toISOString() },
      },
    });
  }

  /**
   * Records a job result the agent is not told about and shows it to open clients.
   * It belongs to the activity page, so this never touches the chat draft.
   */
  async recordNotice(text: string): Promise<void> {
    const activity = await appendJobNotice(this.conversation, text);
    if (activity === undefined) return;
    this.hub.broadcast({ event: "activity", data: { activity } satisfies StreamActivity });
  }

  /**
   * Shows a memory write as a persistent chat chip and remembers a long-term
   * topic write for the one tail delta this turn publishes. The chip never
   * changes the model context; the delta does, so it is coalesced by path.
   */
  async recordMemoryWrite(record: MemoryWriteRecord): Promise<void> {
    const topic = memoryDeltaTopic(record);
    if (topic !== undefined) {
      this.memoryDeltas.set(topic.path, topic);
      this.memoryDeltaId ??= randomUUID();
    }
    const message = await appendMemoryWriteNotice(this.conversation, record);
    if (message === undefined) return;
    this.hub.broadcast({ event: "notice", data: { message } satisfies StreamNotice });
  }

  /**
   * Publishes the long-term writes collected during this turn as one compact
   * notice at the tail through the normal queue path. The entry carries a
   * stable batch id, so an ambiguous or retried submit is a no-op once the
   * entry exists. Pending writes are cleared only after that confirmation.
   */
  async flushMemoryDelta(): Promise<void> {
    if (this.flushingMemoryDelta || this.memoryDeltas.size === 0) return;
    this.flushingMemoryDelta = true;
    const deltaId = this.memoryDeltaId ?? randomUUID();
    this.memoryDeltaId = deltaId;
    const topics = [...this.memoryDeltas.values()];
    const text = memoryDeltaPrompt(topics);
    const createdAt = new Date().toISOString();
    try {
      const context = await this.conversation.context(SESSION_CONTEXT);
      const recorded = context.entries.some(
        (entry) =>
          entry.kind === MEMORY_DELTA_ENTRY_KIND &&
          isRecord(entry.data) &&
          entry.data.deltaId === deltaId,
      );
      if (!recorded) {
        await this.submit(text, "queue", {
          entry: {
            kind: MEMORY_DELTA_ENTRY_KIND,
            label: "Memory updated",
            data: { deltaId, text, topics, createdAt },
          },
        });
      }
      for (const topic of topics) {
        if (this.memoryDeltas.get(topic.path) === topic) this.memoryDeltas.delete(topic.path);
      }
      if (this.memoryDeltas.size === 0) this.memoryDeltaId = undefined;
      else this.memoryDeltaId = randomUUID();
    } catch (error) {
      // Keep the same id and topics so a retry can recognise an ambiguous append.
      console.error("[pi] could not publish the memory delta", error);
    } finally {
      this.flushingMemoryDelta = false;
    }
  }

  /** Shows a notify_operator call as a persistent chat chip without placing a user message. */
  async recordOperatorNotice(record: OperatorNoticeRecord): Promise<void> {
    const message = await appendOperatorNotice(this.conversation, record);
    if (message === undefined) return;
    this.hub.broadcast({ event: "notice", data: { message } satisfies StreamNotice });
  }

  /**
   * Delivers a proposal decision to the model through the queue path, as one notice
   * chip. An idle chat starts a turn with the decision; a running turn gets it as a
   * follow-up. The proposal id makes a repeated delivery a no-op.
   */
  async recordTaskDecision(record: TaskDecisionNoticeRecord): Promise<void> {
    const key = record.proposalId;
    if (this.taskDecisions.has(key)) return;
    this.taskDecisions.add(key);
    try {
      const context = await this.conversation.context(SESSION_CONTEXT);
      const recorded = context.entries.some(
        (entry) =>
          entry.kind === TASK_DECISION_ENTRY_KIND &&
          isRecord(entry.data) &&
          entry.data.proposalId === key,
      );
      if (recorded) return;
      const text = taskDecisionPrompt(record);
      const createdAt = new Date().toISOString();
      await this.submit(text, "queue", {
        // The decision entry and its queue placement share one durable admission key.
        requestId: decisionRequestId(key),
        entry: {
          kind: TASK_DECISION_ENTRY_KIND,
          label: record.decision === "approved" ? "Proposal approved" : "Proposal declined",
          data: {
            proposalId: record.proposalId,
            taskId: record.taskId,
            taskTitle: record.taskTitle,
            decision: record.decision,
            text,
            createdAt,
          },
        },
      });
    } catch (error) {
      this.taskDecisions.delete(key);
      throw error;
    }
  }

  private async appendNoModelMessage(): Promise<void> {
    const text =
      "pi has no model configured for this conversation. Add provider credentials to " +
      "PI_CODING_AGENT_DIR/auth.json, then send the message again.";
    try {
      await appendAssistantError(this.conversation, text);
    } catch (error) {
      console.error("[pi] could not record the missing-model message", error);
      this.hub.broadcast({
        event: "message.done",
        data: { message: null } satisfies StreamMessageDone,
      });
    }
  }

  /** Start a view revision's diff from a fresh attachment: no history is replayed. */
  private resetView(view: ConversationView): ViewSnapshot {
    let newest: EntryRecord["id"] | undefined;
    for (const entry of view.entries) {
      if (newest === undefined || entry.id > newest) newest = entry.id;
    }
    this.lastViewEntryId = newest;
    this.viewLive = view.docs["pi.live"] as LiveState | undefined;
    return this.viewSnapshot(view);
  }

  private viewSnapshot(view: ConversationView): ViewSnapshot {
    const live = view.docs["pi.live"] as LiveState | undefined;
    const inbox = view.docs["pi.inbox"] as { items?: readonly unknown[] } | undefined;
    const message = live?.generation?.message as AssistantMessage | undefined;
    return {
      type: "snapshot",
      entries: view.entries,
      ...(live?.run === undefined ? {} : { run: { inputs: live.run.inputs } }),
      ...(live?.generation === undefined
        ? {}
        : {
            generation: {
              attempt: live.generation.attempt,
              ...(message === undefined ? {} : { message }),
            },
          }),
      tools: live?.tools ?? [],
      inbox: inbox?.items ?? [],
    };
  }

  /**
   * Turns one conversation view revision into the events the handlers below already understand.
   * Durable 1.5 removed `watchEvents()`; the view carries the same run, partial, tool, retry,
   * compaction, and transcript information, so the diff keeps the UI behaviour intact.
   */
  private async handleView(view: ConversationView): Promise<void> {
    this.lastEventAt = Date.now();
    const live = view.docs["pi.live"] as LiveState | undefined;
    const previousLive = this.viewLive;
    this.viewLive = live;

    const newEntries: EntryRecord[] = [];
    let newest = this.lastViewEntryId;
    for (const entry of view.entries) {
      if (this.lastViewEntryId === undefined || entry.id > this.lastViewEntryId) {
        newEntries.push(entry);
      }
      if (newest === undefined || entry.id > newest) newest = entry.id;
    }
    this.lastViewEntryId = newest;
    newEntries.sort((left, right) => left.id - right.id);

    const partial = live?.generation?.message as AssistantMessage | undefined;
    if (
      partial !== undefined &&
      partial !== (previousLive?.generation?.message as AssistantMessage | undefined)
    ) {
      await this.handleEvent({
        type: "message_update",
        changes: [{ type: "message", message: partial }],
      });
    }

    const retryBefore = previousLive?.generation?.retry;
    const retry = live?.generation?.retry;
    if (retry !== undefined && retryBefore === undefined) {
      await this.handleEvent({
        type: "auto_retry_start",
        attempt: live?.generation?.attempt ?? 0,
        at: retry.at,
        errorMessage: retry.error,
      });
    } else if (retry === undefined && retryBefore !== undefined) {
      await this.handleEvent({
        type: "auto_retry_end",
        attempt: previousLive?.generation?.attempt ?? 0,
      });
    }

    await this.dispatchToolEvents(view, previousLive);

    for (const entry of newEntries) {
      if (this.closed) return;
      try {
        await this.handleEvent(
          entry.model?.[0] === undefined
            ? { type: "entry_appended", entry }
            : { type: "message_end", entry },
        );
        await this.releasePlacedQueueEntry(entry);
      } catch (error) {
        console.error("[pi] view entry handling failed", error);
      }
    }
    if (newEntries.length > 0) {
      try {
        await this.retireSettledQueueEntries();
      } catch (error) {
        console.error("[pi] queued settlement handling failed", error);
      }
    }

    const compactionsBefore = previousLive?.compactions ?? [];
    const compactions = live?.compactions ?? [];
    for (const compaction of compactionsBefore) {
      if (compactions.some((current) => current.taskId === compaction.taskId)) continue;
      const failure = live?.compactionFailure;
      await this.handleEvent({
        type: "compaction_end",
        reason: compaction.trigger,
        ...(failure?.taskId === compaction.taskId ? { error: failure.error } : {}),
      });
    }
    for (const compaction of compactions) {
      if (compactionsBefore.some((previous) => previous.taskId === compaction.taskId)) continue;
      this.compactionRefreshes.add(String(compaction.taskId));
      await this.handleEvent({ type: "compaction_start", reason: compaction.trigger });
    }

    // A compaction that started and ended between two view revisions never appeared in
    // `pi.live.compactions`; its failure or summary entry is the only trace of it.
    const failure = live?.compactionFailure;
    const failureBefore = previousLive?.compactionFailure;
    const shortFailure =
      failure !== undefined &&
      failure.taskId !== failureBefore?.taskId &&
      !compactions.some((compaction) => compaction.taskId === failure.taskId) &&
      !compactionsBefore.some((compaction) => compaction.taskId === failure.taskId);
    if (shortFailure) {
      this.compactionRefreshes.add(String(failure.taskId));
      await this.beforeTurn("compaction");
      console.error(`[pi] compaction failed: ${failure.error}`);
    }
    const shortSummary = newEntries.find((entry) => {
      if (entry.kind !== CompactionEntry.kind) return false;
      return entry.byTaskId === undefined || !this.compactionRefreshes.has(String(entry.byTaskId));
    });
    if (shortSummary !== undefined && !shortFailure) {
      if (shortSummary.byTaskId !== undefined) {
        this.compactionRefreshes.add(String(shortSummary.byTaskId));
      }
      await this.beforeTurn("compaction");
      const reason =
        CompactionEntry.is(shortSummary) && isRecord(shortSummary.data)
          ? shortSummary.data.reason
          : "unknown";
      console.log(`[pi] compaction finished (${String(reason)})`);
    }

    const wasRunning = previousLive?.run !== undefined;
    const running = live?.run !== undefined;
    if (running && !wasRunning) await this.handleEvent({ type: "run_start" });
    else if (!running && wasRunning) await this.handleEvent({ type: "run_end" });
  }

  private async dispatchToolEvents(
    view: ConversationView,
    previousLive: LiveState | undefined,
  ): Promise<void> {
    const previous = new Map((previousLive?.tools ?? []).map((slot) => [slot.callId, slot]));
    const current = new Map(
      ((view.docs["pi.live"] as LiveState | undefined)?.tools ?? []).map((slot) => [
        slot.callId,
        slot,
      ]),
    );
    const argumentsByCall = this.toolArguments(view.entries);
    for (const slot of current.values()) {
      const before = previous.get(slot.callId);
      const args = argumentsByCall.get(slot.callId)?.arguments ?? {};
      if (isInterruptedSlot(slot)) {
        if (before !== undefined && !isTerminalSlot(before)) {
          const entry = this.entryById(view.entries, slot.entry);
          const result = this.toolResultFromSlot(slot);
          await this.handleEvent({
            type: "tool_execution_end",
            toolCallId: slot.callId,
            toolName: slot.name,
            args,
            ...(entry === undefined ? {} : { entry }),
            ...(result === undefined ? {} : { result }),
          });
        }
        continue;
      }
      if (slot.status === "running" && before?.status !== "running") {
        await this.handleEvent({
          type: "tool_execution_start",
          toolCallId: slot.callId,
          toolName: slot.name,
          args,
        });
      }
      if (slot.status === "done" && before?.status !== "done") {
        // A call that went pending (or appeared and finished) between two view revisions
        // never got its start event; send one so the client has a chip to update.
        if (before?.status !== "running") {
          await this.handleEvent({
            type: "tool_execution_start",
            toolCallId: slot.callId,
            toolName: slot.name,
            args,
          });
        }
        const entry = this.entryById(view.entries, slot.entry);
        const result = this.toolResultFromSlot(slot);
        await this.handleEvent({
          type: "tool_execution_end",
          toolCallId: slot.callId,
          toolName: slot.name,
          args,
          ...(entry === undefined ? {} : { entry }),
          ...(result === undefined ? {} : { result }),
        });
      }
    }
    for (const before of previous.values()) {
      if (before.status === "done" || current.has(before.callId)) continue;
      const entry = this.findToolResultEntry(view.entries, before.callId);
      const result = this.toolResultFromSlot(before);
      await this.handleEvent({
        type: "tool_execution_end",
        toolCallId: before.callId,
        toolName: before.name,
        args: argumentsByCall.get(before.callId)?.arguments ?? {},
        ...(entry === undefined ? {} : { entry }),
        ...(result === undefined ? {} : { result }),
      });
    }
  }

  /** What a done tool slot still has when its result entry is missing (faulted, orphaned, or folded away). */
  private toolResultFromSlot(slot: ToolSlot): ViewToolEndResult | undefined {
    if (slot.output === undefined && slot.details === undefined) return undefined;
    return {
      ...(slot.output === undefined ? {} : { output: slot.output }),
      ...(slot.details === undefined ? {} : { details: slot.details }),
      isError: (slot.diagnostics?.length ?? 0) > 0,
    };
  }

  private toolArguments(
    entries: readonly EntryRecord[],
  ): Map<string, { name: string; arguments: unknown }> {
    const calls = new Map<string, { name: string; arguments: unknown }>();
    for (const entry of entries) {
      if (!AssistantEntry.is(entry)) continue;
      const content = entry.model?.[0]?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!isRecord(block) || block.type !== "toolCall" || typeof block.id !== "string") continue;
        calls.set(block.id, {
          name: typeof block.name === "string" ? block.name : "tool",
          arguments: block.arguments,
        });
      }
    }
    return calls;
  }

  private entryById(
    entries: readonly EntryRecord[],
    id: EntryRecord["id"] | undefined,
  ): EntryRecord | undefined {
    return id === undefined ? undefined : entries.find((entry) => entry.id === id);
  }

  private findToolResultEntry(
    entries: readonly EntryRecord[],
    toolCallId: string,
  ): EntryRecord | undefined {
    return entries.find((entry) => {
      const message = entry.model?.[0];
      return message !== undefined && "toolCallId" in message && message.toolCallId === toolCallId;
    });
  }

  /** A queued bubble retires when its entry is placed, after the placed message is published. */
  private async releasePlacedQueueEntry(entry: EntryRecord): Promise<void> {
    const data = isRecord(entry.data) ? entry.data : undefined;
    const key =
      typeof data?.queueKey === "string" && data.queueKey.length > 0
        ? data.queueKey
        : entry.kind === QUEUE_ENTRY_KIND && typeof data?.key === "string" && data.key.length > 0
          ? data.key
          : undefined;
    if (key === undefined) return;
    const removed = this.removeQueuedByKeys(new Set([key]));
    if (removed) await this.publishQueueRetirement();
  }

  /**
   * Retires queued bubbles whose submissions left `queued` even when their entry carried no
   * matching key, such as the start-race path or an MCP merge replacement. Runs after the
   * view's entries, so a placed message is already on screen before its bubble goes.
   */
  private async retireSettledQueueEntries(): Promise<void> {
    if (this.queued.size === 0) return;
    let removed = false;
    for (const [id, queued] of [...this.queued]) {
      const record = await queued.submission.status(SESSION_CONTEXT).catch(() => undefined);
      if (record === undefined || record.status === "queued") continue;
      // Do not retire before the placed entry is in the view, or the pending bubble would
      // disappear for a frame while its transcript message is still in flight.
      if (
        record.entry !== undefined &&
        (this.lastViewEntryId === undefined || record.entry > this.lastViewEntryId)
      ) {
        continue;
      }
      this.queued.delete(id);
      removed = true;
    }
    if (removed) await this.publishQueueRetirement();
  }

  private removeQueuedByKeys(keys: ReadonlySet<string>): boolean {
    let removed = false;
    for (const [id, queued] of this.queued) {
      if (queued.item.key === undefined || !keys.has(queued.item.key)) continue;
      this.queued.delete(id);
      removed = true;
    }
    return removed;
  }

  private async publishQueueRetirement(): Promise<void> {
    // A delivered item must be gone from the marker before any restart can read it.
    await this.persistMarkerState(true);
    this.broadcastQueue();
    this.hub.broadcast({
      event: "message.done",
      data: { message: null } satisfies StreamMessageDone,
    });
  }

  private async handleEvent(event: ViewEvent): Promise<void> {
    switch (event.type) {
      case "snapshot": {
        this.applySnapshot(event);
        const consumed = this.consumeSteersInEntries(event.entries);
        // A snapshot replaces events durable dropped, a run's end among them.
        this.reconcileRun({
          run: event.run !== undefined,
          inbox: event.inbox.length,
          submitting: this.submitting,
        });
        const revision = this.bumpDraft();
        const frames: SseFrame[] = consumed.map((message) => ({
          event: "message.done",
          data: { message } satisfies StreamMessageDone,
        }));
        if (frames.length === 0) {
          frames.push({
            event: "message.done",
            data: { message: null } satisfies StreamMessageDone,
          });
        }
        frames.push(
          {
            event: "draft.sync",
            data: {
              text: this.currentText,
              thinking: this.currentThinking,
              revision,
            } satisfies StreamDraftSync,
          },
          {
            event: "run.state",
            data: this.getRunStatus() satisfies StreamRunState,
          },
        );
        this.hub.broadcast(frames);
        return;
      }

      case "run_start":
        this.setRunState("running");
        return;

      case "run_end":
        this.setRunState("idle");
        await this.flushMemoryDelta();
        // A run that failed keeps its queued inputs; start them here, not on a nudge tick.
        await this.drainQueuedInputs();
        return;

      case "message_update":
        for (const change of event.changes) {
          const previousText = this.currentText;
          const previousThinking = this.currentThinking;
          this.absorbMessage(change.message);
          this.publishDraft(previousText, previousThinking);
        }
        return;

      case "message_end": {
        this.measureModelCall(event.entry);
        const message = assistantMessageFromEntry(event.entry);
        if (event.entry.kind === MCP_NOTICE_ENTRY_KIND && isRecord(event.entry.data)) {
          if (typeof event.entry.data.text === "string") {
            this.lastMcpNoticeText = event.entry.data.text;
          }
        }
        this.currentText = "";
        this.currentThinking = "";
        const revision = this.bumpDraft();
        if (
          event.entry.kind === STEER_ENTRY_KIND ||
          event.entry.kind === QUEUE_ENTRY_KIND ||
          event.entry.kind === MCP_NOTICE_ENTRY_KIND ||
          event.entry.kind === DELEGATE_NOTICE_ENTRY_KIND ||
          event.entry.kind === MEMORY_DELTA_ENTRY_KIND ||
          event.entry.kind === TASK_DECISION_ENTRY_KIND ||
          event.entry.kind === IDLE_NUDGE_ENTRY_KIND
        ) {
          // Send the placed entry before the queue update retires its pending bubble, so the
          // same message id hands over without a frame where neither copy is on screen.
          // A decision or nudge chip is a user-facing state change of its own: push it now
          // instead of waiting for the run it started to end and refresh the whole chat.
          const placedMessage = buildTranscript([event.entry], this.mediaRef, this.diagramRevision)
            .messages[0];
          if (event.entry.kind === STEER_ENTRY_KIND) {
            if (placedMessage !== undefined) this.takeTrackedSteer(placedMessage);
            this.hub.broadcast([
              {
                event: "draft.sync",
                data: { text: "", thinking: "", revision } satisfies StreamDraftSync,
              },
              {
                event: "message.done",
                data: { message: placedMessage ?? null } satisfies StreamMessageDone,
              },
              {
                event: "run.state",
                data: this.getRunStatus() satisfies StreamRunState,
              },
            ]);
            return;
          }
          this.hub.broadcast([
            {
              event: "draft.sync",
              data: { text: "", thinking: "", revision } satisfies StreamDraftSync,
            },
            {
              event: "message.done",
              data: { message: placedMessage ?? null } satisfies StreamMessageDone,
            },
          ]);
          return;
        }
        if (message !== null && isMcpEventEcho(message.text, this.lastMcpNoticeText)) {
          console.warn("[chat] dropped an assistant echo of an MCP notice");
          this.hub.broadcast([
            {
              event: "draft.sync",
              data: { text: "", thinking: "", revision } satisfies StreamDraftSync,
            },
            {
              event: "message.done",
              data: { message: null } satisfies StreamMessageDone,
            },
          ]);
          return;
        }
        this.hub.broadcast([
          {
            event: "draft.sync",
            data: { text: "", thinking: "", revision } satisfies StreamDraftSync,
          },
          {
            event: "message.done",
            data: { message } satisfies StreamMessageDone,
          },
        ]);
        return;
      }

      case "tool_execution_start": {
        if (event.parentToolCallId !== undefined) return;
        const taskId = this.taskActivity?.toolStarted(event.toolName, event.args);
        const timestamp = new Date().toISOString();
        this.activeTools.set(event.toolCallId, {
          name: event.toolName,
          args: event.args,
          timestamp,
          ...(taskId === undefined ? {} : { taskId }),
        });
        this.toolsRevision += 1;
        this.hub.broadcast({
          event: "tool.start",
          data: {
            toolCallId: event.toolCallId,
            name: event.toolName,
            arguments: event.args,
            timestamp,
            toolsRevision: this.toolsRevision,
          } satisfies StreamToolStart,
        });
        return;
      }

      case "tool_execution_end": {
        if (event.parentToolCallId !== undefined) return;
        const active = this.activeTools.get(event.toolCallId);
        this.activeTools.delete(event.toolCallId);
        this.taskActivity?.toolEnded(active?.taskId);
        this.toolsRevision += 1;
        const activity = this.toolActivity(event, active);
        this.hub.broadcast({
          event: "tool.end",
          data: {
            toolCallId: event.toolCallId,
            name: activity.name,
            isError: activity.isError,
            output: activity.output,
            durationMs: activity.durationMs,
            timestamp: activity.timestamp,
            activity,
            toolsRevision: this.toolsRevision,
          } satisfies StreamToolEnd,
        });
        return;
      }

      case "entry_appended":
        if (event.entry.kind === JOB_NOTICE_ENTRY_KIND) {
          const activity = buildTranscript([event.entry]).activity[0];
          if (activity !== undefined) {
            this.hub.broadcast({
              event: "activity",
              data: { activity } satisfies StreamActivity,
            });
          }
          return;
        }
        if (event.entry.kind === STEER_ENTRY_KIND) {
          if (this.consumeSteerEntryRecord(event.entry)) return;
          this.hub.broadcast({
            event: "message.done",
            data: { message: null } satisfies StreamMessageDone,
          });
        }
        return;

      case "compaction_start":
        await this.beforeTurn("compaction");
        console.log(`[pi] compaction started (${event.reason})`);
        return;

      case "compaction_end":
        if (event.error) console.error(`[pi] compaction failed: ${event.error}`);
        else console.log(`[pi] compaction finished (${event.reason})`);
        return;

      case "auto_retry_start": {
        const now = Date.now();
        this.retryStartedAt ??= now;
        this.retryAttempts += 1;
        const budget = retryBudgetMs();
        console.warn(
          `[pi] retrying the model request (attempt ${event.attempt}): ${event.errorMessage}`,
        );
        if (retryBudgetExhausted(this.retryStartedAt, now, budget)) {
          void this.abandonRetryingTurn(retrySpentMs(this.retryStartedAt, now));
        }
        return;
      }

      case "auto_retry_end":
        // The provider answered again, so the next failure starts a fresh budget.
        this.resetRetryBudget();
        return;

      default:
        return;
    }
  }

  private applySnapshot(snapshot: ViewSnapshot): void {
    this.currentText = "";
    this.currentThinking = "";
    this.rememberLatestMcpNotice(snapshot.entries);
    const partial = snapshot.generation?.message;
    if (partial) {
      this.absorbMessage(partial);
    }

    this.activeTools.clear();
    for (const slot of snapshot.tools) {
      if (isTerminalSlot(slot)) continue;
      this.activeTools.set(slot.callId, {
        name: slot.name,
        args: {},
        timestamp: new Date().toISOString(),
      });
    }
    this.toolsRevision += 1;
  }

  /** Recover the latest delivered notice so an echo is caught after a restart too. */
  private rememberLatestMcpNotice(entries: readonly EntryRecord[]): void {
    let latestId = -1;
    for (const entry of entries) {
      if (entry.kind !== MCP_NOTICE_ENTRY_KIND || !isRecord(entry.data)) continue;
      if (typeof entry.data.text !== "string" || entry.id < latestId) continue;
      latestId = entry.id;
      this.lastMcpNoticeText = entry.data.text;
    }
  }

  private absorbMessage(message: AssistantMessage): void {
    const texts: string[] = [];
    const thinking: string[] = [];
    for (const block of message.content) {
      if (block.type === "text") texts.push(block.text);
      else if (block.type === "thinking") thinking.push(block.thinking);
    }
    this.currentText = texts.join("");
    this.currentThinking = thinking.join("");
  }

  private toolActivity(
    event: Extract<ViewEvent, { type: "tool_execution_end" }>,
    active: ActiveTool | undefined,
  ): ToolActivity {
    if (event.entry) {
      const activity = toolActivityFromEntry(event.entry, active?.args);
      if (activity) return activity;
    }

    const result = event.result;
    const memory = parseMemoryToolDetails(result?.details);
    return {
      kind: "tool",
      id: `local-${event.toolCallId}`,
      name: event.toolName,
      arguments: formatToolArguments(active?.args ?? event.args),
      output: result?.output === undefined ? "The tool did not finish." : formatToolResult(result),
      details: formatToolDetails(result?.details),
      ...(memory === undefined ? {} : { memory }),
      isError: result?.isError ?? true,
      durationMs: result?.durationMs,
      timestamp: new Date().toISOString(),
      order: Number.MAX_SAFE_INTEGER,
    };
  }

  private queueItems(): QueuedMessage[] {
    return [...this.queued.values()].map((entry) => entry.item);
  }

  private steerItems(): QueuedMessage[] {
    return [...this.steers.values()];
  }

  /** After a restart, steers still in durable's inbox are listed again, so they can be taken back. */
  private async restorePendingSteers(): Promise<void> {
    try {
      const view = await this.readView();
      const inbox = view.docs["pi.inbox"] as
        | {
            items?: {
              id?: unknown;
              mode?: unknown;
              content?: unknown;
              entry?: { data?: unknown };
            }[];
          }
        | undefined;
      for (const item of inbox?.items ?? []) {
        const steer = steerFromInboxItem(item);
        if (steer === undefined || this.steers.has(steer.id)) continue;
        this.steers.set(steer.id, steer);
      }
    } catch (error) {
      console.error("[pi] could not read pending steers", error);
    }
  }

  /** Reads one conversation view and releases its watch; for the watchdog and restart recovery. */
  private async readView(): Promise<ConversationView> {
    const watch = await this.watchConversation();
    try {
      return watch.value;
    } finally {
      await watch.stop();
    }
  }

  /**
   * A torn durable view throws while it materialises. Repair the store and retry once instead of
   * ending the turn; if the doctor cannot help, the original failure still reaches the caller.
   */
  private async watchConversation(): Promise<ConversationWatch> {
    try {
      return await this.conversation.watch(SESSION_CONTEXT);
    } catch (error) {
      if (this.repairDurableState === undefined) throw error;
      console.error("[pi] conversation view is unreadable; running the durable doctor", error);
      const report = await this.repairDurableState();
      if (report.repaired) {
        console.warn(`[durable] ${report.lines.join("; ")}`);
        await recordDurableRepairNotice(this.conversation, report);
      }
      return await this.conversation.watch(SESSION_CONTEXT);
    }
  }

  private broadcastQueue(): void {
    this.hub.broadcast({
      event: "run.state",
      data: this.getRunStatus(),
    });
  }

  private maybeClearMarker(): void {
    if (this.runState === "idle" && !this.shuttingDown && this.queued.size === 0) {
      void this.clearMarker();
    }
  }

  private setRunState(state: RunState): void {
    if (this.runState === state) {
      this.maybeClearMarker();
      return;
    }
    this.runState = state;
    this.idleNudge.noteActivity();
    if (state === "running") this.taskActivity?.runStarted();
    else this.taskActivity?.runEnded(state === "interrupted");
    if (state === "running") {
      this.lastEventAt = Date.now();
    } else {
      this.currentText = "";
      this.currentThinking = "";
      this.resetRetryBudget();
      if (this.activeTools.size > 0) {
        this.activeTools.clear();
        this.toolsRevision += 1;
      }
    }
    this.maybeClearMarker();
    this.hub.broadcast({
      event: "run.state",
      data: this.getRunStatus(),
    });
  }

  /** Hand a finished model reply to the task tracker: its attributed tool calls, cost and failure. */
  private measureModelCall(entry: EntryRecord): void {
    const tracker = this.taskActivity;
    if (tracker === undefined || !AssistantEntry.is(entry)) return;
    const message = entry.model?.[0] as
      | {
          content?: unknown;
          usage?: { input?: unknown; output?: unknown; cost?: { total?: unknown } };
          stopReason?: unknown;
          errorMessage?: unknown;
        }
      | undefined;
    if (message === undefined) return;
    const blocks = Array.isArray(message.content) ? (message.content as unknown[]) : [];
    const toolCalls = blocks
      .filter(
        (block): block is { type: "toolCall"; arguments: unknown } =>
          typeof block === "object" &&
          block !== null &&
          (block as { type?: unknown }).type === "toolCall",
      )
      .map((block) => ({ arguments: block.arguments }));
    const number = (value: unknown) =>
      typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
    tracker.modelCall({
      toolCalls,
      tokens: number(message.usage?.input) + number(message.usage?.output),
      cost: number(message.usage?.cost?.total),
    });
    if (message.stopReason === "error") {
      tracker.runFailed(
        "error",
        typeof message.errorMessage === "string" ? message.errorMessage : "model error",
      );
    } else if (message.stopReason === "aborted") {
      tracker.runFailed("interrupted", "aborted");
    }
  }

  private resetRetryBudget(): void {
    this.retryStartedAt = undefined;
    this.retryAttempts = 0;
  }

  /**
   * The turn spent its retry budget: stop it instead of waiting out another attempt, say
   * why in the chat, and hand the queue the turn it was holding. Without this a provider
   * that keeps failing freezes every message sent behind it.
   */
  private async abandonRetryingTurn(spentMs: number): Promise<void> {
    if (this.abandoning || this.closed) return;
    this.abandoning = true;
    const attempts = this.retryAttempts;
    try {
      console.error(
        `[pi] giving up after ${attempts} retries in ${Math.round(spentMs / 1000)}s; stopping the turn`,
      );
      this.taskActivity?.runFailed("error", `the provider kept failing after ${attempts} retries`);
      await this.conversation.abort(SESSION_CONTEXT);
      this.hub.broadcast({
        event: "notice",
        data: {
          message: {
            id: `m-retry-${Date.now()}`,
            role: "system",
            text: retryGiveUpMessage(attempts, spentMs),
            isError: true,
            timestamp: new Date().toISOString(),
            order: 0,
          } satisfies ChatMessage,
        },
      });
      this.resetRetryBudget();
      this.setRunState("idle");
      await this.startOldestQueued();
    } catch (error) {
      console.error("[pi] could not stop the retrying turn", error);
    } finally {
      this.abandoning = false;
    }
  }

  /** Runs the oldest queued message once the turn that held it is gone. */
  private async startOldestQueued(): Promise<void> {
    const first = this.queued.entries().next();
    if (first.done === true) return;
    const [id, queued] = first.value;
    const settled = await queued.submission.status(SESSION_CONTEXT).catch(() => undefined);
    this.queued.delete(id);
    await this.persistMarkerState();
    this.broadcastQueue();
    if (settled?.status === "placed" || settled?.status === "done") return;
    try {
      await this.submit(queued.item.text, "queue", {
        ...(queued.item.attachments === undefined ? {} : { attachments: queued.item.attachments }),
      });
    } catch (error) {
      console.error("[pi] could not start the next queued message", error);
    }
  }
}
