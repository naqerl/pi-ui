import { randomUUID } from "node:crypto";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type AgentEvent,
  type AgentEventStream,
  type Conversation,
  type EntryRecord,
  type Harness,
  type InputEntry,
  type SettledSubmissionRecord,
  type SnapshotEvent,
  type Submission,
  type SubmissionId,
  watchEvents,
} from "@earendil-works/pi-durable";
import { parseNotice } from "../shared/notices.js";
import {
  QUIET_AFTER_MS as DEFAULT_QUIET_AFTER_MS,
  type DurableRunFacts,
  reconcileRunState,
} from "../shared/run-health.js";
import { steerDropReason, steerFromInboxItem } from "../shared/steers.js";
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
  type StreamActivity,
  type StreamDraftSync,
  type StreamMessageDone,
  type StreamRunState,
  type StreamSteerDropped,
  type StreamTextDelta,
  type StreamToolEnd,
  type StreamToolStart,
  type ToolActivity,
  type TranscriptHistory,
} from "../shared/types.js";
import type { BillionContextInline } from "./billion-context.js";
import type { McpEventFeed } from "./mcp-events.js";
import { MEDIA_TYPES, MediaError, type MediaStore } from "./media.js";
import { listAvailableModels, modelOption } from "./models.js";
import { formatToolArguments, formatToolDetails, formatToolResult } from "./pi.js";
import type { RunMarker, RunMarkerStore } from "./run-marker.js";
import {
  appendAssistantError,
  appendJobNotice,
  assistantMessageFromEntry,
  buildTranscript,
  contextUsage,
  type DiagramRevisionResolver,
  JOB_NOTICE_ENTRY_KIND,
  SESSION_CONTEXT,
  summarizeUsage,
  toolActivityFromEntry,
} from "./session.js";
import type { SseFrame } from "./sse.js";
import type { StreamHub } from "./stream-hub.js";
import {
  cachedSummary,
  isSummarizableText,
  setSummaryModel,
  summaryForMessage,
} from "./summary.js";
import { type WindowRequest, windowTranscript } from "./transcript-window.js";

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
  /** Media ids sent as images after the text. */
  attachments?: string[];
  /** Place an input as this application entry instead of a normal user entry. */
  entry?: InputEntry;
}

/** `PI_UI_QUIET_AFTER_MS` shortens the quiet threshold for tests. */
export const QUIET_AFTER_MS = positiveEnv("PI_UI_QUIET_AFTER_MS") ?? DEFAULT_QUIET_AFTER_MS;
const WATCHDOG_INTERVAL_MS = Math.min(10_000, QUIET_AFTER_MS);
const STREAM_RETRY_MS = 1_000;

