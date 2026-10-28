import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  type Conversation,
  type ConversationId,
  type EntryRecord,
  type Harness,
  Harness as HarnessImpl,
  type ModelRef,
  type Registry,
  ToolResultEntry,
  type UsageState,
  UserEntry,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  type ActivityItem,
  type ChatMessage,
  type ContextUsage,
  STEER_ENTRY_KIND,
  type ToolActivity,
  type UsageSummary,
} from "../shared/types.js";
import { createAppRegistry } from "./app-registry.js";
import type { BillionContextInline } from "./billion-context.js";
import { formatToolArguments, formatToolDetails, formatToolResult } from "./pi.js";
import type { WebToolsBridge } from "./web-tools.js";

export const SESSION_CONTEXT: Context = BACKGROUND_CONTEXT;

export interface DurableSessionOptions {
  readonly cwd: string;
  readonly models: Parameters<typeof HarnessImpl.open>[1]["models"];
  readonly instructions: string;
  readonly model: ModelRef | undefined;
  readonly bili?: BillionContextInline;
}

export interface DurableSessionBoot {
  readonly harness: Harness;
  readonly conversation: Conversation;
  readonly dataDir: string;
  readonly databasePath: string;
  readonly currentPath: string;
  readonly resumed: boolean;
  readonly interrupted: boolean;
  readonly webTools: WebToolsBridge | undefined;
  readonly biliTools: readonly string[];
}

export async function openDurableSession(
  options: DurableSessionOptions,
): Promise<DurableSessionBoot> {
  const dataDir = resolve(options.cwd, process.env.DATA_DIR?.trim() || "data");
  const databasePath = join(dataDir, "pi.sqlite3");
  const currentPath = join(dataDir, "current.json");
  await mkdir(dataDir, { recursive: true });

  const storage = await openNodeSqliteStorage(databasePath);
  const { registry, webTools, biliTools } = await createAppRegistry({ bili: options.bili });

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
      },
      onReport: (error) => console.error("[pi] harness report", error),
    },
    SESSION_CONTEXT,
  );

  const agent = {
    cwd: options.cwd,
    instructions: options.instructions,
    ...(options.model === undefined ? {} : { model: options.model }),
  };
  const { conversation, resumed } = await loadConversation(harness, currentPath, agent);
  await conversation.configure(agent, SESSION_CONTEXT);

  const interrupted = await recoverInterruptedRun(harness, conversation);
  return {
    harness,
    conversation,
    dataDir,
    databasePath,
    currentPath,
    resumed,
    interrupted,
    webTools,
    biliTools,
  };
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
 * A process that died mid-turn reopens with live durable work. Abort it once,
 * which settles the in-flight generation (keeping its partial answer) without
 * replaying tokens or continuing the turn. The snapshot then reports
 * `interrupted` and the user can send the next message.
 */
async function recoverInterruptedRun(
  harness: Harness,
  conversation: Conversation,
): Promise<boolean> {
  const inspection = await harness.inspect(SESSION_CONTEXT);
  const unfinished =
    inspection.tasks.length > 0 ||
    inspection.submissions.some(
      (submission) => submission.status === "queued" || submission.status === "placed",
    );
  if (!unfinished) return false;

  console.warn(
    `[pi] conversation ${conversation.id} has unfinished work from the previous process; marking it interrupted`,
  );
  try {
    await conversation.abort(SESSION_CONTEXT);
  } catch (error) {
    console.error("[pi] could not abort the interrupted run", error);
  }
  return true;
}

export function buildTranscript(entries: readonly EntryRecord[]): {
  messages: ChatMessage[];
  activity: ActivityItem[];
} {
  const messages: ChatMessage[] = [];
  const activity: ActivityItem[] = [];
  const sorted = [...entries].sort((a, b) => a.id - b.id);
  const toolCalls = new Map<string, { name: string; arguments: unknown }>();

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
      if (text.length > 0) {
        messages.push({
          id: `m-${entry.id}`,
          role: "user",
          text,
          timestamp: timestampOf(message),
          order: entry.id * 10_000,
          ...(kind === STEER_ENTRY_KIND ? { steer: true } : {}),
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
      if (text.length > 0 || errorText.length > 0) {
        messages.push({
          id: `m-${entry.id}`,
          role: "assistant",
          text: text.length > 0 ? text : errorText,
          timestamp: timestampOf(message),
          order: entry.id * 10_000 + 5_000,
          isError: errorText.length > 0,
        });
      }
      let thinkingIndex = 0;
      for (const block of contentBlocks(message.content)) {
        if (block.type !== "thinking" || typeof block.thinking !== "string") continue;
        if (block.thinking.trim().length === 0) continue;
        activity.push({
          kind: "thinking",
          id: `t-${entry.id}-${thinkingIndex}`,
          name: "thinking",
          text: block.thinking,
          timestamp: timestampOf(message),
          order: entry.id * 10_000 + 1 + thinkingIndex * 2,
        });
        thinkingIndex++;
      }
      continue;
    }

    if (kind === ToolResultEntry.kind) {
      const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : "";
      const call = toolCalls.get(toolCallId);
      const tool = toolActivityFromEntry(entry, call?.arguments);
      if (tool) activity.push(tool);
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
  return {
    id: `m-${entry.id}`,
    role: "assistant",
    text: text.length > 0 ? text : errorText,
    timestamp: timestampOf(message),
    order: entry.id * 10_000 + 5_000,
    isError: errorText.length > 0,
  };
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
