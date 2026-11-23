import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  type Conversation,
  type ConversationId,
  defineEntry,
  type EntryRecord,
  type Harness,
  Harness as HarnessImpl,
  LiveDoc,
  type ModelRef,
  type Registry,
  ResetEntry,
  ToolResultEntry,
  type UsageState,
  UserEntry,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { diagramPartFromDetails, parseDiagramDetails } from "../shared/diagrams.js";
import { loopGuardText } from "../shared/loop-guard.js";
import { parseMemoryToolDetails } from "../shared/memory.js";
import {
  isMcpEventEcho,
  type MemoryDeltaDetails,
  type MemoryDeltaTopic,
  type MemoryNoticeDetails,
  memoryDeltaSummary,
  memoryNoticeSummary,
  memoryNoticeText,
  type OperatorNoticeDetails,
  type OperatorNoticeRecord,
  operatorNoticeSummary,
  parseNotice,
  type QuestionNoticeDetails,
  type TaskDecisionNoticeDetails,
  type TaskDecisionNoticeRecord,
  taskDecisionPrompt,
  taskDecisionSummary,
} from "../shared/notices.js";
import { entryQueueKeyFromData, QUEUE_ENTRY_KIND, queueKeyFromEntryData } from "../shared/queue.js";
import { steerKeyFromEntryData } from "../shared/steers.js";
import { toIsoTimestamp } from "../shared/time.js";
import {
  type ActivityItem,
  type AnsweredQuestionItem,
  type ChatMessage,
  type ContextUsage,
  type MediaRef,
  STEER_ENTRY_KIND,
  type TokenSpend,
  type ToolActivity,
  type UsageSummary,
} from "../shared/types.js";
import { createAppRegistry } from "./app-registry.js";
import type { BillionContextInline } from "./billion-context.js";
import type { DashboardManager } from "./dashboard.js";
import type { DelegateManager } from "./delegates.js";
import type { DiagramBridge } from "./diagram-tools.js";
import { type DurableDoctorReport, durableDoctor, durableRepairNotice } from "./durable-doctor.js";
import type { JobManager } from "./jobs.js";
import type { McpRuntime } from "./mcp-runtime.js";
import type { SnapshotCache } from "./memory/snapshot.js";
import type { MemoryStore } from "./memory/store.js";
import type { MemoryWriteRecord } from "./memory/tools.js";
import type { OperatorBridge } from "./operator-tools.js";
import { formatToolArguments, formatToolDetails, formatToolResult } from "./pi.js";
import { retrySettings } from "./retry.js";
import { type RunMarker, RunMarkerStore } from "./run-marker.js";
import { TaskQuestionAnswerEntry } from "./task-questions.js";
import type { TaskBridge } from "./task-tools.js";
import { pendingVersionNotice, writeLastSeenVersion } from "./version-notice.js";

export const SESSION_CONTEXT: Context = BACKGROUND_CONTEXT;

/**
 * Durable compaction is off until the chat has a head, or the log is still small.
 * `ChatService.start` flips this once that is true. The settings function reads it
 * on each turn, so a harness opened at boot follows the later decision.
 */
let modelCompactionEnabled = false;

/** Allow threshold compaction. A large headless log must not be summarized in one call. */
export function enableModelCompaction(): void {
  modelCompactionEnabled = true;
}

const InterruptedRunEntry = defineEntry<{
  markerKey: string;
  partialEntryId: number | null;
  note: string;
  stopped: boolean;
  createdAt: string;
}>("ui.run-interrupted");

/** A version change seen at start. `model` carries the notice so the agent reads it in context. */
const VersionUpdateEntry = defineEntry<{
  from: string | null;
  to: string;
  note: string;
  /** The changelog sections the model was told about, so the chat can show them on demand. */
  changes?: string;
  createdAt: string;
}>("ui.version-update");

/**
 * A background job result: a chip in the chat and a row on the activity page. The
 * agent-visible result is placed as this entry through an input, so its model message is
 * unchanged; a cancelled or `notify: false` result has no `model` part and is a chip and
 * an activity row only.
 */
const JobNoticeEntry = defineEntry<{
  text: string;
  createdAt: string;
  /** The queued input's key, so the pending and placed chips share one message id. */
  queueKey?: string;
}>("ui.job-notice");

/** The entry kind a job result is placed as; the chat never renders it as a user message. */
export const JOB_NOTICE_ENTRY_KIND = JobNoticeEntry.kind;

/**
 * A finished sub-agent run. Like a job result it carries a model message, so the
 * agent can read the result next turn, but the chat renders it as a notice chip.
 */
const DelegateNoticeEntry = defineEntry<{
  text: string;
  createdAt: string;
}>("ui.delegate-notice");

export const DELEGATE_NOTICE_ENTRY_KIND = DelegateNoticeEntry.kind;

/**
 * An MCP event notice. The first entry of a key carries the model message that
 * starts the turn; later entries for the same key only update its text and time.
 * `buildTranscript` keeps one visible message per key.
 */
const McpNoticeEntry = defineEntry<{
  noticeId: string;
  key: string;
  text: string;
  at: string;
  createdAt: string;
}>("ui.mcp-notice");

export const MCP_NOTICE_ENTRY_KIND = McpNoticeEntry.kind;

/** A memory_write result. It carries no model message, so it never starts or joins a turn. */
const MemoryWriteEntry = defineEntry<{
  path: string;
  text: string;
  truncated: boolean;
  createdAt: string;
}>("ui.memory-write");

export const MEMORY_WRITE_ENTRY_KIND = MemoryWriteEntry.kind;

/**
 * Legacy compact tail notice for long-term topic writes. It carried a model
 * message in older transcripts; new writes only show the per-write memory chip.
 */
// legacy: read-only, existing transcripts only
const MemoryDeltaEntry = defineEntry<{
  text: string;
  topics: Array<{ path: string; title: string; chars: number; updated: string }>;
  createdAt: string;
}>("ui.memory-delta");

export const MEMORY_DELTA_ENTRY_KIND = MemoryDeltaEntry.kind;

/**
 * The task's attached images. It carries the model message so the plan agent sees
 * the screenshots before its first response, but no transcript row: `buildTranscript`
 * ignores kinds it does not render, so the operator never gets a fake bubble.
 */
const TaskAttachmentsEntry = defineEntry<{
  taskId: string;
  ids: string[];
  createdAt: string;
}>("ui.task-attachments");

export const TASK_ATTACHMENTS_ENTRY_KIND = TaskAttachmentsEntry.kind;

/**
 * The automated idle prompt. It carries a model message so it starts a turn, but
 * the chat renders it as a notice chip rather than a user bubble.
 */
const IdleNudgeEntry = defineEntry<{
  text: string;
  taskIds: string[];
  createdAt: string;
}>("ui.idle-nudge");

export const IDLE_NUDGE_ENTRY_KIND = IdleNudgeEntry.kind;

/**
 * A human's decision on a proposal. It carries the model prompt, so the agent
 * learns the decision before its next response, and renders as a notice chip.
 */
const TaskDecisionEntry = defineEntry<{
  proposalId: string;
  taskId: string;
  taskTitle: string;
  decision: "approved" | "declined";
  text: string;
  createdAt: string;
}>("ui.task-decision");

export const TASK_DECISION_ENTRY_KIND = TaskDecisionEntry.kind;

/**
 * The model-facing half of a proposal decision. The visible notice is appended
 * immediately as a display-only write; this entry carries the prompt, so a busy
 * conversation reads the decision at its next boundary without showing it twice.
 */
const TaskDecisionPromptEntry = defineEntry<{
  proposalId: string;
  taskId: string;
  taskTitle: string;
  decision: "approved" | "declined";
  text: string;
  createdAt: string;
}>("ui.task-decision-prompt");

export const TASK_DECISION_PROMPT_ENTRY_KIND = TaskDecisionPromptEntry.kind;

/**
 * The operator's answer to a plan-agent question set. It carries the model prompt, so an
 * idle agent starts a run and a busy one reads it at its next boundary, and renders as a
 * notice chip with the answers in its dialog.
 */
export type TaskQuestionPromptAnswer = {
  id: string;
  prompt: string;
  kind: "single" | "multi" | "text";
  values: string[];
  labels: string[];
  text: string;
};

