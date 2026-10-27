import type { AgentSessionEvent, SessionMessageEntry } from "@earendil-works/pi-coding-agent";
import type { ChatMessage, RunState, Snapshot } from "../shared/types.js";
import type { PiSession } from "./pi.js";
import { formatToolArguments, formatToolResult } from "./pi.js";
import type { SseFrame } from "./sse.js";
import { mapSessionEvent } from "./sse.js";
import type { TranscriptStore } from "./store.js";
import type { StreamHub } from "./stream-hub.js";

type StoredMessage = SessionMessageEntry["message"];

interface ActiveTool {
  name: string;
  args: unknown;
  timestamp: string;
}

export class BusyError extends Error {
  constructor() {
    super("A run is already streaming");
    this.name = "BusyError";
  }
}

export class ChatService {
  private runState: RunState = "idle";
  private currentText = "";
  private currentThinking = "";
  private readonly activeTools = new Map<string, ActiveTool>();
  private eventChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly session: PiSession,
    private readonly store: TranscriptStore,
    private readonly hub: StreamHub,
  ) {
    this.session.subscribe((event) => {
      this.eventChain = this.eventChain
        .then(() => this.handleEvent(event))
        .catch((error) => {
          console.error("[pi] event handling failed", error);
        });
    });
  }

  getState(): RunState {
    return this.runState;
  }

  getSnapshot(): Snapshot {
    return { ...this.store.getSnapshot(), run: this.runState };
  }

  replayFrames(): SseFrame[] {
    if (this.runState !== "running") return [];
    const frames: SseFrame[] = [];
    if (this.currentThinking.length > 0) {
      frames.push({ event: "thinking.delta", data: { text: this.currentThinking } });
    }
    if (this.currentText.length > 0) {
      frames.push({ event: "message.delta", data: { text: this.currentText } });
    }
    for (const [toolCallId, tool] of this.activeTools) {
      frames.push({
        event: "tool.start",
        data: {
          toolCallId,
          name: tool.name,
          arguments: tool.args,
          timestamp: tool.timestamp,
        },
      });
    }
    return frames;
  }

  async submit(text: string): Promise<ChatMessage> {
    if (this.runState === "running") throw new BusyError();

    this.runState = "running";
    let message: ChatMessage;
    try {
      message = await this.store.appendUser(text);
    } catch (error) {
      this.runState = "idle";
      throw error;
    }

    this.hub.broadcast({ event: "run.state", data: { state: "running" } });
    void this.execute(text);
    return message;
  }

  async stop(): Promise<void> {
    if (this.runState === "idle") return;
    await this.session.abort();
  }

  private async execute(text: string): Promise<void> {
    try {
      await this.session.prompt(text);
      await this.eventChain;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const message = await this.store.appendAssistantError(`pi run failed: ${reason}`);
      this.hub.broadcast({ event: "message.done", data: { message } });
    } finally {
      this.runState = "idle";
      this.currentText = "";
      this.currentThinking = "";
      this.activeTools.clear();
      this.hub.broadcast({ event: "run.state", data: { state: "idle" } });
    }
  }

  private async handleEvent(event: AgentSessionEvent): Promise<void> {
    if (event.type === "message_start" && event.message.role === "assistant") {
      this.currentText = "";
      this.currentThinking = "";
      return;
    }

    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      if (update.type === "text_delta") this.currentText += update.delta;
      if (update.type === "thinking_delta") this.currentThinking += update.delta;
      this.hub.broadcast(mapSessionEvent(event));
      return;
    }

    if (event.type === "message_end") {
      if (event.message.role === "assistant") {
        const message = await this.store.appendAssistant(event.message as StoredMessage);
        this.currentText = "";
        this.currentThinking = "";
        this.hub.broadcast(mapSessionEvent(event, { assistantMessage: message }));
      } else if (event.message.role === "toolResult") {
        await this.store.appendToolResult(event.message as StoredMessage);
      }
      return;
    }

    if (event.type === "tool_execution_start") {
      this.activeTools.set(event.toolCallId, {
        name: event.toolName,
        args: event.args,
        timestamp: new Date().toISOString(),
      });
      this.hub.broadcast(mapSessionEvent(event));
      return;
    }

    if (event.type === "tool_execution_end") {
      const active = this.activeTools.get(event.toolCallId);
      this.activeTools.delete(event.toolCallId);
      const tool = await this.store.appendTool({
        toolCallId: event.toolCallId,
        name: event.toolName,
        arguments: formatToolArguments(active?.args),
        output: formatToolResult(event.result),
        isError: event.isError,
        durationMs: event.durationMs,
      });
      this.hub.broadcast(mapSessionEvent(event, { toolActivity: tool }));
    }
  }
}
