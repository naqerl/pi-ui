import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
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
  ToolResultEntry,
  type UsageState,
  UserEntry,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { parseNotice } from "../shared/notices.js";
import { steerKeyFromEntryData } from "../shared/steers.js";
import {
  type ActivityItem,
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
import type { JobManager } from "./jobs.js";
import type { McpRuntime } from "./mcp-runtime.js";
import type { SnapshotCache } from "./memory/snapshot.js";
import type { MemoryStore } from "./memory/store.js";
import { formatToolArguments, formatToolDetails, formatToolResult } from "./pi.js";
import { type RunMarker, RunMarkerStore } from "./run-marker.js";
import type { TaskBridge } from "./task-tools.js";
import { pendingVersionNotice, writeLastSeenVersion } from "./version-notice.js";

export const SESSION_CONTEXT: Context = BACKGROUND_CONTEXT;

const InterruptedRunEntry = defineEntry<{
  markerKey: string;
  partialEntryId: number | null;
  note: string;
  createdAt: string;
}>("ui.run-interrupted");

/** A version change seen at start. `model` carries the notice so the agent reads it in context. */
const VersionUpdateEntry = defineEntry<{
  from: string | null;
  to: string;
  note: string;
  createdAt: string;
}>("ui.version-update");

/**
 * A background job result. The agent-visible result is placed as this entry through an input, so
 * its model message is unchanged; a cancelled or `notify: false` result has no `model` part and is
 * only recorded for the activity page.
 */
const JobNoticeEntry = defineEntry<{
  text: string;
  createdAt: string;
}>("ui.job-notice");

/** The entry kind a job result is placed as; the chat never renders it as a user message. */
export const JOB_NOTICE_ENTRY_KIND = JobNoticeEntry.kind;

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
  readonly dashboard?: DashboardManager;
  readonly memory?: { readonly store: MemoryStore; readonly snapshot?: SnapshotCache };
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
  readonly dashboardTools: readonly string[];
  readonly memoryTools: readonly string[];
  /** Model stored on the conversation after boot. A menu choice wins over `PI_MODEL`. */
  readonly model: ModelRef | undefined;
  /** pi-ui's own version from package.json. */
  readonly version: string;
}

export async function openDurableSession(
  options: DurableSessionOptions,
): Promise<DurableSessionBoot> {
  const dataDir = resolve(options.cwd, process.env.DATA_DIR?.trim() || "data");
  const databasePath = join(dataDir, "pi.sqlite3");
  const currentPath = join(dataDir, "current.json");
  await mkdir(dataDir, { recursive: true });

  const storage = await openNodeSqliteStorage(databasePath);
  const { registry, mcp, biliTools, taskTools, jobTools, dashboardTools, memoryTools } =
    await createAppRegistry({
      dataDir,
      bili: options.bili,
      tasks: options.tasks,
      ...(options.jobs === undefined ? {} : { jobs: options.jobs }),
      ...(options.dashboard === undefined ? {} : { dashboard: options.dashboard }),
      ...(options.memory === undefined ? {} : { memory: options.memory }),
    });

  const harness = await HarnessImpl.open(
    storage,
    {
      models: options.models,
      registry: registry as Registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? options.cwd }),
      settings: {
        // billion-context compresses the request on the wire. pi-durable's own
        // compaction would remove messages before the bridge sees them, so it
        // stays off; manual compaction remains available.
        compaction: { enabled: false },
        // Every steer waiting at a turn boundary goes in at that boundary, in the order sent,
        // instead of one per boundary, which pushed later steers past the run's end.
        steeringMode: "all",
      },
      onReport: (error) => console.error("[pi] harness report", error),
    },
    SESSION_CONTEXT,
  );

  const { conversation, resumed } = await loadConversation(harness, currentPath, {
    cwd: options.cwd,
    instructions: options.instructions,
    ...(options.model === undefined ? {} : { model: options.model }),
  });
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
    dashboardTools,
    memoryTools,
    model,
    version,
  };
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
 * resuming that work from its last checkpoint, so leave it pending. A stop
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
    if (entry.kind !== UserEntry.kind && entry.kind !== STEER_ENTRY_KIND) continue;
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