export type TaskQuestionPromptData = {
  setId: string;
  taskId: string;
  text: string;
  answers: TaskQuestionPromptAnswer[];
  createdAt: string;
  dismissed?: boolean;
};

export const TaskQuestionPromptEntry =
  defineEntry<TaskQuestionPromptData>("ui.task-question-prompt");

export const TASK_QUESTION_PROMPT_ENTRY_KIND = TaskQuestionPromptEntry.kind;

/** A notify_operator call. It carries no model message and shows as a chat chip. */
const OperatorNoticeEntry = defineEntry<{
  title: string;
  body: string;
  reason: string;
  createdAt: string;
}>("ui.operator-notice");

export const OPERATOR_NOTICE_ENTRY_KIND = OperatorNoticeEntry.kind;

/** A repaired durable document, shown once in the transcript rather than as a per-request error. */
const DurableRepairEntry = defineEntry<{
  text: string;
  kind: string;
  baseRevision: number;
  droppedToolCalls: number;
  createdAt: string;
}>("ui.durable-repair");

/**
 * The time a plain `pi.reset` was applied. durable's reset entry carries no data, so this
 * companion write follows it and lets a snapshot reconcile a client that missed the frame.
 */
const SessionResetMarkerEntry = defineEntry<{ resetAt: string }>("ui.session-reset");

export const SESSION_RESET_MARKER_ENTRY_KIND = SessionResetMarkerEntry.kind;
export const SESSION_RESET_TEXT = "Session context reset";

export interface DurableSessionOptions {
  readonly cwd: string;
  readonly models: Parameters<typeof HarnessImpl.open>[1]["models"];
  readonly instructions: string;
  readonly model: ModelRef | undefined;
  /** When a resumed conversation already stores a model, keep it if this returns true. */
  readonly keepStoredModel?: (model: ModelRef) => boolean;
  readonly bili?: BillionContextInline;
  readonly tasks: TaskBridge;
  readonly jobs?: JobManager;
  readonly delegates?: DelegateManager;
  readonly dashboard?: DashboardManager;
  readonly memory?: {
    readonly store: MemoryStore;
    readonly snapshot?: SnapshotCache;
    readonly onWrite?: (record: MemoryWriteRecord) => void | Promise<void>;
  };
  /** Diagrams the agent draws into the chat. */
  readonly diagrams?: DiagramBridge;
  /** The explicit notify_operator path: web push plus its chat chip. */
  readonly operator?: OperatorBridge;
  /** Targets the `reload` tool can rebuild in this session. */
  readonly reload?: {
    readonly prompt?: () => Promise<{ readonly instructions: string; readonly changed: boolean }>;
    readonly models?: () => Promise<import("./models.js").ModelCatalogReload>;
  };
}

export interface DurableSessionBoot {
  readonly harness: Harness;
  readonly conversation: Conversation;
  readonly dataDir: string;
  readonly databasePath: string;
  readonly currentPath: string;
  readonly resumed: boolean;
  readonly interrupted: boolean;
  readonly runMarker: RunMarker | undefined;
  readonly runMarkerStore: RunMarkerStore;
  readonly mcp: McpRuntime;
  readonly biliTools: readonly string[];
  readonly taskTools: readonly string[];
  readonly jobTools: readonly string[];
  readonly delegateTools: readonly string[];
  readonly dashboardTools: readonly string[];
  readonly memoryTools: readonly string[];
  readonly diagramTools: readonly string[];
  readonly operatorTools: readonly string[];
  readonly reloadTools: readonly string[];
  /** Model stored on the conversation after boot. A menu choice wins over `PI_MODEL`. */
  readonly model: ModelRef | undefined;
  /** pi-ui's own version from package.json. */
  readonly version: string;
  /** Re-run the durable doctor against this boot's store (used before a view is resumed). */
  readonly repairDurableState: () => Promise<DurableDoctorReport>;
}

export async function openDurableSession(
  options: DurableSessionOptions,
): Promise<DurableSessionBoot> {
  const dataDir = resolve(options.cwd, process.env.DATA_DIR?.trim() || "data");
  const databasePath = join(dataDir, "pi.sqlite3");
  const currentPath = join(dataDir, "current.json");
  await mkdir(dataDir, { recursive: true });

  // Repair a torn materialised view before the harness reads it. This is best-effort: a busy or
  // locked store must not make the server unbootable; ChatService's watch rescue retries later.
  const repairDurableState = () => durableDoctor({ databasePath, repair: true });
  let durableReport: DurableDoctorReport | undefined;
  try {
    durableReport = await repairDurableState();
    if (durableReport.repaired) {
      console.warn(`[durable] ${durableReport.lines.join("; ")}`);
    }
  } catch (error) {
    console.error("[durable] boot doctor failed; continuing", error);
  }

  const storage = await openNodeSqliteStorage(databasePath);
  let conversation: Conversation | undefined;
  const reload =
    options.reload === undefined
      ? undefined
      : {
          ...(options.reload.models === undefined ? {} : { models: options.reload.models }),
          ...(options.reload.prompt === undefined
            ? {}
            : {
                prompt: async () => {
                  if (conversation === undefined) {
                    throw new Error("the chat session is not ready");
                  }
                  const result = await options.reload?.prompt?.();
                  if (result === undefined) throw new Error("reload prompt is not available");
                  await conversation.configure(
                    { instructions: result.instructions },
                    SESSION_CONTEXT,
                  );
                  return result;
                },
              }),
        };
  const {
    registry,
    mcp,
    biliTools,
    taskTools,
    jobTools,
    delegateTools,
    dashboardTools,
    memoryTools,
    diagramTools,
    operatorTools,
    reloadTools,
  } = await createAppRegistry({
    dataDir,
    bili: options.bili,
    tasks: options.tasks,
    ...(options.jobs === undefined ? {} : { jobs: options.jobs }),
    ...(options.delegates === undefined ? {} : { delegates: options.delegates }),
    ...(options.dashboard === undefined ? {} : { dashboard: options.dashboard }),
    ...(options.memory === undefined ? {} : { memory: options.memory }),
    ...(options.diagrams === undefined ? {} : { diagrams: options.diagrams }),
    ...(options.operator === undefined ? {} : { operator: options.operator }),
    ...(reload === undefined ? {} : { reload }),
  });

  const harness = await HarnessImpl.open(
    storage,
    {
      models: options.models,
      registry: registry as Registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? options.cwd }),
      // Read on each turn. Compaction stays off until a head exists, so the first
      // turn cannot summarize the whole month. After the head, compaction keeps
      // the model on a tail. Billion-context gets a new conversation id at each head.
      settings: () => ({
        compaction: {
          enabled: modelCompactionEnabled,
          reserveTokens: 16_384,
          keepRecentTokens: 20_000,
          backgroundTokens: 0,
        },
        // Three attempts in all, a short backoff and a cap, instead of durable's default
        // three retries with a minute-long ceiling: a failing provider must not hold the
        // chat, and everything sent behind the turn waits with it.
        retry: retrySettings(),
        // Every steer waiting at a turn boundary goes in at that boundary, in the order sent,
        // instead of one per boundary, which pushed later steers past the run's end.
        steeringMode: "all",
      }),
      onReport: (report) => console.error(`[pi] harness report (${report.kind})`, report.error),
    },
    SESSION_CONTEXT,
  );

  const loaded = await loadConversation(harness, currentPath, {
    cwd: options.cwd,
    instructions: options.instructions,
    ...(options.model === undefined ? {} : { model: options.model }),
  });
  conversation = loaded.conversation;
  const resumed = loaded.resumed;
  let model = options.model;
  if (resumed) {
    const stored = (await conversation.agent(SESSION_CONTEXT)).model;
    if (
      stored !== undefined &&
      (options.keepStoredModel === undefined || options.keepStoredModel(stored))
    ) {
      model = stored;
    }
  }
  await conversation.configure(
    {
      cwd: options.cwd,
      instructions: options.instructions,
      ...(model === undefined ? {} : { model }),
    },
    SESSION_CONTEXT,
  );

  const runMarkerStore = new RunMarkerStore(dataDir);
  const storedMarker = await runMarkerStore.read();
  const recovery = await recoverInterruptedRun(
    harness,
    conversation,
    storedMarker?.stopRequested === true,
  );
  let runMarker = storedMarker;
  if (runMarker !== undefined && runMarker.partialEntryId === null) {
    const context = await conversation.context(SESSION_CONTEXT);
    const partialEntryId =
      interruptedAssistantEntryId(context.entries, runMarker) ??
      (recovery.partial === undefined
        ? null
        : await appendCapturedPartial(conversation, recovery.partial));
    runMarker = {
      ...runMarker,
      partialEntryId,
      updatedAt: new Date().toISOString(),
    };
    await runMarkerStore.write(runMarker);
  }
  if (runMarker !== undefined) {
    await appendInterruptionNote(conversation, runMarker);
  }
  const version = await recordVersion(conversation, dataDir, resumed);
  if (durableReport !== undefined) await recordDurableRepairNotice(conversation, durableReport);

  return {
    harness,
    conversation,
    dataDir,
    databasePath,
    currentPath,
    resumed,
    interrupted: recovery.recovered || runMarker !== undefined,
    runMarker,
    runMarkerStore,
    mcp,
    biliTools,
    taskTools,
    jobTools,
    delegateTools,
    dashboardTools,
    memoryTools,
    diagramTools,
    operatorTools,
    reloadTools,
    model,
    version,
    repairDurableState,
  };
}

