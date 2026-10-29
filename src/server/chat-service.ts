import { randomUUID } from "node:crypto";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
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
  type McpEventsState,
  type McpStatus,
  type MessageMode,
  type ModelList,
  type ModelOption,
  type QueuedMessage,
  type RunState,
  type Snapshot,
  STEER_ENTRY_KIND,
  type StreamDraftSync,
  type StreamMessageDone,
  type StreamRunState,
  type StreamTextDelta,
  type StreamToolEnd,
  type StreamToolStart,
  type ToolActivity,
} from "../shared/types.js";
import type { BillionContextInline } from "./billion-context.js";
import type { McpEventFeed } from "./mcp-events.js";
import { listAvailableModels, modelOption } from "./models.js";
import { formatToolArguments, formatToolDetails, formatToolResult } from "./pi.js";
import type { RunMarker, RunMarkerStore } from "./run-marker.js";
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

interface SubmitOptions {
  /** Durable deduplication key, used by recovery and queue restoration. */
  requestId?: string;
  /** Reuse the interrupted run's marker instead of starting a fresh one. */
  resume?: boolean;
}

const CONTINUATION_TEXT =
  "Continue from where the previous response was interrupted. Do not repeat what is already complete.";

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
  private draftRevision = 0;
  private eventFeed: McpEventFeed | undefined;
  private readonly activeTools = new Map<string, ActiveTool>();
  private stream: AgentEventStream | undefined;
  private closed = false;
  private runStartedAt: string | undefined;
  private readonly queued = new Map<string, QueuedRun>();
  private readonly steerSubmissions = new Set<string>();
  private marker: RunMarker | undefined;
  private markerWrites: Promise<void> = Promise.resolve();
  private shuttingDown = false;
  private modelWindow: number | undefined;
  private selected: ModelOption | null;

  constructor(
    private readonly harness: Harness,
    private readonly conversation: Conversation,
    private readonly hub: StreamHub,
    modelWindow: number | undefined,
    interrupted: boolean,
    private readonly markerStore: RunMarkerStore,
    initialMarker: RunMarker | undefined,
    private readonly mcp: McpStatus,
    private readonly catalog: ModelRuntime,
    initialModel: Model<Api> | undefined,
    private readonly bili: BillionContextInline,
  ) {
    this.runState = interrupted ? "interrupted" : "idle";
    this.modelWindow = modelWindow;
    this.selected = initialModel === undefined ? null : modelOption(initialModel);
    this.marker = initialMarker;
    if (interrupted) {
      this.runStartedAt = initialMarker?.startedAt;
    }
  }

  async start(): Promise<void> {
    this.stream = await watchEvents(this.harness, this.conversation.id, SESSION_CONTEXT);
    this.applySnapshot(this.stream.snapshot);
    this.stream.start((events) => this.handleEvents(events));
    await this.autoContinueInterruptedRun();
    await this.restorePersistedQueue();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.stream?.stop();
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

  mcpEventsState(): McpEventsState {
    return this.eventFeed?.state ?? { subscriptions: [], events: [], notice: null, revision: 0 };
  }

  getRunStatus(): StreamRunState {
    return {
      state: this.runState,
      startedAt: this.runStartedAt ?? null,
      queue: this.queueItems(),
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
      mcp: this.mcp,
      mcpEvents: this.mcpEventsState(),
      draft: {
        text: this.currentText,
        thinking: this.currentThinking,
        revision: this.draftRevision,
      },
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
        text: this.currentText,
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
        text: this.currentThinking,
        full: this.currentThinking,
        revision,
      } satisfies StreamTextDelta,
    });
  }

  replayFrames(): SseFrame[] {
    const frames: SseFrame[] = [
      {
        event: "draft.sync",
        data: {
          text: this.currentText,
          thinking: this.currentThinking,
          revision: this.draftRevision,
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
    const steer = mode === "steer";
    const startsRun = this.runState !== "running" && this.queued.size === 0;
    const resumeMarker = startsRun && options.resume === true ? this.marker : undefined;
    const startedAt = resumeMarker?.startedAt ?? new Date().toISOString();
    if (startsRun) {
      const marker: RunMarker = {
        version: 1,
        userMessage: resumeMarker?.userMessage ?? text,
        startedAt,
        mode: resumeMarker?.mode ?? mode,
        stopRequested: false,
        idempotencyKey: resumeMarker?.idempotencyKey ?? randomUUID(),
        autoContinued: resumeMarker?.autoContinued ?? false,
        queue: resumeMarker?.queue ?? this.queueItems(),
        partialEntryId: resumeMarker?.partialEntryId ?? null,
        updatedAt: new Date().toISOString(),
      };
      this.marker = marker;
      await this.writeMarker(marker);
      this.setRunState("running", startedAt);
    }

    let submission: Submission;
    try {
      submission = await this.conversation.submit(
        {
          type: "input",
          content: text,
          whenBusy: steer ? "steer" : "followUp",
          ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
          ...(steer ? { entry: { kind: STEER_ENTRY_KIND } } : {}),
        },
        SESSION_CONTEXT,
      );
    } catch (error) {
      if (startsRun) this.setRunState(this.marker === undefined ? "idle" : "interrupted");
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
      await this.persistMarkerState();
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
      await this.persistMarkerState();
      this.broadcastQueue();
    } else if (!queued && queuedInitially && this.queued.delete(id)) {
      await this.persistMarkerState();
      this.broadcastQueue();
    }

    void this.monitorSubmission(submission, startsRun, queued ? id : undefined);
    return { message, mode, queued, placed, queue: this.queueItems() };
  }

  async cancelQueued(id: string): Promise<boolean> {
    const queued = this.queued.get(id);
    if (!queued) return false;
    this.queued.delete(id);
    await this.persistMarkerState();
    this.broadcastQueue();
    try {
      await queued.submission.abort(SESSION_CONTEXT);
    } catch (error) {
      console.error("[pi] could not cancel a queued message", error);
    }
    this.maybeClearMarker();
    return true;
  }

  async steerQueued(id: string): Promise<SubmittedMessage | null> {
    const queued = this.queued.get(id);
    if (!queued) return null;
    this.queued.delete(id);
    await this.persistMarkerState();
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
    if (wasRunning && this.marker !== undefined) {
      this.marker = {
        ...this.marker,
        stopRequested: true,
        updatedAt: new Date().toISOString(),
      };
      await this.writeMarker(this.marker);
    }
    try {
      await this.conversation.abort(SESSION_CONTEXT);
    } catch (error) {
      console.error("[pi] abort failed", error);
    } finally {
      this.queued.clear();
      this.steerSubmissions.clear();
      if (wasRunning) {
        this.setRunState("idle");
      } else {
        await this.persistMarkerState();
        this.broadcastQueue();
      }
    }
  }

  private async autoContinueInterruptedRun(): Promise<void> {
    const marker = this.marker;
    if (
      marker === undefined ||
      marker.stopRequested ||
      marker.autoContinued ||
      this.runState === "running"
    ) {
      return;
    }

    const next: RunMarker = {
      ...marker,
      autoContinued: true,
      updatedAt: new Date().toISOString(),
    };
    this.marker = next;
    await this.writeMarker(next);
    try {
      await this.submit(CONTINUATION_TEXT, "steer", {
        requestId: `run-continuation:${marker.idempotencyKey}`,
        resume: true,
      });
    } catch (error) {
      console.error("[pi] could not continue the interrupted run", error);
    }
  }

  private async restorePersistedQueue(): Promise<void> {
    const marker = this.marker;
    if (marker === undefined || marker.stopRequested) return;
    for (const item of marker.queue) {
      try {
        await this.submit(item.text, "queue", {
          requestId: `run-queue:${marker.idempotencyKey}:${item.id}`,
        });
      } catch (error) {
        console.error("[pi] could not restore a queued message", error);
      }
    }
  }

  private async persistMarkerState(): Promise<void> {
    const marker = this.marker;
    if (marker === undefined) return;
    const next: RunMarker = {
      ...marker,
      queue: this.queueItems(),
      updatedAt: new Date().toISOString(),
    };
    this.marker = next;
    await this.writeMarker(next);
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
    this.markerWrites = this.markerWrites
      .then(() => this.markerStore.clear())
      .catch((error: unknown) => {
        console.error("[pi] could not clear the run marker", error);
      });
    await this.markerWrites;
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
        await this.persistMarkerState();
        this.broadcastQueue();
      }
      if (startsRun && this.queued.size === 0) this.setRunState("idle");
      else this.maybeClearMarker();
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
        if (this.currentThinking.length > 0 || this.currentText.length > 0) {
          frames.push({
            event: "draft.sync",
            data: {
              text: this.currentText,
              thinking: this.currentThinking,
              revision: this.draftRevision,
            } satisfies StreamDraftSync,
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
            this.broadcastText();
          } else if (change.type === "thinking_delta") {
            this.currentThinking += change.delta;
            this.broadcastThinking();
          } else if (change.type === "block") {
            if (change.block.type === "text") {
              this.currentText = change.block.text;
              this.broadcastText();
            } else if (change.block.type === "thinking") {
              this.currentThinking = change.block.thinking;
              this.broadcastThinking();
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
        const revision = this.bumpDraft();
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
          if (wasQueued) {
            await this.persistMarkerState();
            this.broadcastQueue();
          }
          if (wasQueued || wasSteered) {
            this.hub.broadcast({
              event: "message.done",
              data: { message: null } satisfies StreamMessageDone,
            });
          }
        } else if (event.record.status === "done" || event.record.status === "unanswered") {
          if (this.queued.delete(id)) {
            await this.persistMarkerState();
            this.broadcastQueue();
          }
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

  private maybeClearMarker(): void {
    if (this.runState === "idle" && !this.shuttingDown && this.queued.size === 0) {
      void this.clearMarker();
    }
  }

  private setRunState(state: RunState, startedAt?: string): void {
    if (this.runState === state) {
      this.maybeClearMarker();
      return;
    }
    this.runState = state;
    if (state === "running") {
      this.runStartedAt = startedAt ?? new Date().toISOString();
    } else {
      if (state === "idle") this.runStartedAt = undefined;
      this.currentText = "";
      this.currentThinking = "";
      this.activeTools.clear();
    }
    this.maybeClearMarker();
    this.hub.broadcast({
      event: "run.state",
      data: this.getRunStatus(),
    });
  }
}
