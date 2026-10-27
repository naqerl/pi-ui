import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { SessionEntry, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { ActivityItem, ChatMessage, Snapshot, ToolActivity } from "../shared/types.js";

type StoredMessage = SessionMessageEntry["message"];

interface EventBase {
  id: number;
  timestamp: string;
}

interface UserEvent extends EventBase {
  type: "user";
  message: StoredMessage;
}

interface AssistantEvent extends EventBase {
  type: "assistant";
  message: StoredMessage;
}

interface ToolResultEvent extends EventBase {
  type: "tool_result";
  message: StoredMessage;
}

interface ToolEvent extends EventBase {
  type: "tool";
  tool: {
    toolCallId: string;
    name: string;
    arguments: string;
    output?: string;
    isError: boolean;
    durationMs?: number;
  };
}

type StoredEvent = UserEvent | AssistantEvent | ToolResultEvent | ToolEvent;

export interface ToolRecord {
  toolCallId: string;
  name: string;
  arguments: string;
  output?: string;
  isError: boolean;
  durationMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function extractThinking(message: StoredMessage): string[] {
  const content = asRecord(message).content;
  if (!Array.isArray(content)) return [];
  const blocks: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "thinking" && typeof block.thinking === "string") {
      if (block.thinking.trim().length > 0) blocks.push(block.thinking);
    }
  }
  return blocks;
}

function asRecord(message: StoredMessage): Record<string, unknown> {
  return isRecord(message) ? message : {};
}

function messageKey(message: StoredMessage): string {
  const value = asRecord(message);
  return `${String(value.role)}:${String(value.timestamp)}:${String(value.toolCallId ?? "")}`;
}

export class TranscriptStore {
  private readonly filePath: string;
  private readonly events: StoredEvent[] = [];
  private readonly seenMessages = new Set<string>();
  private nextId = 1;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(filePath = resolve(process.cwd(), "data", "session.jsonl")) {
    this.filePath = filePath;
  }

  async load(): Promise<void> {
    let contents: string;
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return;
      throw error;
    }