/** Put one system line in the chat for a repair that happened at boot. */
export async function recordDurableRepairNotice(
  conversation: Conversation,
  report: DurableDoctorReport,
): Promise<void> {
  const text = durableRepairNotice(report, conversation.id);
  if (text === undefined) return;
  const repairedFor = (kind: string) =>
    report.documents.find(
      (document) =>
        document.repaired && document.kind === kind && document.conversationId === conversation.id,
    );
  const repaired = repairedFor("pi.live") ?? repairedFor("pi.agent") ?? repairedFor("pi.inbox");
  if (repaired === undefined) return;
  try {
    const context = await conversation.context(SESSION_CONTEXT);
    const already = context.entries.some(
      (entry) =>
        entry.kind === DurableRepairEntry.kind &&
        isRecord(entry.data) &&
        entry.data.text === text &&
        entry.data.baseRevision === repaired.baseRevision,
    );
    if (already) return;
    await conversation.commit(
      (tx) =>
        tx.appendEntry(DurableRepairEntry, conversation.id, {
          data: {
            text,
            kind: repaired.kind,
            baseRevision: repaired.baseRevision,
            droppedToolCalls: repaired.residueDropped.length,
            createdAt: new Date().toISOString(),
          },
        }),
      SESSION_CONTEXT,
    );
    console.log(`[durable] ${text}`);
  } catch (error) {
    console.error("[durable] could not record the repair notice", error);
  }
}

/**
 * Compares the running version with the last one this data directory saw. After an update the
 * agent gets the new changelog sections as a context message, then the new version is recorded.
 */
async function recordVersion(
  conversation: Conversation,
  dataDir: string,
  resumed: boolean,
): Promise<string> {
  const { notice, version } = await pendingVersionNotice({ dataDir, resumed });
  if (notice !== undefined) {
    try {
      const context = await conversation.context(SESSION_CONTEXT);
      const already = context.entries.some(
        (entry) =>
          entry.kind === VersionUpdateEntry.kind &&
          isRecord(entry.data) &&
          entry.data.to === notice.to &&
          entry.data.from === (notice.from ?? null),
      );
      if (!already) {
        await conversation.commit(
          (tx) =>
            tx.appendEntry(VersionUpdateEntry, conversation.id, {
              model: [
                {
                  role: "user",
                  content: [{ type: "text", text: notice.prompt }],
                  timestamp: Date.now(),
                },
              ],
              data: {
                from: notice.from ?? null,
                to: notice.to,
                note: notice.note,
                changes: notice.changes,
                createdAt: new Date().toISOString(),
              },
            }),
          SESSION_CONTEXT,
        );
      }
      console.log(`[pi] ${notice.note}`);
    } catch (error) {
      console.error("[pi] could not record the version update", error);
      return version;
    }
  }
  try {
    await writeLastSeenVersion(dataDir, version);
  } catch (error) {
    console.error("[pi] could not record the running version", error);
  }
  return version;
}

async function loadConversation(
  harness: Harness,
  currentPath: string,
  agent: {
    cwd: string;
    instructions: string;
    model?: ModelRef;
  },
): Promise<{ conversation: Conversation; resumed: boolean }> {
  const savedId = await readCurrentConversationId(currentPath);
  if (savedId !== undefined) {
    const existing = await harness.conversation(savedId, SESSION_CONTEXT);
    if (existing) return { conversation: existing, resumed: true };
    console.warn(
      `[pi] ${currentPath} points at conversation ${savedId}, but durable storage no longer has it; creating a new conversation`,
    );
  }

  const conversation = await harness.createConversation(
    { ownership: { kind: "ownerless" }, agent },
    SESSION_CONTEXT,
  );
  await writeCurrentConversationId(currentPath, conversation.id);
  return { conversation, resumed: false };
}

async function readCurrentConversationId(currentPath: string): Promise<ConversationId | undefined> {
  let contents: string;
  try {
    contents = await readFile(currentPath, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return undefined;
    throw error;
  }

  try {
    const value: unknown = JSON.parse(contents);
    if (
      isRecord(value) &&
      typeof value.conversationId === "number" &&
      Number.isSafeInteger(value.conversationId) &&
      value.conversationId > 0
    ) {
      return value.conversationId as ConversationId;
    }
  } catch {
    // Fall through and replace a malformed file with a valid one.
  }
  console.warn(`[pi] ignoring malformed ${currentPath}; creating a new conversation`);
  return undefined;
}

async function writeCurrentConversationId(
  currentPath: string,
  conversationId: ConversationId,
): Promise<void> {
  const temporary = `${currentPath}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify({ conversationId })}\n`, "utf8");
  await rename(temporary, currentPath);
}

/**
 * A process that died mid-turn reopens with live durable work. pi-durable owns
 * recovering that work from its last checkpoint, so leave it pending. A stop
 * requested before the restart is the exception: settle it once and keep the
 * partial answer instead of replaying the request.
 */
async function recoverInterruptedRun(
  harness: Harness,
  conversation: Conversation,
  stopRequested: boolean,
): Promise<{ recovered: boolean; partial: AssistantMessage | undefined }> {
  const inspection = await harness.inspect(SESSION_CONTEXT);
  const unfinished =
    inspection.tasks.length > 0 ||
    inspection.submissions.some(
      (submission) => submission.status === "queued" || submission.status === "placed",
    );
  if (!unfinished) return { recovered: false, partial: undefined };

  if (!stopRequested) {
    console.warn(
      `[pi] conversation ${conversation.id} has unfinished work from the previous process; resuming it with pi-durable`,
    );
    return { recovered: true, partial: undefined };
  }

  const live = await harness.snapshot(LiveDoc, conversation.id, SESSION_CONTEXT);
  const captured = live?.generation?.message;
  console.warn(
    `[pi] conversation ${conversation.id} has unfinished work from the previous process; its stop was requested, settling it`,
  );
  try {
    await conversation.abort(SESSION_CONTEXT);
  } catch (error) {
    console.error("[pi] could not abort the interrupted run", error);
  }
  return {
    recovered: true,
    partial: captured === undefined ? undefined : (captured as unknown as AssistantMessage),
  };
}

async function appendCapturedPartial(
  conversation: Conversation,
  message: AssistantMessage,
): Promise<number | null> {
  const record = asRecord(message);
  const hasText = extractText(record.content).trim().length > 0;
  const hasThinking = contentBlocks(record.content).some(
    (block) =>
      block.type === "thinking" &&
      typeof block.thinking === "string" &&
      block.thinking.trim().length > 0,
  );
  if (!hasText && !hasThinking) return null;

  const partial = { ...record, stopReason: "aborted" } as unknown as AssistantMessage;
  const entry = await conversation.commit(
    (tx) => tx.appendEntry(AssistantEntry, conversation.id, { model: [partial] }),
    SESSION_CONTEXT,
  );
  return entry.id;
}

