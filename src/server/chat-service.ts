import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  type AgentEvent,
  type AgentEventStream,
  type Conversation,
  type Harness,
  type SnapshotEvent,
  type Submission,
  watchEvents,
} from "@earendil-works/pi-durable";
import {
  type ChatMessage,
  type MessageMode,
  type QueuedMessage,
  type RunState,
  type Snapshot,
  STEER_ENTRY_KIND,
  type StreamMessageDone,
  type StreamRunState,
  type StreamTextDelta,
  type StreamToolEnd,
  type StreamToolStart,
  type ToolActivity,
} from "../shared/types.js";
import { formatToolArguments, formatToolDetails, formatToolResult } from "./pi.js";
import {
  appendAssistantError,
  assistantMessageFromEntry,
  buildTranscript,
  contextUsage,
  SESSION_CONTEXT,
  summarizeUsage,
  toolActivityFromEntry,
} from "./session.js";
import type { SseFrame } from "./sse.js";
import type { StreamHub } from "./stream-hub.js";

interface ActiveTool {
  name: string;
  args: unknown;
  timestamp: string;
}

interface QueuedRun {
  item: QueuedMessage;
  submission: Submission;
}

export interface SubmittedMessage {
  message: ChatMessage;
  mode: MessageMode;
  queued: boolean;
  placed: boolean;
  queue: QueuedMessage[];
}

export class ChatService {
  private runState: RunState;
  private currentText = "";
  private currentThinking = "";
  private readonly activeTools = new Map<string, ActiveTool>();
  private stream: AgentEventStream | undefined;
  private closed = false;
  private runStartedAt: string | undefined;
  private readonly queued = new Map<string, QueuedRun>();
  private readonly steerSubmissions = new Set<string>();

  constructor(
    private readonly harness: Harness,
    private readonly conversation: Conversation,
    private readonly hub: StreamHub,
    private readonly modelWindow: number | undefined,
    interrupted: boolean,
  ) {
    this.runState = interrupted ? "interrupted" : "idle";
  }

  async start(): Promise<void> {
    this.stream = await watchEvents(this.harness, this.conversation.id, SESSION_CONTEXT);
    this.applySnapshot(this.stream.snapshot);
    this.stream.start((events) => this.handleEvents(events));
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.stream?.stop();
  }

  getState(): RunState {
    return this.runState;
  }

  getRunStatus(): StreamRunState {
    return {
      state: this.runState,
      startedAt: this.runStartedAt ?? null,
      queue: this.queueItems(),
    };
  }

  async getSnapshot(): Promise<Snapshot> {
    const context = await this.conversation.context(SESSION_CONTEXT);
    const usage = await this.harness.usage(SESSION_CONTEXT);
    const transcript = buildTranscript(context.entries);
    return {
      conversationId: String(this.conversation.id),
      messages: transcript.messages,
      activity: transcript.activity,
      run: this.runState,
      ...(this.runStartedAt === undefined ? {} : { runStartedAt: this.runStartedAt }),
      queue: this.queueItems(),
      usage: summarizeUsage(usage),
      context: contextUsage(context.entries, this.modelWindow),
    };
  }

  replayFrames(): SseFrame[] {
    if (this.runState !== "running") return [];
    const frames: SseFrame[] = [];
    if (this.currentThinking.length > 0) {
      frames.push({
        event: "thinking.delta",
        data: { text: this.currentThinking } satisfies StreamTextDelta,
      });
    }
    if (this.currentText.length > 0) {
      frames.push({
        event: "message.delta",
        data: { text: this.currentText } satisfies StreamTextDelta,
      });
    }
    for (const [toolCallId, tool] of this.activeTools) {
      frames.push({
        event: "tool.start",
        data: {
          toolCallId,
          name: tool.name,
          arguments: tool.args,
          timestamp: tool.timestamp,
        } satisfies StreamToolStart,
      });
    }
    return frames;
  }

  async submit(text: string, mode: MessageMode = "queue"): Promise<SubmittedMessage> {
    const steer = mode === "steer";
    const startsRun = this.runState !== "running" && this.queued.size === 0;
    if (startsRun) this.setRunState("running");

    let submission: Submission;
    try {
      submission = await this.conversation.submit(
        {
          type: "input",
          content: text,
          whenBusy: steer ? "steer" : "followUp",
          ...(steer ? { entry: { kind: STEER_ENTRY_KIND } } : {}),
        },
        SESSION_CONTEXT,
      );
    } catch (error) {
      if (startsRun) this.setRunState("idle");
      throw error;
    }

    const id = String(submission.id);
    const queueMode = !steer;
    const queuedInitially = queueMode && !startsRun;
    if (queuedInitially) {
      this.queued.set(id, {
        item: { id, text, createdAt: new Date().toISOString() },
        submission,
      });
      this.broadcastQueue();
    }
    if (steer) this.steerSubmissions.add(id);

    const { message, placed } = await this.submittedMessage(submission, text, steer);
    const queued = queueMode && !placed;
    if (queued && !queuedInitially) {
      this.queued.set(id, {
        item: { id, text, createdAt: new Date().toISOString() },
        submission,
      });
      this.broadcastQueue();
    } else if (!queued && queuedInitially && this.queued.delete(id)) {
      this.broadcastQueue();
    }

    void this.monitorSubmission(submission, startsRun, queued ? id : undefined);
    return { message, mode, queued, placed, queue: this.queueItems() };
  }

