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
  private readonly handlers = new Map<string, DurableExtensionHandler[]>();
  private sink: DurableExtensionSink | undefined;
  private closed = false;

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
      async execute(args: Static<TSchema>, api, context) {
        const result = await tool.execute(api.callId, args, context.abortSignal);
        return {
          output: result.content,
          details: result.details as unknown as ToolExecutionResult["details"],
          ...(result.isError === true ? { isError: true } : {}),
        };
      },
    });
    this.installed.push(registration);
  }

  on(event: string, handler: DurableExtensionHandler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }

  sendMessage(message: DurableExtensionMessage, options: DurableSendOptions = {}): void {
    if (this.closed) return;
    const text = messageText(message);
    if (text.length === 0) return;
    this.sink?.(text, options);
  }

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
