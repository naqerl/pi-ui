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
import { MCP_STATUS_HEAD } from "../shared/notices.js";
import type { ExtensionNotice } from "./mcp-events.js";

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

  readonly customType?: string;
  readonly details?: unknown;
}

export type DurableExtensionSink = (text: string, options: DurableSendOptions) => void;

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

export class DurableExtensionShim implements DurableExtensionApi {
  readonly events = new EventEmitter();
  private readonly installed: ToolRegistration[] = [];
  private readonly extensionTools = new Map<string, DurableExtensionTool>();
  private readonly handlers = new Map<string, DurableExtensionHandler[]>();
  private sink: DurableExtensionSink | undefined;
  private observer: ((notice: ExtensionNotice) => unknown) | undefined;
  private noticeEnricher:
    | ((notice: ExtensionNotice) => ExtensionNotice | Promise<ExtensionNotice>)
    | undefined;
  private closed = false;
  private readonly earlyMessages: Array<[DurableExtensionMessage, DurableSendOptions]> = [];

  setObserver(observer: ((notice: ExtensionNotice) => unknown) | undefined): void {
    this.observer = observer;
  }

  setNoticeEnricher(
    enricher: ((notice: ExtensionNotice) => ExtensionNotice | Promise<ExtensionNotice>) | undefined,
  ): void {
    this.noticeEnricher = enricher;
  }

  get tools(): readonly ToolRegistration[] {
    return this.installed;
  }

  setMessageSink(sink: DurableExtensionSink | undefined): void {
    this.sink = sink;
    if (sink !== undefined) {
      for (const [message, options] of this.earlyMessages.splice(0))
        this.sendMessage(message, options);
    }
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

      deferred: true,
      callers: ["model", "tools"],
      execute: async (args: Static<TSchema>, api, context) => {
        const result = await tool.execute(api.callId, args, context.abortSignal);
        if (tool.name === "mcp_events") {
          let notice: ExtensionNotice = {
            customType: "mcp-events-tool",
            details: {
              args,
              result: result.details ?? null,

              ...(result.isError === true ? { isError: true } : {}),
            },
          };
          if (this.noticeEnricher !== undefined) {
            try {
              notice = await this.noticeEnricher(notice);
            } catch (error) {
              console.error("[mcp] notice enrichment failed", error);
            }
          }
          this.observer?.(notice);
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

  removeTools(names: readonly string[]): void {
    if (names.length === 0) return;
    const removed = new Set(names);
    for (let index = this.installed.length - 1; index >= 0; index -= 1) {
      const tool = this.installed[index];
      if (tool !== undefined && removed.has(tool.name)) this.installed.splice(index, 1);
    }
    for (const name of removed) this.extensionTools.delete(name);
  }

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

  readonly sendMessage = (
    message: DurableExtensionMessage,
    options: DurableSendOptions = {},
  ): void => {
    const kind = message.customType ?? "message";
    if (!this.closed && this.sink === undefined) {
      this.earlyMessages.push([message, options]);
      return;
    }
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
      this.sink(text, {
        ...options,
        ...(message.customType === undefined ? {} : { customType: message.customType }),
        ...(message.details === undefined ? {} : { details: message.details }),
      });
    } catch (error) {
      console.error(`[mcp] ${kind} notice submit failed`, error);
    }
  };

  install(registry: Registry<ToolRegistration>): void {
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
      await handler(
        { type: event },
        {
          ui: {
            notify: (text) =>
              this.sendMessage({
                customType: "mcp-ui-status",
                content: `${MCP_STATUS_HEAD}\n${text}`,
              }),
          },
        },
      );
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