/**
 * The assistant entry the interrupted run produced. A marker can outlive the
 * turn, so restrict the lookup to entries after the user message that started
 * the marked run: the previous completed answer must never be labelled partial
 * when the new turn died before committing an answer of its own.
 */
function interruptedAssistantEntryId(
  entries: readonly EntryRecord[],
  marker: RunMarker,
): number | null {
  const startedAt = Date.parse(marker.startedAt);
  const hasStartedAt = Number.isFinite(startedAt);
  const markerText = marker.userMessage.trim();
  let boundary: number | null = null;

  for (const entry of entries) {
    if (
      entry.kind !== UserEntry.kind &&
      entry.kind !== STEER_ENTRY_KIND &&
      entry.kind !== QUEUE_ENTRY_KIND
    ) {
      continue;
    }
    const message = asRecord(entry.model?.[0]);
    if (extractText(message.content).trim() !== markerText) continue;
    if (hasStartedAt && !messageAtOrAfter(message, startedAt)) continue;
    if (boundary === null || entry.id > boundary) boundary = entry.id;
  }

  let id: number | null = null;
  for (const entry of entries) {
    if (!AssistantEntry.is(entry)) continue;
    if (boundary !== null) {
      if (entry.id <= boundary) continue;
    } else {
      const message = asRecord(entry.model?.[0]);
      if (!hasStartedAt || !messageAfter(message, startedAt)) continue;
    }
    id = entry.id;
  }
  return id;
}

function messageAtOrAfter(message: Record<string, unknown>, startedAt: number): boolean {
  return typeof message.timestamp === "number" && message.timestamp >= startedAt;
}

function messageAfter(message: Record<string, unknown>, startedAt: number): boolean {
  return typeof message.timestamp === "number" && message.timestamp > startedAt;
}

/** The note stored for a partial run that boot is resuming. */
export const INTERRUPTED_RUN_RESTART_NOTE = "The previous run was interrupted by a server restart";

export async function appendInterruptionNote(
  conversation: Conversation,
  marker: RunMarker,
): Promise<void> {
  const context = await conversation.context(SESSION_CONTEXT);
  const alreadyRecorded = context.entries.some((entry) => {
    if (entry.kind !== InterruptedRunEntry.kind || !isRecord(entry.data)) return false;
    return entry.data.markerKey === marker.idempotencyKey;
  });
  if (alreadyRecorded) return;

  // A run that left no reply and was not stopped has nothing to report. A partial
  // run that was not stopped gets a note, because boot recovers that run, and may
  // end it interrupted when the in-flight request left no retry.
  const note = marker.stopRequested
    ? "The previous run was stopped before the server restarted. The last response may be partial."
    : marker.partialEntryId !== null
      ? INTERRUPTED_RUN_RESTART_NOTE
      : null;
  if (note === null) return;

  try {
    await conversation.commit(
      (tx) =>
        tx.appendEntry(InterruptedRunEntry, conversation.id, {
          data: {
            markerKey: marker.idempotencyKey,
            partialEntryId: marker.partialEntryId,
            note,
            stopped: marker.stopRequested,
            createdAt: new Date().toISOString(),
          },
        }),
      SESSION_CONTEXT,
    );
  } catch (error) {
    console.error("[pi] could not record the interrupted-run note", error);
  }
}

/** The newest durable reset and its companion timestamp, if this transcript has one. */
export function latestSessionReset(
  entries: readonly EntryRecord[],
): { entry: EntryRecord; order: number; resetAt: string | undefined } | undefined {
  const sorted = [...entries].sort((a, b) => a.id - b.id);
  let reset: EntryRecord | undefined;
  for (const entry of sorted) {
    if (ResetEntry.is(entry)) reset = entry;
  }
  if (reset === undefined) return undefined;

  let resetAt: string | undefined;
  for (const entry of sorted) {
    if (entry.id <= reset.id || entry.kind !== SESSION_RESET_MARKER_ENTRY_KIND) continue;
    if (!isRecord(entry.data) || typeof entry.data.resetAt !== "string") continue;
    if (!Number.isFinite(Date.parse(entry.data.resetAt))) continue;
    resetAt = entry.data.resetAt;
  }
  if (resetAt === undefined) {
    const message = asRecord(reset.model?.[0]);
    const timestamp = message.timestamp;
    const parsed =
      typeof timestamp === "number"
        ? timestamp
        : typeof timestamp === "string"
          ? Date.parse(timestamp)
          : Number.NaN;
    if (Number.isFinite(parsed)) resetAt = new Date(parsed).toISOString();
  }
  if (resetAt === undefined && isRecord(reset.data) && typeof reset.data.resetAt === "string") {
    resetAt = reset.data.resetAt;
  }
  return { entry: reset, order: reset.id * 10_000, resetAt };
}

/** Record when a reset was applied, in an entry that never renders as a chat row. */
export async function appendSessionResetMarker(
  conversation: Conversation,
  resetAt: string,
): Promise<void> {
  await conversation.submit(
    {
      type: "write",
      entry: { kind: SESSION_RESET_MARKER_ENTRY_KIND, data: { resetAt } },
    },
    SESSION_CONTEXT,
  );
}

/** Maps an image block in a user entry to its served media id. */
export type MediaResolver = (data: string, mimeType: string) => MediaRef | undefined;

/** Reads a diagram's current revision, so a replaced drawing updates without a new entry. */
export type DiagramRevisionResolver = (id: string) => number | undefined;

/** What a transcript holds: both lists in display order. */
export interface BuiltTranscript {
  messages: ChatMessage[];
  activity: ActivityItem[];
}

/** Where a diaried drawing sits, so a replace can update its row instead of adding one. */
interface DiagramSlot {
  message: ChatMessage;
  diagramId: string;
  revision: number;
}

/** Reads the answer rows a question entry stored, skipping malformed items. */
function readAnsweredItems(value: unknown): AnsweredQuestionItem[] {
  if (!Array.isArray(value)) return [];
  const answers: AnsweredQuestionItem[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const answerKind = item.kind;
    if (
      typeof item.id !== "string" ||
      typeof item.prompt !== "string" ||
      (answerKind !== "single" && answerKind !== "multi" && answerKind !== "text") ||
      !Array.isArray(item.values) ||
      !item.values.every((value) => typeof value === "string") ||
      !Array.isArray(item.labels) ||
      !item.labels.every((label) => typeof label === "string") ||
      typeof item.text !== "string"
    ) {
      continue;
    }
    answers.push({
      id: item.id,
      prompt: item.prompt,
      kind: answerKind,
      values: item.values as string[],
      labels: item.labels as string[],
      text: item.text,
    });
  }
  return answers;
}

/**
 * Builds the chat transcript one entry at a time, in ascending entry id.
 *
 * `buildTranscript()` is this over a whole list. Keeping one builder alive for a
 * conversation turns the `/api/state` poll into an append of the few entries that
 * arrived since the last poll instead of a rebuild of every entry in the
 * conversation, which is the difference between milliseconds and seconds once a
 * conversation has tens of thousands of entries.
 */
export class TranscriptBuilder {
  private readonly messages: ChatMessage[] = [];
  private readonly activity: ActivityItem[] = [];
  private readonly toolCalls = new Map<string, { name: string; arguments: unknown }>();
  private readonly pendingToolSpend = new Map<string, TokenSpend>();
  private readonly partialEntryIds = new Set<number>();
  private readonly noticeQueueKeys = new Set<string>();
  private readonly mcpNotices = new Map<
    string,
    { first: EntryRecord; latest: EntryRecord; message?: ChatMessage }
  >();
  private readonly diagramSlots: DiagramSlot[] = [];
  private latestMcpNoticeText: string | null = null;
  private resetEntry: EntryRecord | undefined;
  private resetAt: string | undefined;
  private resetMessage: ChatMessage | undefined;

  constructor(
    private readonly media?: MediaResolver,
    private readonly diagramRevision?: DiagramRevisionResolver,
  ) {}