    for (const line of contents.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const value = JSON.parse(line) as unknown;
        if (!isRecord(value)) continue;
        if (typeof value.id !== "number" || typeof value.timestamp !== "string") continue;
        if (typeof value.type !== "string") continue;
        const event = value as unknown as StoredEvent;
        this.events.push(event);
        this.nextId = Math.max(this.nextId, event.id + 1);
        if (event.type === "assistant" || event.type === "tool_result") {
          this.seenMessages.add(messageKey(event.message));
        }
      } catch {
        // A truncated final line must not prevent the rest of the transcript from loading.
      }
    }
  }

  getSnapshot(): Omit<Snapshot, "run"> {
    const messages: ChatMessage[] = [];
    const activity: ActivityItem[] = [];

    for (const event of this.events) {
      if (event.type === "user") {
        const text = extractText(asRecord(event.message).content);
        if (text.length > 0) {
          messages.push({
            id: `m-${event.id}`,
            role: "user",
            text,
            timestamp: event.timestamp,
            order: event.id * 10_000,
          });
        }
        continue;
      }

      if (event.type === "assistant") {
        const value = asRecord(event.message);
        const text = extractText(asRecord(event.message).content);
        const errorText =
          typeof value.errorMessage === "string" && value.errorMessage.length > 0
            ? value.errorMessage
            : "";
        if (text.length > 0 || errorText.length > 0) {
          messages.push({
            id: `m-${event.id}`,
            role: "assistant",
            text: text.length > 0 ? text : errorText,
            timestamp: event.timestamp,
            order: event.id * 10_000 + 5_000,
            isError: errorText.length > 0,
          });
        }
        extractThinking(event.message).forEach((thinking, index) => {
          activity.push({
            kind: "thinking",
            id: `t-${event.id}-${index}`,
            name: "thinking",
            text: thinking,
            timestamp: event.timestamp,
            order: event.id * 10_000 + 1 + index * 2,
          });
        });
        continue;
      }

      if (event.type === "tool") {
        activity.push({
          kind: "tool",
          id: `a-${event.id}`,
          name: event.tool.name,
          arguments: event.tool.arguments,
          output: event.tool.output,
          isError: event.tool.isError,
          durationMs: event.tool.durationMs,
          timestamp: event.timestamp,
          order: event.id * 10_000,
        });
      }
    }

    messages.sort((a, b) => a.order - b.order);
    activity.sort((a, b) => a.order - b.order);
    return { messages, activity };
  }

  getHistoryEntries(): SessionEntry[] {
    const entries: SessionEntry[] = [];
    let parentId: string | null = null;

    for (const event of this.events) {
      if (event.type !== "user" && event.type !== "assistant" && event.type !== "tool_result") {
        continue;
      }
      const id = `ui-${event.id}`;
      entries.push({
        type: "message",
        id,
        parentId,
        timestamp: event.timestamp,
        message: event.message,
      });
      parentId = id;
    }

    return entries;
  }

  async appendUser(text: string): Promise<ChatMessage> {
    const timestamp = new Date().toISOString();
    const message = {
      role: "user",
      content: text,
      timestamp: Date.now(),
    } as StoredMessage;
    const event: UserEvent = {
      id: this.takeId(),
      timestamp,
      type: "user",
      message,
    };
    await this.append(event);
    return {
      id: `m-${event.id}`,
      role: "user",
      text,
      timestamp,
      order: event.id * 10_000,
    };
  }

  async appendAssistant(message: StoredMessage): Promise<ChatMessage | null> {
    const key = messageKey(message);
    if (this.seenMessages.has(key)) return null;
    this.seenMessages.add(key);

    const timestamp = new Date().toISOString();
    const event: AssistantEvent = {
      id: this.takeId(),
      timestamp,
      type: "assistant",
      message,
    };
    await this.append(event);

    const value = asRecord(message);
    const text = extractText(asRecord(message).content);
    const errorText =
      typeof value.errorMessage === "string" && value.errorMessage.length > 0
        ? value.errorMessage
        : "";
    if (text.length === 0 && errorText.length === 0) return null;

    return {
      id: `m-${event.id}`,
      role: "assistant",
      text: text.length > 0 ? text : errorText,
      timestamp,
      order: event.id * 10_000 + 5_000,
      isError: errorText.length > 0,
    };
  }

  async appendAssistantError(text: string): Promise<ChatMessage> {
    const message = {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "unknown",
      provider: "unknown",
      model: "unknown",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "error",
      errorMessage: text,
      timestamp: Date.now(),
    } as StoredMessage;
    const result = await this.appendAssistant(message);
    if (result) return result;
    return {
      id: `m-error-${Date.now()}`,
      role: "assistant",
      text,
      timestamp: new Date().toISOString(),
      order: Number.MAX_SAFE_INTEGER,
      isError: true,
    };
  }

  async appendToolResult(message: StoredMessage): Promise<void> {
    const key = messageKey(message);
    if (this.seenMessages.has(key)) return;
    this.seenMessages.add(key);

    const event: ToolResultEvent = {
      id: this.takeId(),
      timestamp: new Date().toISOString(),
      type: "tool_result",
      message,
    };
    await this.append(event);
  }

  async appendTool(tool: ToolRecord): Promise<ToolActivity> {
    const timestamp = new Date().toISOString();
    const event: ToolEvent = {
      id: this.takeId(),
      timestamp,
      type: "tool",
      tool,
    };
    await this.append(event);
    return {
      kind: "tool",
      id: `a-${event.id}`,
      name: tool.name,
      arguments: tool.arguments,
      output: tool.output,
      isError: tool.isError,
      durationMs: tool.durationMs,
      timestamp,
      order: event.id * 10_000,
    };
  }

  private takeId(): number {
    return this.nextId++;
  }

  private async append(event: StoredEvent): Promise<void> {
    const write = this.writeChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
    });
    this.writeChain = write.catch(() => undefined);
    await write;
    this.events.push(event);
  }
}
