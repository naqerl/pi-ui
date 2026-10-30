import { EventEmitter } from "node:events";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
  defineTool,
  type Registry,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Static, TSchema } from "typebox";
import type { ExtensionNotice } from "./mcp-events.js";

/**
 * The small part of pi's extension API that the MCP adapter and pi-mcp-events
 * use. pi-ui has no general extension loader: tools registered here are
 * installed into the durable registry and messages go through the chat's
 * durable submit path.
 */
export interface DurableExtensionApi {
  readonly events: EventEmitter;
  registerTool(tool: DurableExtensionTool): void;
  on(event: string, handler: DurableExtensionHandler): void;
  sendMessage(message: DurableExtensionMessage, options?: DurableSendOptions): void;
}

export interface DurableExtensionTool {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly parameters: TSchema;
  execute(
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
  ): Promise<AgentToolResult>;
}

export type DurableExtensionHandler = (
  event: unknown,
  context: DurableExtensionContext,
) => void | Promise<void>;

export interface DurableExtensionContext {
  readonly ui: {
    notify(text: string, level?: "info" | "warning" | "error"): void;
  };
}

export interface DurableExtensionMessage {
  readonly customType?: string;
  readonly content: string | readonly DurableExtensionContent[];
  readonly display?: boolean;
  readonly details?: JsonValue;
}

interface DurableExtensionContent {
  readonly type: string;
  readonly text?: string;
}

export interface DurableSendOptions {
  readonly triggerTurn?: boolean;
  readonly deliverAs?: "steer" | "followUp" | "nextTurn";
}

export type DurableExtensionSink = (text: string, options: DurableSendOptions) => void;

const emptyContext: DurableExtensionContext = {
  ui: {
    notify: () => {},
  },
};

/** ` : 2 events from stub` style detail for the one-line notice log. */
function noticeSummary(details: unknown): string {
  if (typeof details !== "object" || details === null) return "";
  const record = details as Record<string, unknown>;
  if (Array.isArray(record.events)) {
    const servers = [
      ...new Set(
        record.events.flatMap((item) =>
          typeof item === "object" && item !== null && typeof item.server === "string"
            ? [item.server as string]
            : [],
        ),
      ),
    ];
    const count = record.events.length;
    return `: ${count} event${count === 1 ? "" : "s"}${servers.length > 0 ? ` from ${servers.join(", ")}` : ""}`;
  }
  if (Array.isArray(record.subscriptions)) {
    const count = record.subscriptions.length;
    return `: ${count} subscription status${count === 1 ? "" : "es"}`;
  }
  return "";
}

function messageText(message: DurableExtensionMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text ?? "")
    .join("\n");
}

/**
 * A deliberately small ExtensionAPI stand-in. It exposes only registration,
 * an event bus, handler hooks, and durable message submission.
 */
export class DurableExtensionShim implements DurableExtensionApi {
  readonly events = new EventEmitter();
  private readonly installed: ToolRegistration[] = [];
  private readonly extensionTools = new Map<string, DurableExtensionTool>();
  private readonly handlers = new Map<string, DurableExtensionHandler[]>();
  private sink: DurableExtensionSink | undefined;
  private observer: ((notice: ExtensionNotice) => unknown) | undefined;
  private closed = false;

  setObserver(observer: ((notice: ExtensionNotice) => unknown) | undefined): void {
    this.observer = observer;
  }

  get tools(): readonly ToolRegistration[] {
    return this.installed;
  }

  setMessageSink(sink: DurableExtensionSink | undefined): void {
    this.sink = sink;
  }

  registerTool(tool: DurableExtensionTool): void {
    if (this.closed) throw new Error("Extension API is closed");
    if (this.installed.some((entry) => entry.name === tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    const registration = defineTool({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      ...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
      // MCP tools stay behind tool_search, as the hand-rolled bridge did.
      deferred: true,
      callers: ["model", "tools"],
      execute: async (args: Static<TSchema>, api, context) => {
        const result = await tool.execute(api.callId, args, context.abortSignal);
        if (tool.name === "mcp_events") {
          this.observer?.({
            customType: "mcp-events-tool",
            details: { args, result: result.details ?? null },
          });
        }
        return {
          output: result.content,
          details: result.details as unknown as ToolExecutionResult["details"],
          ...(result.isError === true ? { isError: true } : {}),
        };
      },
    });
    this.installed.push(registration);
    this.extensionTools.set(tool.name, tool);
  }

  /**
   * Invoke an extension tool directly. pi-mcp-events registers `mcp_events`
   * this way, so boot-time restoration can subscribe with a stored cursor
   * without going through the model or the durable tool registry.
   */
  async callTool(name: string, params: unknown, signal?: AbortSignal): Promise<AgentToolResult> {
    if (this.closed) throw new Error("Extension API is closed");
    const tool = this.extensionTools.get(name);
    if (tool === undefined) throw new Error(`Unknown extension tool: ${name}`);
    return tool.execute(`ext-${name}-${Date.now()}`, params, signal);
  }

  on(event: string, handler: DurableExtensionHandler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  /**
   * Bound, so an extension that keeps `pi.sendMessage` apart from `pi`, or
   * gets an `Object.create(shim)` view, still reaches this observer and sink.
   * Extensions call this from timers (pi-mcp-events batches for 500ms), where
   * a throw would vanish, so every failure is logged here instead.
   */
  readonly sendMessage = (
    message: DurableExtensionMessage,
    options: DurableSendOptions = {},
  ): void => {
    const kind = message.customType ?? "message";
    if (this.closed) {
      console.warn(`[mcp] ${kind} notice dropped: extension API is closed`);
      return;
    }
    console.log(`[mcp] ${kind} notice${noticeSummary(message.details)}`);
    let deliver = true;
    try {
      deliver =
        this.observer?.({ customType: message.customType, details: message.details }) !== false;
    } catch (error) {
      console.error(`[mcp] ${kind} notice observer failed`, error);
    }
    if (!deliver) {
      console.log(`[mcp] ${kind} notice skipped: no new data`);
      return;
    }
    const text = messageText(message);
    if (text.length === 0) return;
    if (this.sink === undefined) {
      console.warn(`[mcp] ${kind} notice not submitted: no message sink`);
      return;
    }
    try {
      this.sink(text, options);
    } catch (error) {
      console.error(`[mcp] ${kind} notice submit failed`, error);
    }
  };

  install(registry: Registry<ToolRegistration>): void {
    if (this.installed.length === 0) return;
    registry.install(
      Object.freeze({
        name: "pi-ui-mcp-tools",
        tools: Object.freeze([...this.installed]),
      }),
    );
  }

  async dispatch(event: string): Promise<void> {
    const handlers = this.handlers.get(event);
    if (handlers === undefined) return;
    for (const handler of handlers) {
      if (this.closed) return;
      await handler({ type: event }, emptyContext);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.handlers.clear();
    this.events.removeAllListeners();
    this.sink = undefined;
  }
}