  /**
   * Appends the next entry. Entries must arrive in ascending id order: a later
   * entry may update a row this builder already emitted, but never reorder it.
   */
  append(entry: EntryRecord): void {
    const kind = entry.kind;

    // A reset marker never renders; it only records when the reset was applied.
    if (kind === SESSION_RESET_MARKER_ENTRY_KIND) {
      this.noteResetMarker(entry);
      return;
    }
    // Effects a later entry has on a row that is already in the transcript. The
    // full-list version learned these in a pre-pass; here they arrive in order.
    if (kind === InterruptedRunEntry.kind) this.notePartialEntry(entry);
    if (kind === TASK_DECISION_ENTRY_KIND) this.noteDecisionQueueKeys(entry);
    if (kind === McpNoticeEntry.kind) this.noteMcpNotice(entry);

    if (kind === ResetEntry.kind) {
      // A reset starts the active context at itself. Everything before it is history
      // that this transcript no longer shows, so the builder starts over.
      this.clear();
      this.resetEntry = entry;
      this.resetAt = resetTimestampOf(entry);
      const message: ChatMessage = {
        id: entryMessageId(entry),
        role: "system",
        kind: "session-reset",
        text: SESSION_RESET_TEXT,
        timestamp: this.resetAt ?? new Date().toISOString(),
        order: entry.id * 10_000,
      };
      this.resetMessage = message;
      this.emit(message);
      return;
    }
    if (kind === DelegateNoticeEntry.kind) {
      if (!isRecord(entry.data) || typeof entry.data.text !== "string") return;
      const notice = parseNotice(entry.data.text);
      if (notice === null || notice.kind !== "delegate") return;
      this.emit({
        id: `m-${entry.id}`,
        role: "system",
        text: entry.data.text,
        timestamp: entryTimestamp(entry.data),
        order: entry.id * 10_000,
        notice,
      });
      return;
    }
    if (kind === JobNoticeEntry.kind) {
      if (!isRecord(entry.data) || typeof entry.data.text !== "string") return;
      const notice = parseNotice(entry.data.text);
      if (notice === null || notice.kind !== "job") return;
      const timestamp = entryTimestamp(entry.data);
      const order = entry.id * 10_000;
      this.emit({
        id: entryMessageId(entry),
        role: "system",
        text: entry.data.text,
        timestamp,
        order,
        notice,
      });
      this.emitActivity({
        kind: "job",
        id: `j-${entry.id}`,
        notice,
        timestamp,
        order,
      });
      return;
    }
    if (kind === McpNoticeEntry.kind) {
      this.emitMcpNotice(entry);
      return;
    }
    if (kind === IdleNudgeEntry.kind) {
      if (!isRecord(entry.data) || typeof entry.data.text !== "string") return;
      const notice = parseNotice(entry.data.text);
      if (notice === null || notice.kind !== "idle") return;
      this.emit({
        id: entryMessageId(entry),
        role: "system",
        text: entry.data.text,
        timestamp: entryTimestamp(entry.data),
        order: entry.id * 10_000,
        notice,
      });
      return;
    }
    if (kind === TASK_QUESTION_PROMPT_ENTRY_KIND) {
      if (
        !isRecord(entry.data) ||
        typeof entry.data.setId !== "string" ||
        typeof entry.data.text !== "string" ||
        !Array.isArray(entry.data.answers)
      ) {
        return;
      }
      const answers = readAnsweredItems(entry.data.answers);
      const dismissed = entry.data.dismissed === true;
      const count = answers.length;
      const notice: QuestionNoticeDetails = {
        kind: "questions",
        setId: entry.data.setId,
        count,
        text: entry.data.text,
        summary: dismissed
          ? "Questions dismissed"
          : `Answers sent · ${count} question${count === 1 ? "" : "s"}`,
        answers,
        ...(dismissed ? { dismissed: true } : {}),
      };
      this.emit({
        id: entryMessageId(entry),
        role: "system",
        text: entry.data.text,
        timestamp: entryTimestamp(entry.data),
        order: entry.id * 10_000,
        notice,
      });
      return;
    }
    if (kind === TaskQuestionAnswerEntry.kind) {
      if (
        !isRecord(entry.data) ||
        typeof entry.data.setId !== "string" ||
        typeof entry.data.text !== "string" ||
        !Array.isArray(entry.data.answers)
      ) {
        return;
      }
      const answers = readAnsweredItems(entry.data.answers);
      const count = answers.length;
      const notice: QuestionNoticeDetails = {
        kind: "questions",
        setId: entry.data.setId,
        count,
        text: entry.data.text,
        summary: `Answers recorded · ${count} question${count === 1 ? "" : "s"}`,
        answers,
      };
      this.emit({
        id: entryMessageId(entry),
        role: "system",
        text: entry.data.text,
        timestamp: entryTimestamp(entry.data),
        order: entry.id * 10_000,
        notice,
      });
      return;
    }
    if (kind === TaskDecisionEntry.kind) {
      if (
        !isRecord(entry.data) ||
        typeof entry.data.text !== "string" ||
        typeof entry.data.proposalId !== "string" ||
        typeof entry.data.taskId !== "string" ||
        typeof entry.data.taskTitle !== "string" ||
        (entry.data.decision !== "approved" && entry.data.decision !== "declined")
      ) {
        return;
      }
      const proposalId = entry.data.proposalId;
      const taskId = entry.data.taskId;
      const taskTitle = entry.data.taskTitle;
      const decision = entry.data.decision;
      const title = decision === "approved" ? "Proposal approved" : "Proposal declined";
      const notice: TaskDecisionNoticeDetails = {
        kind: "decision",
        proposalId,
        taskId,
        taskTitle,
        decision,
        title,
        body: `${title}: ${taskTitle}`,
        reason: "A human made this decision on the tasks page.",
        text: entry.data.text,
        summary: taskDecisionSummary({ proposalId, taskId, taskTitle, decision }),
      };
      this.emit({
        id: entryMessageId(entry),
        role: "system",
        text: entry.data.text,
        timestamp: entryTimestamp(entry.data),
        order: entry.id * 10_000,
        notice,
      });
      return;
    }
    if (kind === InterruptedRunEntry.kind) {
      if (!isRecord(entry.data) || typeof entry.data.note !== "string") return;
      const note = entry.data.note;
      this.emit({
        id: `m-${entry.id}`,
        role: "system",
        text: note,
        timestamp: entryTimestamp(entry.data),
        order: entry.id * 10_000,
        notice: {
          kind: "interrupted",
          note,
          // Older entries predate the flag; their wording still says which case it was.
          stopped:
            typeof entry.data.stopped === "boolean"
              ? entry.data.stopped
              : note.startsWith("The previous run was stopped"),
        },
      });
      return;
    }
    if (kind === DurableRepairEntry.kind) {
      if (!isRecord(entry.data) || typeof entry.data.text !== "string") return;
      this.emit({
        id: `m-${entry.id}`,
        role: "system",
        text: entry.data.text,
        timestamp: entryTimestamp(entry.data),
        order: entry.id * 10_000,
        repair: {
          baseRevision: typeof entry.data.baseRevision === "number" ? entry.data.baseRevision : 0,
        },
      });
      return;
    }
    if (kind === VersionUpdateEntry.kind) {
      if (!isRecord(entry.data) || typeof entry.data.note !== "string") return;
      this.emit({
        id: `m-${entry.id}`,
        role: "system",
        text: entry.data.note,
        timestamp: entryTimestamp(entry.data),
        order: entry.id * 10_000,
        version: {
          from: typeof entry.data.from === "string" ? entry.data.from : null,
          to: typeof entry.data.to === "string" ? entry.data.to : "",
          changes: typeof entry.data.changes === "string" ? entry.data.changes : "",
        },
      });
      return;
    }
    // legacy: read-only, existing transcripts only
    if (kind === MemoryDeltaEntry.kind) {
      if (!isRecord(entry.data) || typeof entry.data.text !== "string") return;
      const topics = Array.isArray(entry.data.topics)
        ? entry.data.topics.filter((topic): topic is MemoryDeltaTopic => {
            if (!isRecord(topic)) return false;
            return (
              typeof topic.path === "string" &&
              typeof topic.title === "string" &&
              typeof topic.chars === "number" &&
              typeof topic.updated === "string"
            );
          })
        : [];
      const notice: MemoryDeltaDetails = {
        kind: "memory-delta",
        topics,
        summary: memoryDeltaSummary(topics),
      };
      this.emit({
        id: `m-${entry.id}`,
        role: "system",
        text: entry.data.text,
        timestamp: entryTimestamp(entry.data),
        order: entry.id * 10_000,
        notice,
      });
      return;
    }
    if (kind === MemoryWriteEntry.kind) {
      if (!isRecord(entry.data) || typeof entry.data.path !== "string") return;
      if (typeof entry.data.text !== "string") return;
      const path = entry.data.path;
      const notice: MemoryNoticeDetails = {
        kind: "memory",
        path,
        text: entry.data.text,
        truncated: entry.data.truncated === true,
        summary: memoryNoticeSummary(path),
      };
      this.emit({
        id: `m-${entry.id}`,
        role: "system",
        text: notice.summary,
        timestamp: entryTimestamp(entry.data),
        order: entry.id * 10_000,
        notice,
      });
      return;
    }
    if (kind === OperatorNoticeEntry.kind) {
      if (!isRecord(entry.data)) return;
      if (
        typeof entry.data.title !== "string" ||
        typeof entry.data.body !== "string" ||
        typeof entry.data.reason !== "string"
      ) {
        return;
      }
      const notice: OperatorNoticeDetails = {
        kind: "operator",
        title: entry.data.title,
        body: entry.data.body,
        reason: entry.data.reason,
        summary: operatorNoticeSummary(entry.data.title),
      };
      this.emit({
        id: `m-${entry.id}`,
        role: "system",
        text: notice.summary,
        timestamp: entryTimestamp(entry.data),
        order: entry.id * 10_000,
        notice,
      });
      return;
    }
    if (
      kind !== UserEntry.kind &&
      kind !== STEER_ENTRY_KIND &&
      kind !== QUEUE_ENTRY_KIND &&
      kind !== AssistantEntry.kind &&
      kind !== ToolResultEntry.kind
    ) {
      return;
    }
    const message = asRecord(entry.model?.[0]);
    if (kind === UserEntry.kind || kind === STEER_ENTRY_KIND || kind === QUEUE_ENTRY_KIND) {
      const text = extractText(message.content);
      const attachments = this.media === undefined ? [] : userImages(message.content, this.media);
      const steerKey = kind === STEER_ENTRY_KIND ? steerKeyFromEntryData(entry.data) : undefined;
      const queueKey = kind === QUEUE_ENTRY_KIND ? queueKeyFromEntryData(entry.data) : undefined;
      if (queueKey !== undefined && this.noticeQueueKeys.has(queueKey)) return;
      if (text.length > 0 || attachments.length > 0) {
        const notice = parseNotice(text);
        if (notice?.kind === "mcp") this.latestMcpNoticeText = text;
        // Older conversations stored a job result as a normal user entry. Keep it out of the chat;
        // those entries predate the chip, so the activity row is their only surface.
        if (notice?.kind === "job") {
          this.emitActivity({
            kind: "job",
            id: `j-${entry.id}`,
            notice,
            timestamp: timestampOf(message),
            order: entry.id * 10_000,
          });
          return;
        }
        this.emit({
          id: queueKey === undefined ? `m-${entry.id}` : `m-${queueKey}`,
          role: "user",
          text,
          ...(attachments.length > 0 ? { attachments } : {}),
          timestamp: timestampOf(message),
          order: entry.id * 10_000,
          ...(kind === STEER_ENTRY_KIND ? { steer: true } : {}),
          ...(steerKey === undefined ? {} : { steerKey }),
          ...(notice === null ? {} : { notice }),
        });
      }
      return;
    }

    if (kind === AssistantEntry.kind) {
      const text = extractText(message.content);
      const errorText =
        typeof message.errorMessage === "string" && message.errorMessage.length > 0
          ? message.errorMessage
          : "";
      const spend = tokenSpend(message.usage);
      const blocks = contentBlocks(message.content);
      const thinkingBlocks = blocks.filter(
        (block) =>
          block.type === "thinking" &&
          typeof block.thinking === "string" &&
          block.thinking.trim().length > 0,
      );
      const toolCallIds = blocks
        .filter(
          (block): block is Record<string, unknown> & { id: string } =>
            block.type === "toolCall" && typeof block.id === "string",
        )
        .map((block) => block.id);
      for (const block of blocks) {
        if (block.type === "toolCall" && typeof block.id === "string") {
          this.toolCalls.set(block.id, {
            name: typeof block.name === "string" ? block.name : "tool",
            arguments: block.arguments,
          });
        }
      }
      const visible = text.length > 0 || errorText.length > 0;
      const shown = text.length > 0 ? text : loopGuardText(errorText);
      const echo = visible && isMcpEventEcho(shown, this.latestMcpNoticeText);
      if (visible && !echo) {
        this.emit({
          id: `m-${entry.id}`,
          role: "assistant",
          text: shown,
          timestamp: timestampOf(message),
          order: entry.id * 10_000 + 5_000,
          isError: errorText.length > 0,
          ...(this.partialEntryIds.has(entry.id) ? { partial: true } : {}),
          ...(spend !== undefined && thinkingBlocks.length === 0 && toolCallIds.length === 0
            ? { usage: spend }
            : {}),
        });
      }
      thinkingBlocks.forEach((block, index) => {
        const thinking = block.thinking;
        if (typeof thinking !== "string") return;
        this.emitActivity({
          kind: "thinking",
          id: `t-${entry.id}-${index}`,
          name: "thinking",
          text: thinking,
          timestamp: timestampOf(message),
          order: entry.id * 10_000 + 1 + index * 2,
          ...(index === 0 && spend !== undefined ? { usage: spend } : {}),
        });
      });
      const firstToolCall = toolCallIds[0];
      if (spend !== undefined && thinkingBlocks.length === 0 && firstToolCall !== undefined) {
        this.pendingToolSpend.set(firstToolCall, spend);
      }
      return;
    }

    // ToolResultEntry.
    const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
    const call = this.toolCalls.get(toolCallId);
    // A call is only needed until its result arrives, so later entries do not carry it.
    if (toolCallId.length > 0) this.toolCalls.delete(toolCallId);
    const tool = toolActivityFromEntry(entry, call?.arguments);
    if (tool) {
      const usage = this.pendingToolSpend.get(toolCallId);
      if (usage !== undefined) this.pendingToolSpend.delete(toolCallId);
      this.emitActivity(usage === undefined ? tool : { ...tool, usage });
    }
    // A drawing owns one message; a replace or edit only raises that message's revision, so
    // the transcript is not rewritten with another bubble for the same diagram.
    const diagram = parseDiagramDetails(message.details);
    const part = diagramPartFromDetails(message.details, this.diagramRevision);
    const revises = call?.name === "replace_diagram" || call?.name === "edit_diagram";
    if (diagram !== undefined && part !== undefined && !revises) {
      const drawn: ChatMessage = {
        id: `m-${entry.id}`,
        role: "assistant",
        text: diagram.title ?? "",
        timestamp: timestampOf(message),
        order: entry.id * 10_000 + 5_000,
        parts: [part],
      };
      this.diagramSlots.push({
        message: drawn,
        diagramId: part.diagram.id,
        revision: part.diagram.revision,
      });
      this.emit(drawn);
    }
  }