async function appendInterruptionNote(
  conversation: Conversation,
  marker: RunMarker,
): Promise<void> {
  const context = await conversation.context(SESSION_CONTEXT);
  const alreadyRecorded = context.entries.some((entry) => {
    if (entry.kind !== InterruptedRunEntry.kind || !isRecord(entry.data)) return false;
    return entry.data.markerKey === marker.idempotencyKey;
  });
  if (alreadyRecorded) return;

  const note = marker.stopRequested
    ? "The previous run was stopped before the server restarted. The last response may be partial."
    : "The previous run was interrupted by a server restart. The last response is partial; pi is resuming the run.";
  try {
    await conversation.commit(
      (tx) =>
        tx.appendEntry(InterruptedRunEntry, conversation.id, {
          data: {
            markerKey: marker.idempotencyKey,
            partialEntryId: marker.partialEntryId,
            note,
            createdAt: new Date().toISOString(),
          },
        }),
      SESSION_CONTEXT,
    );
  } catch (error) {
    console.error("[pi] could not record the interrupted-run note", error);
  }
}

/** Maps an image block in a user entry to its served media id. */
export type MediaResolver = (data: string, mimeType: string) => MediaRef | undefined;

export function buildTranscript(
  entries: readonly EntryRecord[],
  media?: MediaResolver,
): {
  messages: ChatMessage[];
  activity: ActivityItem[];
} {
  const messages: ChatMessage[] = [];
  const activity: ActivityItem[] = [];
  const sorted = [...entries].sort((a, b) => a.id - b.id);
  const toolCalls = new Map<string, { name: string; arguments: unknown }>();
  const pendingToolSpend = new Map<string, TokenSpend>();
  const partialEntryIds = new Set<number>();
  for (const entry of sorted) {
    if (entry.kind !== InterruptedRunEntry.kind || !isRecord(entry.data)) continue;
    if (
      typeof entry.data.partialEntryId === "number" &&
      Number.isSafeInteger(entry.data.partialEntryId)
    ) {
      partialEntryIds.add(entry.data.partialEntryId);
    }
  }

  for (const entry of sorted) {
    if (entry.kind !== AssistantEntry.kind) continue;
    const message = asRecord(entry.model?.[0]);
    for (const block of contentBlocks(message.content)) {
      if (block.type === "toolCall" && typeof block.id === "string") {
        toolCalls.set(block.id, {
          name: typeof block.name === "string" ? block.name : "tool",
          arguments: block.arguments,
        });
      }
    }
  }

  for (const entry of sorted) {
    const kind = entry.kind;
    if (kind === JobNoticeEntry.kind) {
      if (!isRecord(entry.data) || typeof entry.data.text !== "string") continue;
      const notice = parseNotice(entry.data.text);
      if (notice === null || notice.kind !== "job") continue;
      activity.push({
        kind: "job",
        id: `j-${entry.id}`,
        notice,
        timestamp:
          typeof entry.data.createdAt === "string"
            ? entry.data.createdAt
            : new Date().toISOString(),
        order: entry.id * 10_000,
      });
      continue;
    }
    if (kind === InterruptedRunEntry.kind) {
      if (!isRecord(entry.data) || typeof entry.data.note !== "string") continue;
      messages.push({
        id: `m-${entry.id}`,
        role: "system",
        text: entry.data.note,
        timestamp:
          typeof entry.data.createdAt === "string"
            ? entry.data.createdAt
            : new Date().toISOString(),
        order: entry.id * 10_000,
      });
      continue;
    }
    if (kind === VersionUpdateEntry.kind) {
      if (!isRecord(entry.data) || typeof entry.data.note !== "string") continue;
      messages.push({
        id: `m-${entry.id}`,
        role: "system",
        text: entry.data.note,
        timestamp:
          typeof entry.data.createdAt === "string"
            ? entry.data.createdAt
            : new Date().toISOString(),
        order: entry.id * 10_000,
        version: {
          from: typeof entry.data.from === "string" ? entry.data.from : null,
          to: typeof entry.data.to === "string" ? entry.data.to : "",
        },
      });
      continue;
    }
    if (
      kind !== UserEntry.kind &&
      kind !== STEER_ENTRY_KIND &&
      kind !== AssistantEntry.kind &&
      kind !== ToolResultEntry.kind
    ) {
      continue;
    }
    const message = asRecord(entry.model?.[0]);
    if (kind === UserEntry.kind || kind === STEER_ENTRY_KIND) {
      const text = extractText(message.content);
      const attachments = media === undefined ? [] : userImages(message.content, media);
      const steerKey = kind === STEER_ENTRY_KIND ? steerKeyFromEntryData(entry.data) : undefined;
      if (text.length > 0 || attachments.length > 0) {
        const notice = parseNotice(text);
        // Older conversations stored a job result as a normal user entry. Keep it out of the chat
        // too, and show it where every other result of that run is shown.
        if (notice?.kind === "job") {
          activity.push({
            kind: "job",
            id: `j-${entry.id}`,
            notice,
            timestamp: timestampOf(message),
            order: entry.id * 10_000,
          });
          continue;
        }
        messages.push({
          id: `m-${entry.id}`,
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
      continue;
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
      const visible = text.length > 0 || errorText.length > 0;
      if (visible) {
        messages.push({
          id: `m-${entry.id}`,
          role: "assistant",
          text: text.length > 0 ? text : errorText,
          timestamp: timestampOf(message),
          order: entry.id * 10_000 + 5_000,
          isError: errorText.length > 0,
          ...(partialEntryIds.has(entry.id) ? { partial: true } : {}),
          ...(spend !== undefined && thinkingBlocks.length === 0 && toolCallIds.length === 0
            ? { usage: spend }
            : {}),
        });
      }
      thinkingBlocks.forEach((block, index) => {
        const thinking = block.thinking;
        if (typeof thinking !== "string") return;
        activity.push({
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
        pendingToolSpend.set(firstToolCall, spend);
      }
      continue;
    }

    if (kind === ToolResultEntry.kind) {
      const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
      const call = toolCalls.get(toolCallId);
      const tool = toolActivityFromEntry(entry, call?.arguments);
      if (tool) {
        const usage = pendingToolSpend.get(toolCallId);
        if (usage !== undefined) pendingToolSpend.delete(toolCallId);
        activity.push(usage === undefined ? tool : { ...tool, usage });
      }
    }
  }

  messages.sort((a, b) => a.order - b.order);
  activity.sort((a, b) => a.order - b.order);
  return { messages, activity };
}

export function toolActivityFromEntry(entry: EntryRecord, args: unknown): ToolActivity | undefined {
  if (!ToolResultEntry.is(entry)) return undefined;
  const message = asRecord(entry.model?.[0]);
  return {
    kind: "tool",
    id: `a-${entry.id}`,
    name: typeof message.toolName === "string" ? message.toolName : "tool",
    arguments: formatToolArguments(args),
    output: formatToolResult(message),
    details: formatToolDetails(message.details),
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
    text: text.length > 0 ? text : errorText,
    timestamp: timestampOf(message),
    order: entry.id * 10_000 + 5_000,
    isError: errorText.length > 0,
    ...(spend !== undefined && !hasThinking && !hasToolCall ? { usage: spend } : {}),
  };
}

/** Records a job result the agent is not told about and returns its activity item. */
export async function appendJobNotice(
  conversation: Conversation,
  text: string,
): Promise<ActivityItem | undefined> {
  const createdAt = new Date().toISOString();
  await conversation.commit(
    (tx) => tx.appendEntry(JobNoticeEntry, conversation.id, { data: { text, createdAt } }),
    SESSION_CONTEXT,
  );
  const context = await conversation.context(SESSION_CONTEXT);
  const entry = [...context.entries]
    .reverse()
    .find(
      (candidate) =>
        candidate.kind === JobNoticeEntry.kind &&
        isRecord(candidate.data) &&
        candidate.data.createdAt === createdAt &&
        candidate.data.text === text,
    );
  return entry === undefined ? undefined : buildTranscript([entry]).activity[0];
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

function timestampOf(message: Record<string, unknown>): string {
  const timestamp = message.timestamp;
  return new Date(typeof timestamp === "number" ? timestamp : Date.now()).toISOString();
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