function positiveEnv(name: string): number | undefined {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

export interface SubmittedMessage {
  message: ChatMessage;
  mode: MessageMode;
  queued: boolean;
  placed: boolean;
  queue: QueuedMessage[];
  steers: QueuedMessage[];
}

export class ChatService {
  private runState: RunState;
  private currentText = "";
  private currentThinking = "";
  private draftRevision = 0;
  private toolsRevision = 0;
  private eventFeed: McpEventFeed | undefined;
  private readonly activeTools = new Map<string, ActiveTool>();
  private stream: AgentEventStream | undefined;
  private closed = false;
  /** When the agent's event stream last delivered anything; see `QUIET_AFTER_MS`. */
  private lastEventAt = Date.now();
  /** Submissions sent to durable that it has not recorded yet. */
  private submitting = 0;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private checkingRun = false;
  private quietLogged = false;
  private readonly queued = new Map<string, QueuedRun>();
  /** Steers durable holds in its inbox for the next turn boundary, by submission id. */
  private readonly steers = new Map<string, QueuedMessage>();
  private marker: RunMarker | undefined;
  private markerWrites: Promise<void> = Promise.resolve();
  private shuttingDown = false;
  private modelWindow: number | undefined;
  private selected: ModelOption | null;
  /** The last completed assistant reply this turn, summarised once the run goes idle. */
  private summaryCandidate: ChatMessage | undefined;
  /** Read on every snapshot, so a server may recover after its boot probe fails. */
  private readonly mcpStatus: () => McpStatus;

  constructor(
    private readonly harness: Harness,
    private readonly conversation: Conversation,
    private readonly hub: StreamHub,
    modelWindow: number | undefined,
    interrupted: boolean,
    private readonly markerStore: RunMarkerStore,
    initialMarker: RunMarker | undefined,
    mcpStatus: McpStatus | (() => McpStatus),
    private readonly catalog: ModelRuntime,
    initialModel: Model<Api> | undefined,
    private readonly bili: BillionContextInline,
    private readonly media: MediaStore,
    /** Refresh the injected memory block at a turn/compaction checkpoint. */
    private readonly beforeTurn: (reason?: string) => Promise<void> = async () => undefined,
    /** Reads a stored diagram's current revision for the transcript's message part. */
    private readonly diagramRevision: DiagramRevisionResolver = () => undefined,
  ) {
    this.mcpStatus = typeof mcpStatus === "function" ? mcpStatus : () => mcpStatus;
    this.runState = interrupted ? "interrupted" : "idle";
    this.modelWindow = modelWindow;
    this.selected = initialModel === undefined ? null : modelOption(initialModel);
    setSummaryModel(this.catalog, initialModel);
    this.marker = initialMarker;
  }

  /**
   * pi-ai swaps images for an "image omitted" note when the model is text-only, so the agent
   * would never see them. Refuse up front instead. With no model chosen the run fails anyway.
   */
  private assertAcceptsImages(): void {
    if (this.selected === null) return;
    const model = this.catalog.getModel(this.selected.provider, this.selected.id);
    if (model === undefined || model.input.includes("image")) return;
    throw new MediaError(`${this.selected.name} does not accept images`, 400);
  }

  private readonly mediaRef = (data: string, mimeType: string) => this.media.refFor(data, mimeType);

  async start(): Promise<void> {
    const stream = await watchEvents(this.harness, this.conversation.id, SESSION_CONTEXT);
    this.stream = stream;
    this.applySnapshot(stream.snapshot);
    if (stream.snapshot.run !== undefined) {
      this.setRunState("running");
    }
    stream.start((events) => this.handleEvents(events));
    this.watchStreamEnd(stream);
    this.watchdog = setInterval(() => void this.checkQuietRun(), WATCHDOG_INTERVAL_MS);
    this.watchdog.unref?.();
    await this.restorePersistedQueue();
    await this.restorePendingSteers();
    // Durable carries a turn across a restart from its committed checkpoint. A
    // stop requested before the restart was settled in recovery, so leave it be.
    if (this.marker?.stopRequested !== true) this.harness.resume();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.watchdog !== undefined) clearInterval(this.watchdog);
    await this.stream?.stop();
  }

  /**
   * The event stream is the only thing that ends a run in this server. When durable ends it
   * (a failed Session, a listener error), attach a new one; its snapshot settles the run state.
   */
  private watchStreamEnd(stream: AgentEventStream): void {
    void stream.closed.then((end) => {
      if (this.closed || stream !== this.stream) return;
      console.error(
        `[pi] agent event stream ended (${end.reason}); reattaching`,
        "error" in end ? end.error : "",
      );
      void this.reattachStream();
    });
  }

  private async reattachStream(): Promise<void> {
    while (!this.closed) {
      await new Promise((resolve) => setTimeout(resolve, STREAM_RETRY_MS));
      if (this.closed) return;
      try {
        const stream = await watchEvents(this.harness, this.conversation.id, SESSION_CONTEXT);
        this.stream = stream;
        await this.handleEvent(stream.snapshot);
        stream.start((events) => this.handleEvents(events));
        this.watchStreamEnd(stream);
        console.log("[pi] agent event stream reattached");
        return;
      } catch (error) {
        console.error("[pi] could not reattach the agent event stream", error);
      }
    }
  }

  /**
   * A run that has been quiet for `QUIET_AFTER_MS` is checked against durable's live state, so a
   * lost end event cannot leave the chat working forever. A run durable still has stays running.
   */
  private async checkQuietRun(): Promise<void> {
    if (this.closed || this.checkingRun || this.runState !== "running") {
      this.quietLogged = false;
      return;
    }
    const quietMs = Date.now() - this.lastEventAt;
    if (quietMs < QUIET_AFTER_MS) {
      this.quietLogged = false;
      return;
    }
    this.checkingRun = true;
    try {
      const facts = await this.durableRunFacts();
      if (!this.quietLogged) {
        this.quietLogged = true;
        console.warn(
          `[pi] no agent events for ${Math.round(quietMs / 1_000)}s while running ` +
            `(durable run: ${facts.run ? "live" : "none"}, inbox: ${facts.inbox}, submitting: ${facts.submitting})`,
        );
      }
      this.reconcileRun(facts);
    } catch (error) {
      console.error("[pi] could not check the run state", error);
    } finally {
      this.checkingRun = false;
    }
  }

  private async durableRunFacts(): Promise<DurableRunFacts> {
    const state = await this.conversation.viewState(SESSION_CONTEXT);
    try {
      const live = state.value.docs["pi.live"] as { run?: unknown } | undefined;
      const inbox = state.value.docs["pi.inbox"] as { items?: unknown[] } | undefined;
      return {
        run: live?.run !== undefined && live.run !== null,
        inbox: inbox?.items?.length ?? 0,
        submitting: this.submitting,
      };
    } finally {
      state.dispose();
    }
  }

  private reconcileRun(facts: DurableRunFacts): void {
    // Our own queue still waits on durable, so it keeps the run alive too.
    const next = reconcileRunState(this.runState, {
      ...facts,
      inbox: facts.inbox + this.queued.size,
    });
    if (next === this.runState) return;
    console.warn(`[pi] run state reconciled with durable: ${this.runState} -> ${next}`);
    this.setRunState(next);
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
      queue: this.queueItems(),
      steers: this.steerItems(),
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
      setSummaryModel(this.catalog, model);
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

  /** One page of older transcript, ending just below `request.before`. */
  async getHistory(request: WindowRequest): Promise<TranscriptHistory> {
    const context = await this.conversation.context(SESSION_CONTEXT);
    const transcript = buildTranscript(context.entries, this.mediaRef, this.diagramRevision);
    return windowTranscript(
      { ...transcript, messages: this.withSummaries(transcript.messages) },
      request,
    );
  }

  /** Usage, context and MCP status without building the transcript window. */
  async statsSnapshot(): Promise<Pick<Snapshot, "usage" | "context" | "mcp" | "conversationId">> {
    const context = await this.conversation.context(SESSION_CONTEXT);
    const usage = await this.harness.usage(SESSION_CONTEXT);
    return {
      conversationId: String(this.conversation.id),
      usage: summarizeUsage(usage),
      context: contextUsage(context.entries, this.modelWindow),
      mcp: this.mcpStatus(),
    };
  }

  async getSnapshot(request: WindowRequest = {}): Promise<Snapshot> {
    const context = await this.conversation.context(SESSION_CONTEXT);
    const usage = await this.harness.usage(SESSION_CONTEXT);
    const built = buildTranscript(context.entries, this.mediaRef, this.diagramRevision);
    const transcript = windowTranscript(
      { ...built, messages: this.withSummaries(built.messages) },
      request.before === undefined ? request : {},
    );
    return {
      conversationId: String(this.conversation.id),
      messages: transcript.messages,
      activity: transcript.activity,
      from: transcript.from,
      hasEarlier: transcript.hasEarlier,
      run: this.runState,
      queue: this.queueItems(),
      steers: this.steerItems(),
      usage: summarizeUsage(usage),
      context: contextUsage(context.entries, this.modelWindow),
      mcp: this.mcpStatus(),
      mcpEvents: this.mcpEventsState(),
      draft: {
        text: this.currentText,
        thinking: this.currentThinking,
        revision: this.draftRevision,
      },
      activeTools: this.activeToolActivities(),
      toolsRevision: this.toolsRevision,
    };
  }

  private bumpDraft(): number {
    this.draftRevision += 1;
    return this.draftRevision;
  }

  private withSummary(message: ChatMessage): ChatMessage {
    const summary = cachedSummary(message.id);
    return typeof summary === "string" ? { ...message, summary } : message;
  }

  private withSummaries(messages: ChatMessage[]): ChatMessage[] {
    return messages.map((message) => this.withSummary(message));
  }

  /** Lazily fills a summary from the client when the automatic pass has not done it yet. */
  async getSummary(messageId: string): Promise<string | null> {
    const cached = cachedSummary(messageId);
    if (cached !== undefined) return cached;
    const context = await this.conversation.context(SESSION_CONTEXT);
    const message = buildTranscript(
      context.entries,
      this.mediaRef,
      this.diagramRevision,
    ).messages.find((candidate) => candidate.id === messageId);
    if (message === undefined || message.role !== "assistant" || message.isError === true) {
      return null;
    }
    return summaryForMessage(message.id, message.text);
  }

  /** Fire-and-forget after the run: a slow or missing model just leaves the summary out. */
  private summarizeCompletedTurn(): void {
    const message = this.summaryCandidate;
    this.summaryCandidate = undefined;
    if (
      message === undefined ||
      message.isError === true ||
      !isSummarizableText(message.text) ||
      cachedSummary(message.id) !== undefined
    ) {
      return;
    }
    void summaryForMessage(message.id, message.text).then((summary) => {
      if (summary === null) return;
      this.hub.broadcast({
        event: "message.done",
        data: { message: { ...message, summary } } satisfies StreamMessageDone,
      });
    });
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

  private publishDraft(previousText: string, previousThinking: string): void {
    if (this.currentText !== previousText) this.broadcastText();
    if (this.currentThinking !== previousThinking) this.broadcastThinking();
  }

  private activeToolActivities(): ToolActivity[] {
    const items: ToolActivity[] = [];
    for (const [toolCallId, tool] of this.activeTools) {
      items.push({
        kind: "tool",
        id: `live-${toolCallId}`,
        name: tool.name,
        arguments: formatToolArguments(tool.args),
        isError: false,
        timestamp: tool.timestamp,
        order: Number.MAX_SAFE_INTEGER - 1,
        pending: true,
      });
    }
    return items;
  }

  replayFrames(): SseFrame[] {
    const revision = this.bumpDraft();
    const frames: SseFrame[] = [
      {
        event: "draft.sync",
        data: {
          text: this.currentText,
          thinking: this.currentThinking,
          revision,
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
          toolsRevision: this.toolsRevision,
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
    const attachments = options.attachments ?? [];
    if (attachments.length > 0) this.assertAcceptsImages();
    // Read the images first, so an unknown id fails before the run state changes.
    const images = await this.media.images(attachments);
    const content =
      images.length === 0
        ? text
        : [...(text.length > 0 ? [{ type: "text" as const, text }] : []), ...images];
    // The memory snapshot is keyed on a stable prefix. Refresh it at the turn
    // boundary: a day rollover or long-term write reconfigures instructions;
    // daily and scratchpad writes leave the cached block untouched.
    await this.beforeTurn();
    const startsRun = this.runState !== "running" && this.queued.size === 0;
    const startedAt = new Date().toISOString();
    const steerKey = steer ? randomUUID() : undefined;
    if (startsRun) {
      this.summaryCandidate = undefined;
      const marker: RunMarker = {
        version: 1,
        userMessage: text,
        startedAt,
        mode,
        stopRequested: false,
        idempotencyKey: randomUUID(),
        queue: this.queueItems(),
        partialEntryId: null,
        updatedAt: new Date().toISOString(),
      };
      this.marker = marker;
      await this.writeMarker(marker);
      this.setRunState("running");
    }

    let submission: Submission;
    this.submitting += 1;
    try {
      submission = await this.conversation.submit(
        {
          type: "input",
          content,
          whenBusy: steer ? "steer" : "followUp",
          ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
          ...(steer
            ? {
                entry: {
                  kind: STEER_ENTRY_KIND,
                  data: {
                    ...(steerKey === undefined ? {} : { key: steerKey }),
                    createdAt: startedAt,
                  },
                },
              }
            : options.entry === undefined
              ? {}
              : { entry: options.entry }),
        },
        SESSION_CONTEXT,
      );
    } catch (error) {
      if (startsRun) this.setRunState(this.marker === undefined ? "idle" : "interrupted");
      throw error;
    } finally {
      this.submitting -= 1;
    }

    const id = String(submission.id);
    const queueMode = !steer;
    const queuedInitially = queueMode && !startsRun;
    if (queuedInitially) {
      this.queued.set(id, {
        item: {
          id,
          text,
          createdAt: new Date().toISOString(),
          ...(attachments.length > 0 ? { attachments } : {}),
        },
        submission,
      });
      await this.persistMarkerState();
      this.broadcastQueue();
    }
    if (steer) {
      this.steers.set(id, {
        id,
        text,
        createdAt: new Date().toISOString(),
        ...(steerKey === undefined ? {} : { key: steerKey }),
        ...(attachments.length > 0 ? { attachments } : {}),
      });
    }

    const { message, placed } = await this.submittedMessage(
      submission,
      text,
      steer,
      attachments,
      steerKey,
    );
    // An idle steer is already in the transcript; the response carries it, so no pending bubble
    // is left behind. A queued steer stays tracked until its entry is actually appended.
    if (steer && placed) this.steers.delete(id);
    if (steer) this.broadcastQueue();
    const queued = queueMode && !placed;
    if (queued && !queuedInitially) {
      this.queued.set(id, {
        item: {
          id,
          text,
          createdAt: new Date().toISOString(),
          ...(attachments.length > 0 ? { attachments } : {}),
        },
        submission,
      });
      await this.persistMarkerState();
      this.broadcastQueue();
    } else if (!queued && queuedInitially && this.queued.delete(id)) {
      await this.persistMarkerState();
      this.broadcastQueue();
    }

    void this.monitorSubmission(submission, startsRun, queued ? id : undefined);
    return { message, mode, queued, placed, queue: this.queueItems(), steers: this.steerItems() };
  }

  async cancelQueued(id: string): Promise<boolean> {
    const queued = this.queued.get(id);
    if (!queued) return false;
    this.queued.delete(id);
    await this.persistMarkerState();
    this.broadcastQueue();
    const aborted = await this.withdraw(id, "cancel a queued message");
    this.maybeClearMarker();
    return aborted;
  }

  /**
   * Takes back a steer durable has not placed yet and returns it, so its text can go back to the
   * composer. Null when it is unknown or already in the transcript; a delivered steer stays.
   */
  async unsendSteer(id: string): Promise<QueuedMessage | null> {
    const item = this.steers.get(id);
    if (item === undefined) return null;
    const aborted = await this.withdraw(id, "take back a steer");
    this.steers.delete(id);
    this.broadcastQueue();
    return aborted ? item : null;
  }

  /** Withdraws a submission still in durable's inbox; false when it was placed or settled. */
  private async withdraw(id: string, what: string): Promise<boolean> {
    try {
      const result = await this.harness.abortSubmission(
        Number(id) as SubmissionId,
        SESSION_CONTEXT,
        this.conversation.id,
      );
      return result === "aborted";
    } catch (error) {
      console.error(`[pi] could not ${what}`, error);
      return false;
    }
  }

  async steerQueued(id: string): Promise<SubmittedMessage | null> {
    const queued = this.queued.get(id);
    if (!queued) return null;
    this.queued.delete(id);
    await this.persistMarkerState();
    this.broadcastQueue();
    // A message durable already placed is in the transcript; sending it again would duplicate it.
    if (!(await this.withdraw(id, "move a queued message into the run"))) return null;
    return this.submit(queued.item.text, "steer", {
      ...(queued.item.attachments === undefined ? {} : { attachments: queued.item.attachments }),
    });
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
      // Pending steers stay until their submissions settle, so each one can be reported as
      // dropped with the reason instead of vanishing when the run stops.
      if (wasRunning) {
        this.setRunState("idle");
      } else {
        await this.persistMarkerState();
        this.broadcastQueue();
      }
    }
  }

  private async restorePersistedQueue(): Promise<void> {
    const marker = this.marker;
    if (marker === undefined || marker.stopRequested) return;
    for (const item of marker.queue) {
      try {
        await this.submit(item.text, "queue", {
          requestId: `run-queue:${marker.idempotencyKey}:${item.id}`,
          ...(item.attachments === undefined ? {} : { attachments: item.attachments }),
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
    attachments: string[] = [],
    steerKey?: string,
  ): Promise<{ message: ChatMessage; placed: boolean }> {
    const record = await submission.status(SESSION_CONTEXT);
    const entryId = "entry" in record ? record.entry : undefined;
    const placed = record.status === "placed" || record.status === "done";
    if (entryId !== undefined) {
      const context = await this.conversation.context(SESSION_CONTEXT);
      const entry = context.entries.find((candidate) => candidate.id === entryId);
      if (entry) {
        const message = buildTranscript([entry], this.mediaRef, this.diagramRevision).messages[0];
        if (message) {
          return {
            message: steer ? { ...message, steer: true } : message,
            placed,
          };
        }
      }
    }

    const notice = parseNotice(text);
    return {
      message: {
        id: `m-pending-${submission.id}`,
        role: "user",
        text,
        ...(notice === null ? {} : { notice }),
        ...(attachments.length > 0
          ? {
              attachments: attachments.map((id) => ({
                id,
                mimeType:
                  Object.entries(MEDIA_TYPES).find(([, ext]) => id.endsWith(`.${ext}`))?.[0] ??
                  "image/png",
              })),
            }
          : {}),
        timestamp: new Date().toISOString(),
        order: entryId ?? Number.MAX_SAFE_INTEGER,
        ...(steer ? { steer: true } : {}),
        ...(steerKey === undefined ? {} : { steerKey }),
      },
      placed,
    };
  }

  private async monitorSubmission(
    submission: Submission,
    startsRun: boolean,
    queuedId: string | undefined,
  ): Promise<void> {
    const steerId = String(submission.id);
    let final: SettledSubmissionRecord | undefined;
    try {
      const settled = await submission.wait(SESSION_CONTEXT);
      final = settled;
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
      if (this.steers.has(steerId)) {
        if (final?.status === "unanswered") {
          this.dropSteer(steerId, steerDropReason(final.reason, final.detail));
        } else if (final?.status === "done") {
          await this.consumeSteerEntry(final.entry, steerId);
          if (this.steers.has(steerId)) {
            this.dropSteer(steerId, "The run ended before the steer was delivered.");
          }
        } else {
          this.dropSteer(steerId, "The server lost track of the steer before it was delivered.");
        }
      }
      if (queuedId !== undefined && this.queued.delete(queuedId)) {
        await this.persistMarkerState();
        this.broadcastQueue();
      }
      if (startsRun && this.queued.size === 0) this.setRunState("idle");
      else this.maybeClearMarker();
    }
  }

  /** Removes the pending steer an entry consumed and shows the entry in the same update. */
  private consumeSteerEntryRecord(entry: EntryRecord, submissionId?: string): boolean {
    const message = buildTranscript([entry], this.mediaRef, this.diagramRevision).messages[0];
    if (message === undefined) return false;
    if (!this.takeTrackedSteer(message, submissionId)) return false;
    this.hub.broadcast([
      {
        event: "message.done",
        data: { message } satisfies StreamMessageDone,
      },
      {
        event: "run.state",
        data: this.getRunStatus() satisfies StreamRunState,
      },
    ]);
    return true;
  }

  /** Reads an entry by id and consumes its pending steer, for events that arrived out of order. */
  private async consumeSteerEntry(entryId: number, submissionId?: string): Promise<boolean> {
    const context = await this.conversation.context(SESSION_CONTEXT);
    const entry = context.entries.find((candidate) => candidate.id === entryId);
    return entry === undefined ? false : this.consumeSteerEntryRecord(entry, submissionId);
  }

  /** Takes a tracked steer off the queue when its transcript entry carries the same key. */
  private takeTrackedSteer(message: ChatMessage, submissionId?: string): boolean {
    let removed = false;
    if (submissionId !== undefined && this.steers.delete(submissionId)) removed = true;
    if (message.steerKey !== undefined) {
      for (const [id, steer] of this.steers) {
        if (steer.key !== message.steerKey) continue;
        this.steers.delete(id);
        removed = true;
      }
    }
    return removed;
  }

  /** Consumes every pending steer already present in a snapshot's entries. */
  private consumeSteersInEntries(entries: readonly EntryRecord[]): ChatMessage[] {
    const consumed: ChatMessage[] = [];
    for (const entry of entries) {
      if (entry.kind !== STEER_ENTRY_KIND) continue;
      const message = buildTranscript([entry], this.mediaRef, this.diagramRevision).messages[0];
      if (message !== undefined && this.takeTrackedSteer(message)) consumed.push(message);
    }
    return consumed;
  }

  /** A pending steer durable dropped is reported as failed, never silently removed. */
  private dropSteer(id: string, reason: string): boolean {
    if (!this.steers.delete(id)) return false;
    this.hub.broadcast([
      {
        event: "steer.dropped",
        data: { id, reason } satisfies StreamSteerDropped,
      },
      {
        event: "run.state",
        data: this.getRunStatus() satisfies StreamRunState,
      },
    ]);
    return true;
  }

  /** Sends a job result to the agent without placing a user message in the chat. */
  async submitJobNotice(text: string): Promise<void> {
    await this.submit(text, "queue", {
      entry: {
        kind: JOB_NOTICE_ENTRY_KIND,
        data: { text, createdAt: new Date().toISOString() },
      },
    });
  }

  /**
   * Records a job result the agent is not told about and shows it to open clients.
   * It belongs to the activity page, so this never touches the chat draft.
   */
  async recordNotice(text: string): Promise<void> {
    const activity = await appendJobNotice(this.conversation, text);
    if (activity === undefined) return;
    this.hub.broadcast({ event: "activity", data: { activity } satisfies StreamActivity });
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
    this.lastEventAt = Date.now();
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
        const consumed = this.consumeSteersInEntries(event.entries);
        // A snapshot replaces events durable dropped, a run's end among them.
        this.reconcileRun({
          run: event.run !== undefined,
          inbox: event.inbox.length,
          submitting: this.submitting,
        });
        const revision = this.bumpDraft();
        const frames: SseFrame[] = consumed.map((message) => ({
          event: "message.done",
          data: { message } satisfies StreamMessageDone,
        }));
        if (frames.length === 0) {
          frames.push({
            event: "message.done",
            data: { message: null } satisfies StreamMessageDone,
          });
        }
        frames.push(
          {
            event: "draft.sync",
            data: {
              text: this.currentText,
              thinking: this.currentThinking,
              revision,
            } satisfies StreamDraftSync,
          },
          {
            event: "run.state",
            data: this.getRunStatus() satisfies StreamRunState,
          },
        );
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
          const previousText = this.currentText;
          const previousThinking = this.currentThinking;
          this.currentText = "";
          this.currentThinking = "";
          this.absorbMessage(event.message);
          this.publishDraft(previousText, previousThinking);
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
          } else if (change.type === "text_start") {
            if (change.block.type === "text" && change.block.text.length > 0) {
              this.currentText += change.block.text;
              this.broadcastText();
            }
          } else if (change.type === "thinking_start") {
            if (change.block.type === "thinking" && change.block.thinking.length > 0) {
              this.currentThinking += change.block.thinking;
              this.broadcastThinking();
            }
          } else if (change.type === "block") {
            if (change.block.type === "text") {
              this.currentText = change.block.text;
              this.broadcastText();
            } else if (change.block.type === "thinking") {
              this.currentThinking = change.block.thinking;
              this.broadcastThinking();
            }
          } else if (change.type === "message") {
            const previousText = this.currentText;
            const previousThinking = this.currentThinking;
            this.absorbMessage(change.message);
            this.publishDraft(previousText, previousThinking);
          }
        }
        return;

      case "message_end": {
        const message = assistantMessageFromEntry(event.entry);
        if (message !== null) this.summaryCandidate = message;
        this.currentText = "";
        this.currentThinking = "";
        const revision = this.bumpDraft();
        if (event.entry.kind === STEER_ENTRY_KIND) {
          const steerMessage = buildTranscript([event.entry], this.mediaRef, this.diagramRevision)
            .messages[0];
          if (steerMessage !== undefined) this.takeTrackedSteer(steerMessage);
          this.hub.broadcast([
            {
              event: "draft.sync",
              data: { text: "", thinking: "", revision } satisfies StreamDraftSync,
            },
            {
              event: "message.done",
              data: { message: steerMessage ?? null } satisfies StreamMessageDone,
            },
            {
              event: "run.state",
              data: this.getRunStatus() satisfies StreamRunState,
            },
          ]);
          return;
        }
        this.hub.broadcast([
          {
            event: "draft.sync",
            data: { text: "", thinking: "", revision } satisfies StreamDraftSync,
          },
          {
            event: "message.done",
            data: {
              message: message === null ? null : this.withSummary(message),
            } satisfies StreamMessageDone,
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
        this.toolsRevision += 1;
        this.hub.broadcast({
          event: "tool.start",
          data: {
            toolCallId: event.toolCallId,
            name: event.toolName,
            arguments: event.args,
            timestamp,
            toolsRevision: this.toolsRevision,
          } satisfies StreamToolStart,
        });
        return;
      }

      case "tool_execution_end": {
        if (event.parentToolCallId !== undefined) return;
        const active = this.activeTools.get(event.toolCallId);
        this.activeTools.delete(event.toolCallId);
        this.toolsRevision += 1;
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
            toolsRevision: this.toolsRevision,
          } satisfies StreamToolEnd,
        });
        return;
      }

      case "submission": {
        const id = String(event.record.id);
        if (event.record.type !== "input") return;
        if (event.record.status === "placed") {
          const wasQueued = this.queued.delete(id);
          if (wasQueued) {
            await this.persistMarkerState();
            this.broadcastQueue();
            this.hub.broadcast({
              event: "message.done",
              data: { message: null } satisfies StreamMessageDone,
            });
          }
          // The entry event normally consumes the steer first. If it did not, read the entry
          // now: the pending bubble must stay until the transcript message can replace it.
          if (this.steers.has(id)) await this.consumeSteerEntry(event.record.entry, id);
        } else if (event.record.status === "done") {
          if (this.queued.delete(id)) {
            await this.persistMarkerState();
            this.broadcastQueue();
          }
          if (this.steers.has(id) && !(await this.consumeSteerEntry(event.record.entry, id))) {
            this.dropSteer(id, "The run ended before the steer was delivered.");
          }
        } else if (event.record.status === "unanswered") {
          if (this.queued.delete(id)) {
            await this.persistMarkerState();
            this.broadcastQueue();
          }
          this.dropSteer(id, steerDropReason(event.record.reason, event.record.detail));
        }
        return;
      }

      case "inbox_update":
        // The inbox only says which steers are still waiting. Placement and settlement events
        // retire them once their transcript entry exists, so a disappearance here is not enough.
        return;

      case "entry_appended":
        if (event.entry.kind === JOB_NOTICE_ENTRY_KIND) {
          const activity = buildTranscript([event.entry]).activity[0];
          if (activity !== undefined) {
            this.hub.broadcast({
              event: "activity",
              data: { activity } satisfies StreamActivity,
            });
          }
          return;
        }
        if (event.entry.kind === STEER_ENTRY_KIND) {
          if (this.consumeSteerEntryRecord(event.entry)) return;
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
        await this.beforeTurn("compaction");
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
    this.toolsRevision += 1;
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

  private steerItems(): QueuedMessage[] {
    return [...this.steers.values()];
  }

  /** After a restart, steers still in durable's inbox are listed again, so they can be taken back. */
  private async restorePendingSteers(): Promise<void> {
    try {
      const state = await this.conversation.viewState(SESSION_CONTEXT);
      try {
        const inbox = state.value.docs["pi.inbox"] as
          | {
              items?: {
                id?: unknown;
                mode?: unknown;
                content?: unknown;
                entry?: { data?: unknown };
              }[];
            }
          | undefined;
        for (const item of inbox?.items ?? []) {
          const steer = steerFromInboxItem(item);
          if (steer === undefined || this.steers.has(steer.id)) continue;
          this.steers.set(steer.id, steer);
        }
      } finally {
        state.dispose();
      }
    } catch (error) {
      console.error("[pi] could not read pending steers", error);
    }
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

  private setRunState(state: RunState): void {
    const wasRunning = this.runState === "running";
    if (this.runState === state) {
      this.maybeClearMarker();
      return;
    }
    this.runState = state;
    if (state === "running") {
      this.lastEventAt = Date.now();
    } else {
      this.currentText = "";
      this.currentThinking = "";
      if (this.activeTools.size > 0) {
        this.activeTools.clear();
        this.toolsRevision += 1;
      }
    }
    this.maybeClearMarker();
    this.hub.broadcast({
      event: "run.state",
      data: this.getRunStatus(),
    });
    if (state === "idle" && wasRunning) this.summarizeCompletedTurn();
  }
}