  async cancelQueued(id: string): Promise<boolean> {
    const queued = this.queued.get(id);
    if (!queued) return false;
    this.queued.delete(id);
    this.broadcastQueue();
    try {
      await queued.submission.abort(SESSION_CONTEXT);
    } catch (error) {
      console.error("[pi] could not cancel a queued message", error);
    }
    return true;
  }

  async steerQueued(id: string): Promise<SubmittedMessage | null> {
    const queued = this.queued.get(id);
    if (!queued) return null;
    this.queued.delete(id);
    this.broadcastQueue();
    try {
      await queued.submission.abort(SESSION_CONTEXT);
    } catch (error) {
      console.error("[pi] could not move a queued message into the run", error);
    }
    return this.submit(queued.item.text, "steer");
  }

  async stop(): Promise<void> {
    if (this.runState !== "running" && this.queued.size === 0) return;
    const wasRunning = this.runState === "running";
    try {
      await this.conversation.abort(SESSION_CONTEXT);
    } catch (error) {
      console.error("[pi] abort failed", error);
    } finally {
      this.queued.clear();
      this.steerSubmissions.clear();
      if (wasRunning) this.setRunState("idle");
      else this.broadcastQueue();
    }
  }

  private async submittedMessage(
    submission: Submission,
    text: string,
    steer: boolean,
  ): Promise<{ message: ChatMessage; placed: boolean }> {
    const record = await submission.status(SESSION_CONTEXT);
    const entryId = "entry" in record ? record.entry : undefined;
    const placed = record.status === "placed" || record.status === "done";
    if (entryId !== undefined) {
      const context = await this.conversation.context(SESSION_CONTEXT);
      const entry = context.entries.find((candidate) => candidate.id === entryId);
      if (entry) {
        const message = buildTranscript([entry]).messages[0];
        if (message) {
          return {
            message: steer ? { ...message, steer: true } : message,
            placed,
          };
        }
      }
    }

    return {
      message: {
        id: `m-pending-${submission.id}`,
        role: "user",
        text,
        timestamp: new Date().toISOString(),
        order: entryId ?? Number.MAX_SAFE_INTEGER,
        ...(steer ? { steer: true } : {}),
      },
      placed,
    };
  }