  /** The transcript as it stands. Both lists are in display order. */
  build(): BuiltTranscript {
    return { messages: this.messages, activity: this.activity };
  }

  /** How many rows this transcript holds, for the periodic memory line. */
  size(): { messages: number; activity: number } {
    return { messages: this.messages.length, activity: this.activity.length };
  }

  /** The one visible row for an MCP notice. The id stays on the group's first entry. */
  mcpChip(noticeId: string): ChatMessage | undefined {
    return this.mcpNotices.get(noticeId)?.message;
  }

  /**
   * Re-reads the drawings in this transcript. A replace or edit raises a diagram's
   * revision without adding an entry, so the row that already shows it must follow.
   * Returns true when a row changed.
   */
  refreshDiagrams(): boolean {
    let changed = false;
    for (const slot of this.diagramSlots) {
      const revision = this.diagramRevision?.(slot.diagramId);
      if (revision === undefined || revision === slot.revision) continue;
      const parts = slot.message.parts;
      if (parts === undefined) continue;
      const updated: ChatMessage = {
        ...slot.message,
        parts: parts.map((part) =>
          part.kind === "diagram" && part.diagram.id === slot.diagramId
            ? { kind: "diagram", diagram: { ...part.diagram, revision } }
            : part,
        ),
      };
      this.replaceMessage(slot.message, updated);
      slot.message = updated;
      slot.revision = revision;
      changed = true;
    }
    return changed;
  }