  private async monitorSubmission(
    submission: Submission,
    startsRun: boolean,
    queuedId: string | undefined,
  ): Promise<void> {
    try {
      const settled = await submission.wait(SESSION_CONTEXT);
      if (settled.status === "unanswered") {
        console.warn(
          `[pi] run ${submission.id} ended without an answer: ${settled.reason}` +
            (settled.detail === undefined ? "" : ` (${JSON.stringify(settled.detail)})`),
        );
        if (settled.reason === "no_model") {
          await this.appendNoModelMessage();
        }
      }
    } catch (error) {
      console.error("[pi] submission wait failed", error);
    } finally {
      this.steerSubmissions.delete(String(submission.id));
      if (queuedId !== undefined && this.queued.delete(queuedId)) {
        this.broadcastQueue();
      }
      if (startsRun && this.queued.size === 0) this.setRunState("idle");
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

  private async handleEvents(events: readonly AgentEvent[]): Promise<void> {
    for (const event of events) {
      if (this.closed) return;
      try {
        await this.handleEvent(event);
      } catch (error) {
        console.error("[pi] event handling failed", error);
      }
    }
  }

  private async handleEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "snapshot": {
        this.applySnapshot(event);
        const frames: SseFrame[] = [
          {
            event: "message.done",
            data: { message: null } satisfies StreamMessageDone,
          },
        ];
        if (this.currentThinking.length > 0) {
          frames.push({
            event: "thinking.delta",
            data: { text: this.currentThinking } satisfies StreamTextDelta,
          });
        }
        if (this.currentText.length > 0) {
          frames.push({
            event: "message.delta",
            data: { text: this.currentText } satisfies StreamTextDelta,
          });
        }
        frames.push({
          event: "run.state",
          data: this.getRunStatus() satisfies StreamRunState,
        });
        this.hub.broadcast(frames);
        return;
      }

      case "run_start":
        this.setRunState("running");
        return;

      case "run_end":
        this.setRunState("idle");
        return;

      case "message_start":
        if (event.message.role === "assistant") {
          this.currentText = "";
          this.currentThinking = "";
          this.absorbMessage(event.message);
        }
        return;

      case "message_update":
        for (const change of event.changes) {
          if (change.type === "text_delta") {
            this.currentText += change.delta;
            this.hub.broadcast({
              event: "message.delta",
              data: { text: change.delta } satisfies StreamTextDelta,
            });
          } else if (change.type === "thinking_delta") {
            this.currentThinking += change.delta;
            this.hub.broadcast({
              event: "thinking.delta",
              data: { text: change.delta } satisfies StreamTextDelta,
            });
          } else if (change.type === "block") {
            if (change.block.type === "text") {
              this.currentText = change.block.text;
            } else if (change.block.type === "thinking") {
              this.currentThinking = change.block.thinking;
            }
          } else if (change.type === "message") {
            this.absorbMessage(change.message);
          }
        }
        return;

      case "message_end": {
        const message = assistantMessageFromEntry(event.entry);
        if (!message) return;
        this.currentText = "";
        this.currentThinking = "";
        this.hub.broadcast({
          event: "message.done",
          data: { message } satisfies StreamMessageDone,
        });
        return;
      }

      case "tool_execution_start": {
        if (event.parentToolCallId !== undefined) return;
        const timestamp = new Date().toISOString();
        this.activeTools.set(event.toolCallId, {
          name: event.toolName,
          args: event.args,
          timestamp,
        });
        this.hub.broadcast({
          event: "tool.start",
          data: {
            toolCallId: event.toolCallId,
            name: event.toolName,
            arguments: event.args,
            timestamp,
          } satisfies StreamToolStart,
        });
        return;
      }

      case "tool_execution_end": {
        if (event.parentToolCallId !== undefined) return;
        const active = this.activeTools.get(event.toolCallId);
        this.activeTools.delete(event.toolCallId);
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
          } satisfies StreamToolEnd,
        });
        return;
      }

      case "submission": {
        const id = String(event.record.id);
        if (event.record.type !== "input") return;
        if (event.record.status === "placed") {
          const wasQueued = this.queued.delete(id);
          const wasSteered = this.steerSubmissions.delete(id);
          if (wasQueued) this.broadcastQueue();
          if (wasQueued || wasSteered) {
            this.hub.broadcast({
              event: "message.done",
              data: { message: null } satisfies StreamMessageDone,
            });
          }
        } else if (event.record.status === "done" || event.record.status === "unanswered") {
          if (this.queued.delete(id)) this.broadcastQueue();
          this.steerSubmissions.delete(id);
        }
        return;
      }

      case "entry_appended":
        if (event.entry.kind === STEER_ENTRY_KIND) {
          this.hub.broadcast({
            event: "message.done",
            data: { message: null } satisfies StreamMessageDone,
          });
        }
        return;

      case "task_failed":
        console.error(`[pi] ${event.kind} task ${event.taskId} failed: ${event.message}`);
        return;

      case "compaction_start":
        console.log(`[pi] compaction started (${event.reason})`);
        return;

      case "compaction_end":
        if (event.error) console.error(`[pi] compaction failed: ${event.error}`);
        else console.log(`[pi] compaction finished (${event.reason})`);
        return;

      case "auto_retry_start":
        console.warn(
          `[pi] retrying the model request (attempt ${event.attempt}): ${event.errorMessage}`,
        );
        return;

      default:
        return;
    }
  }

  private applySnapshot(snapshot: SnapshotEvent): void {
    this.currentText = "";
    this.currentThinking = "";
    const partial = snapshot.generation?.message;
    if (partial) {
      this.absorbMessage(partial);
    }

    this.activeTools.clear();
    for (const slot of snapshot.tools) {
      if (slot.status === "done") continue;
      this.activeTools.set(slot.callId, {
        name: slot.name,
        args: {},
        timestamp: new Date().toISOString(),
      });
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
    event: Extract<AgentEvent, { type: "tool_execution_end" }>,
    active: ActiveTool | undefined,
  ): ToolActivity {
    if (event.entry) {
      const activity = toolActivityFromEntry(event.entry, active?.args);
      if (activity) return activity;
    }

    const result = event.result;
    return {
      kind: "tool",
      id: `local-${event.toolCallId}`,
      name: event.toolName,
      arguments: formatToolArguments(active?.args),
      output: result ? formatToolResult(result) : "The tool did not finish.",
      details: formatToolDetails(result?.details),
      isError: result?.isError ?? true,
      durationMs: result?.durationMs,
      timestamp: new Date().toISOString(),
      order: Number.MAX_SAFE_INTEGER,
    };
  }

  private queueItems(): QueuedMessage[] {
    return [...this.queued.values()].map((entry) => entry.item);
  }

  private broadcastQueue(): void {
    this.hub.broadcast({
      event: "run.state",
      data: this.getRunStatus(),
    });
  }

  private setRunState(state: RunState): void {
    if (this.runState === state) return;
    this.runState = state;
    if (state === "running") {
      this.runStartedAt = new Date().toISOString();
    } else {
      this.runStartedAt = undefined;
      this.currentText = "";
      this.currentThinking = "";
      this.activeTools.clear();
    }
    this.hub.broadcast({
      event: "run.state",
      data: this.getRunStatus(),
    });
  }
}