  private clear(): void {
    this.messages.length = 0;
    this.activity.length = 0;
    this.toolCalls.clear();
    this.pendingToolSpend.clear();
    this.partialEntryIds.clear();
    this.noticeQueueKeys.clear();
    this.mcpNotices.clear();
    this.diagramSlots.length = 0;
    this.latestMcpNoticeText = null;
    this.resetEntry = undefined;
    this.resetAt = undefined;
    this.resetMessage = undefined;
  }

  /** A restart's interrupt note names the assistant entry it cut off. */
  private notePartialEntry(entry: EntryRecord): void {
    if (!isRecord(entry.data)) return;
    const partialEntryId = entry.data.partialEntryId;
    if (typeof partialEntryId !== "number" || !Number.isSafeInteger(partialEntryId)) return;
    this.partialEntryIds.add(partialEntryId);
    const message = this.messages.find((item) => item.id === `m-${partialEntryId}`);
    if (message === undefined || message.partial === true) return;
    // Keep the field order of an assistant row built with the flag already known.
    const { usage, ...rest } = message;
    this.replaceMessage(message, {
      ...rest,
      partial: true,
      ...(usage === undefined ? {} : { usage }),
    });
  }

  /**
   * A placed queue copy shares its key with the decision notice that is its visible
   * form, so the copy must not also appear as a user message.
   */
  private noteDecisionQueueKeys(entry: EntryRecord): void {
    const queueKey = entryQueueKeyFromData(entry.data);
    if (queueKey !== undefined) this.dropQueuedMessage(queueKey);
    // Older notice entries only carried the logical key, not the queued input's key.
    const key = queueKeyFromEntryData(entry.data);
    if (key !== undefined) this.dropQueuedMessage(key);
  }

  private dropQueuedMessage(key: string): void {
    if (this.noticeQueueKeys.has(key)) return;
    this.noticeQueueKeys.add(key);
    const id = `m-${key}`;
    for (let index = this.messages.length - 1; index >= 0; index--) {
      if (this.messages[index]?.id === id) this.messages.splice(index, 1);
    }
  }

  /** Tracks the newest entry of each MCP notice, so its one row shows the latest text. */
  private noteMcpNotice(entry: EntryRecord): void {
    const groupId = mcpNoticeGroupId(entry);
    if (groupId === null) return;
    const existing = this.mcpNotices.get(groupId);
    if (existing === undefined) {
      this.mcpNotices.set(groupId, { first: entry, latest: entry });
      return;
    }
    if (entry.id < existing.first.id) existing.first = entry;
    if (mcpNoticeAt(entry) >= mcpNoticeAt(existing.latest)) existing.latest = entry;
  }

  private emitMcpNotice(entry: EntryRecord): void {
    const groupId = mcpNoticeGroupId(entry);
    if (groupId === null) return;
    const group = this.mcpNotices.get(groupId);
    if (group === undefined) return;
    if (!isRecord(group.latest.data) || typeof group.latest.data.text !== "string") return;
    const text = group.latest.data.text;
    this.latestMcpNoticeText = text;
    const notice = parseNotice(text);
    const at = group.latest.data.at;
    const timestamp =
      typeof at === "string" && Number.isFinite(Date.parse(at))
        ? new Date(at).toISOString()
        : entryTimestamp(group.latest.data);
    const existing = group.message;
    if (notice === null) {
      if (existing !== undefined) this.removeMessage(existing);
      group.message = undefined;
      return;
    }
    if (existing === undefined) {
      const message: ChatMessage = {
        id: entryMessageId(group.first),
        role: "user",
        text,
        timestamp,
        order: group.first.id * 10_000,
        notice,
      };
      group.message = message;
      this.emit(message);
      return;
    }
    const updated: ChatMessage = { ...existing, text, timestamp, notice };
    this.replaceMessage(existing, updated);
    group.message = updated;
  }

  /** A reset marker only refines the time the reset row shows. */
  private noteResetMarker(entry: EntryRecord): void {
    if (this.resetEntry === undefined || entry.id <= this.resetEntry.id) return;
    if (!isRecord(entry.data) || typeof entry.data.resetAt !== "string") return;
    if (!Number.isFinite(Date.parse(entry.data.resetAt))) return;
    this.resetAt = entry.data.resetAt;
    if (this.resetMessage === undefined) return;
    const updated: ChatMessage = { ...this.resetMessage, timestamp: entry.data.resetAt };
    this.replaceMessage(this.resetMessage, updated);
    this.resetMessage = updated;
  }

  private emit(message: ChatMessage): void {
    this.messages.splice(firstOrderAbove(this.messages, message.order), 0, message);
  }

  private emitActivity(item: ActivityItem): void {
    this.activity.splice(firstOrderAbove(this.activity, item.order), 0, item);
  }

  private replaceMessage(current: ChatMessage, next: ChatMessage): void {
    const index = this.messages.indexOf(current);
    if (index !== -1) this.messages[index] = next;
  }

  private removeMessage(message: ChatMessage): void {
    const index = this.messages.indexOf(message);
    if (index !== -1) this.messages.splice(index, 1);
  }
}

/** Index a new item belongs at, keeping display order and matching a stable sort. */
function firstOrderAbove(items: readonly { order: number }[], order: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((items[middle]?.order ?? 0) <= order) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The time a reset row shows, from the reset entry itself; a marker refines it later. */
function resetTimestampOf(entry: EntryRecord): string | undefined {
  const message = asRecord(entry.model?.[0]);
  const timestamp = message.timestamp;
  const parsed =
    typeof timestamp === "number"
      ? timestamp
      : typeof timestamp === "string"
        ? Date.parse(timestamp)
        : Number.NaN;
  if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  if (isRecord(entry.data) && typeof entry.data.resetAt === "string") return entry.data.resetAt;
  return undefined;
}

export function buildTranscript(
  entries: readonly EntryRecord[],
  media?: MediaResolver,
  diagramRevision?: DiagramRevisionResolver,
): BuiltTranscript {
  const builder = new TranscriptBuilder(media, diagramRevision);
  const ordered = [...entries].sort((a, b) => a.id - b.id);
  for (const entry of ordered) builder.append(entry);
  return builder.build();
}

export function toolActivityFromEntry(entry: EntryRecord, args: unknown): ToolActivity | undefined {
  if (!ToolResultEntry.is(entry)) return undefined;
  const message = asRecord(entry.model?.[0]);
  const memory = parseMemoryToolDetails(message.details);
  return {
    kind: "tool",
    id: `a-${entry.id}`,
    ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}),
    name: typeof message.toolName === "string" ? message.toolName : "tool",
    arguments: formatToolArguments(args),
    output: formatToolResult(message),
    details: formatToolDetails(message.details),
    ...(memory === undefined ? {} : { memory }),
    isError: message.isError === true,
    durationMs: typeof message.durationMs === "number" ? message.durationMs : undefined,
    timestamp: timestampOf(message),
    order: entry.id * 10_000,
  };
}

export function assistantMessageFromEntry(entry: EntryRecord): ChatMessage | null {
  if (!AssistantEntry.is(entry)) return null;
  const message = asRecord(entry.model?.[0]);
  const text = extractText(message.content);
  const errorText =
    typeof message.errorMessage === "string" && message.errorMessage.length > 0
      ? message.errorMessage
      : "";
  if (text.length === 0 && errorText.length === 0) return null;
  // A provider's loop guard names a settings control pi-ui does not have; the row says
  // what pi-ui did and how to continue instead.
  const shown = text.length > 0 ? text : loopGuardText(errorText);
  const blocks = contentBlocks(message.content);
  const hasThinking = blocks.some(
    (block) =>
      block.type === "thinking" &&
      typeof block.thinking === "string" &&
      block.thinking.trim().length > 0,
  );
  const hasToolCall = blocks.some(
    (block) => block.type === "toolCall" && typeof block.id === "string",
  );
  const spend = tokenSpend(message.usage);
  return {
    id: `m-${entry.id}`,
    role: "assistant",
    text: shown,
    timestamp: timestampOf(message),
    order: entry.id * 10_000 + 5_000,
    isError: errorText.length > 0,
    ...(spend !== undefined && !hasThinking && !hasToolCall ? { usage: spend } : {}),
  };
}

/**
 * Appends a proposal decision as a display-only notice. Durable places it even
 * while another turn runs, so the operator sees the approval immediately; the
 * model-facing prompt follows separately at the next boundary.
 */
export async function appendTaskDecisionNotice(
  conversation: Conversation,
  record: TaskDecisionNoticeRecord,
  key?: string,
): Promise<ChatMessage | undefined> {
  const createdAt = new Date().toISOString();
  const entry = await conversation.commit(
    (tx) =>
      tx.appendEntry(TaskDecisionEntry, conversation.id, {
        data: {
          proposalId: record.proposalId,
          taskId: record.taskId,
          taskTitle: record.taskTitle,
          decision: record.decision,
          text: taskDecisionPrompt(record),
          createdAt,
          ...(key === undefined ? {} : { key }),
        },
      }),
    SESSION_CONTEXT,
  );
  return buildTranscript([entry]).messages[0];
}

/**
 * Appends the newest text for an open MCP notice and returns the one visible
 * message for its key. Updates carry no model message, so they never start a turn.
 */
export async function appendMcpNotice(
  conversation: Conversation,
  notice: { noticeId: string; key: string; text: string; at: string },
): Promise<EntryRecord> {
  const createdAt = notice.at;
  // The chip id is the group's first entry, so the caller folds this row into the
  // transcript it already holds and reads `TranscriptBuilder.mcpChip`.
  return conversation.commit(
    (tx) =>
      tx.appendEntry(McpNoticeEntry, conversation.id, {
        data: {
          noticeId: notice.noticeId,
          key: notice.key,
          text: notice.text,
          at: notice.at,
          createdAt,
        },
      }),
    SESSION_CONTEXT,
  );
}

/** Records a memory write as a persistent chip the chat can show after a reload. */
export async function appendMemoryWriteNotice(
  conversation: Conversation,
  record: { path: string; text: string },
): Promise<ChatMessage | undefined> {
  const createdAt = new Date().toISOString();
  const capped = memoryNoticeText(record.text);
  const entry = await conversation.commit(
    (tx) =>
      tx.appendEntry(MemoryWriteEntry, conversation.id, {
        data: { path: record.path, ...capped, createdAt },
      }),
    SESSION_CONTEXT,
  );
  return buildTranscript([entry]).messages[0];
}

/** Records a notify_operator call as a persistent chat chip. */
export async function appendOperatorNotice(
  conversation: Conversation,
  record: OperatorNoticeRecord,
): Promise<ChatMessage | undefined> {
  const createdAt = new Date().toISOString();
  const entry = await conversation.commit(
    (tx) =>
      tx.appendEntry(OperatorNoticeEntry, conversation.id, {
        data: { title: record.title, body: record.body, reason: record.reason, createdAt },
      }),
    SESSION_CONTEXT,
  );
  return buildTranscript([entry]).messages[0];
}

/** Records a job result the agent is not told about and returns its activity item. */
export async function appendJobNotice(
  conversation: Conversation,
  text: string,
): Promise<ActivityItem | undefined> {
  const createdAt = new Date().toISOString();
  const entry = await conversation.commit(
    (tx) => tx.appendEntry(JobNoticeEntry, conversation.id, { data: { text, createdAt } }),
    SESSION_CONTEXT,
  );
  return buildTranscript([entry]).activity[0];
}

export async function appendAssistantError(
  conversation: Conversation,
  text: string,
): Promise<void> {
  const message = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "unknown",
    provider: "unknown",
    model: "unknown",
    usage: emptyUsage(),
    stopReason: "error",
    errorMessage: text,
    timestamp: Date.now(),
  } as unknown as AssistantMessage;

  await conversation.commit(
    (tx) => tx.appendEntry(AssistantEntry, conversation.id, { model: [message] }),
    SESSION_CONTEXT,
  );
}

export function summarizeUsage(state: UsageState | undefined): UsageSummary {
  const summary: UsageSummary = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: 0,
  };

  for (const bucket of [state?.models ?? {}, state?.tools ?? {}]) {
    for (const usage of Object.values(bucket)) {
      summary.input += usage.input;
      summary.output += usage.output;
      summary.cacheRead += usage.cacheRead;
      summary.cacheWrite += usage.cacheWrite;
      summary.totalTokens += contextTokensOf(usage);
      summary.cost += usage.cost.total;
    }
  }
  return summary;
}

export function contextUsage(
  entries: readonly EntryRecord[],
  window: number | undefined,
): ContextUsage {
  let tokens = 0;
  const sorted = [...entries].sort((a, b) => b.id - a.id);
  for (const entry of sorted) {
    if (entry.kind !== AssistantEntry.kind) continue;
    const message = asRecord(entry.model?.[0]);
    if (message.stopReason === "aborted" || message.stopReason === "error") continue;
    const usage = asRecord(message.usage);
    if (Object.keys(usage).length === 0) continue;
    const candidate = contextTokensOf(usage as unknown as Usage);
    if (candidate > 0) {
      tokens = candidate;
      break;
    }
  }

  return {
    tokens,
    window: window ?? null,
    percent:
      window !== undefined && window > 0
        ? Math.min(100, Math.round((tokens / window) * 1000) / 10)
        : null,
  };
}

function contextTokensOf(usage: Usage): number {
  return (
    (typeof usage.totalTokens === "number" && usage.totalTokens > 0
      ? usage.totalTokens
      : usage.input + usage.output + usage.cacheRead + usage.cacheWrite) || 0
  );
}

function userImages(content: unknown, media: MediaResolver): MediaRef[] {
  const refs: MediaRef[] = [];
  for (const block of contentBlocks(content)) {
    if (block.type !== "image") continue;
    if (typeof block.data !== "string" || typeof block.mimeType !== "string") continue;
    const ref = media(block.data, block.mimeType);
    if (ref !== undefined) refs.push(ref);
  }
  return refs;
}

/** The id a machine notice's chat message keeps across its queued and placed forms. */
function entryMessageId(entry: EntryRecord): string {
  const queueKey =
    isRecord(entry.data) && typeof entry.data.queueKey === "string" ? entry.data.queueKey : null;
  return queueKey === null ? `m-${entry.id}` : `m-${queueKey}`;
}

function mcpNoticeGroupId(entry: EntryRecord): string | null {
  if (entry.kind !== McpNoticeEntry.kind || !isRecord(entry.data)) return null;
  if (typeof entry.data.noticeId === "string") return entry.data.noticeId;
  // Entries from before per-window ids still group by their logical key.
  return typeof entry.data.key === "string" ? `legacy:${entry.data.key}` : null;
}

function mcpNoticeAt(entry: EntryRecord): number {
  if (!isRecord(entry.data) || typeof entry.data.at !== "string") return entry.id;
  const parsed = Date.parse(entry.data.at);
  return Number.isFinite(parsed) ? parsed : entry.id;
}

function entryTimestamp(data: unknown): string {
  const createdAt = isRecord(data) && typeof data.createdAt === "string" ? data.createdAt : null;
  return toIsoTimestamp(createdAt) ?? new Date().toISOString();
}

function timestampOf(message: Record<string, unknown>): string {
  const timestamp = message.timestamp;
  const parsed =
    typeof timestamp === "number"
      ? timestamp
      : typeof timestamp === "string"
        ? Date.parse(timestamp)
        : Number.NaN;
  return new Date(Number.isFinite(parsed) ? parsed : Date.now()).toISOString();
}

function contentBlocks(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) return [];
  return content.filter(isRecord);
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("\n\n");
}

function tokenSpend(usage: unknown): TokenSpend | undefined {
  if (!isRecord(usage)) return undefined;
  const { input, output } = usage;
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  if (!Number.isFinite(input) || !Number.isFinite(output)) return undefined;
  return { input: Math.max(0, input), output: Math.max(0, output) };
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
