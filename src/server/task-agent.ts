import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type Conversation,
  type ConversationId,
  type ConversationView,
  type ConversationWatch,
  createRegistry,
  defineExtension,
  defineTool,
  type EntryRecord,
  type Harness,
  Harness as HarnessImpl,
  type LiveState,
  type ModelRef,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { Type } from "typebox";
import { parseProjectToken, projectsOf, sameProject } from "../shared/project.js";
import { DEFAULT_NEW_TASK_TITLE, TASK_BODY_MAX_LENGTH } from "../shared/tasks.js";
import type { ChatMessage, RunState, StreamRunState, Task, TaskLedger } from "../shared/types.js";
import { withConversationIdentity } from "./billion-context.js";
import { buildTranscript, SESSION_CONTEXT } from "./session.js";
import type { SseFrame } from "./sse.js";
import { StreamHub } from "./stream-hub.js";
import { TaskError, type TaskStore } from "./tasks.js";

/** The only tools a task planning agent may call: inspect the repo, and edit its own task. */
export const TASK_AGENT_TOOL_NAMES = ["bash", "read", "edit_task"] as const;
export type TaskAgentToolName = (typeof TASK_AGENT_TOOL_NAMES)[number];

const TASK_AGENT_TOOL_SET = new Set<string>(TASK_AGENT_TOOL_NAMES);

export class TaskAgentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "TaskAgentError";
  }
}

export interface TaskAgentChatSnapshot {
  taskId: string;
  messages: ChatMessage[];
  run: RunState;
  draft: { text: string; thinking: string; revision: number };
}

export interface TaskAgentSession {
  readonly taskId: string;
  readonly hub: StreamHub;
  closed: boolean;
  running(): boolean;
  snapshot(): Promise<TaskAgentChatSnapshot>;
  submit(text: string): Promise<TaskAgentChatSnapshot>;
  stop(): Promise<void>;
  close(): Promise<void>;
  replayFrames(): SseFrame[];
  applyInstructions?(instructions: string): Promise<void>;
}

export interface TaskAgentManagerOptions {
  readonly dataDir: string;
  readonly cwd: string;
  readonly models: ModelRuntime;
  readonly model: Model<Api> | undefined;
  readonly store: TaskStore;
  readonly publish: (ledger: TaskLedger) => void;
  /** Base system prompt (coding-agent path with only read and bash described). */
  readonly baseInstructions: string;
  /** Tests inject a fake session instead of opening a durable harness. */
  readonly openSession?: (taskId: string, manager: TaskAgentManager) => Promise<TaskAgentSession>;
  /** Forward session frames onto the main /api/stream so the browser can reuse that EventSource. */
  readonly relay?: (taskId: string, frame: SseFrame) => void;
}

/**
 * Keep only bash, read and edit_task. Used both when building a registry and in tests
 * that assert the restriction without starting a harness.
 */
export function selectTaskAgentTools<T extends { name: string }>(tools: readonly T[]): T[] {
  return tools.filter((tool) => TASK_AGENT_TOOL_SET.has(tool.name));
}

export function isTaskAgentToolName(name: string): name is TaskAgentToolName {
  return TASK_AGENT_TOOL_SET.has(name);
}

/** Visible chat rows: user and assistant text, plus system notes. Never tool-call lists. */
export function visibleTaskAgentMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => {
    if (message.notice !== undefined) return false;
    return message.role === "user" || message.role === "assistant" || message.role === "system";
  });
}

export function taskAgentInstructions(
  base: string,
  task: Pick<Task, "id" | "title" | "body" | "project">,
): string {
  const project = task.project === undefined ? "none" : task.project;
  const body = task.body === undefined || task.body.length === 0 ? "(empty)" : task.body;
  return `${base}

You are a planning agent for a single task in pi-ui (id: ${task.id}).
Your job is to help the operator formulate the task and propose a solution — a concrete design for how it would be solved.

Plan mode only:
- You may use the read and bash tools to inspect the repository.
- You must not edit, write, create or delete any files, and you must not run commands that change the workspace.
- You have exactly one additional tool, edit_task, which updates this task's title, markdown body and/or project. Use it to capture the formulated task: a clear title, a markdown body with the problem and the proposed design (mermaid fences are allowed), and a project when one fits.
- Do not change the task's status. The operator owns that.
- Do not list or narrate your tool calls in the task body.

Current task:
- id: ${task.id}
- title: ${task.title}
- project: ${project}
- body:
${body}`;
}

const editSchema = Type.Object({
  title: Type.Optional(Type.String({ description: "New title; it must not be empty." })),
  body: Type.Optional(
    Type.String({
      description: `Free markdown description shown under the title, up to ${TASK_BODY_MAX_LENGTH} characters. Pass an empty string to clear it.`,
    }),
  ),
  project: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description: "New project name, or null to clear it.",
    }),
  ),
});

/** The one task-edit tool bound to a single task. It cannot target any other task. */
export function createTaskEditTool(options: {
  taskId: string;
  store: TaskStore;
  publish: (ledger: TaskLedger) => void;
}): ToolRegistration {
  return defineTool({
    name: "edit_task",
    description:
      "Update this task's title, markdown body and/or project. The body is shown under the title on the tasks page; pass an empty string to clear it. A title cannot be empty. This cannot change status.",
    parameters: editSchema,
    async execute(args) {
      const current = options.store.ledger().tasks.find((task) => task.id === options.taskId);
      if (current === undefined) {
        return {
          output: [{ type: "text" as const, text: "Unknown task" }],
          isError: true,
        };
      }
      if (args.title === undefined && args.body === undefined && args.project === undefined) {
        return {
          output: [{ type: "text" as const, text: "Pass a title, body and/or project to change." }],
          isError: true,
        };
      }
      const patch: { title?: string; body?: string; project?: string | null } = {};
      if (args.title !== undefined) patch.title = args.title;
      if (args.body !== undefined) patch.body = args.body;
      if (args.project !== undefined) patch.project = args.project;
      try {
        const ledger = await options.store.update(options.taskId, patch);
        options.publish(ledger);
        const next = ledger.tasks.find((task) => task.id === options.taskId);
        const title = next?.title ?? current.title;
        const project = next?.project === undefined ? "none" : next.project;
        const body = next?.body === undefined || next.body.length === 0 ? "(empty)" : next.body;
        return {
          output: [
            {
              type: "text" as const,
              text: `${options.taskId} updated\ntitle: ${title}\nproject: ${project}\nbody:\n${body}`,
            },
          ],
        };
      } catch (error) {
        const message = error instanceof TaskError ? error.message : "Could not update the task";
        return { output: [{ type: "text" as const, text: message }], isError: true };
      }
    },
  });
}

/**
 * From a user message, the title/project that should land on a freshly created task
 * and the text that should go to the agent (@project tokens stripped).
 */
export function openingTaskPatch(
  task: Pick<Task, "title" | "project">,
  text: string,
  knownProjects: readonly string[] = [],
): { title?: string; project?: string | null; message: string } {
  const parsed = parseProjectToken(text, knownProjects);
  const patch: { title?: string; project?: string | null; message: string } = {
    message: parsed.title.length > 0 ? parsed.title : text.trim(),
  };
  if (parsed.project !== null && !sameProject(task.project, parsed.project)) {
    patch.project = parsed.project;
  }
  if (task.title === DEFAULT_NEW_TASK_TITLE && parsed.title.length > 0) {
    const line = parsed.title.split(/\r?\n/, 1)[0]?.trim() ?? "";
    if (line.length > 0) patch.title = line;
  }
  return patch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assistantText(message: AssistantMessage | undefined): string {
  if (message === undefined) return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  return parts.join("");
}

function assistantThinking(message: AssistantMessage | undefined): string {
  if (message === undefined) return "";
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && block.type === "thinking" && typeof block.thinking === "string") {
      parts.push(block.thinking);
    }
  }
  return parts.join("");
}

function liveRunning(live: LiveState | undefined): boolean {
  return live?.run !== undefined || live?.generation !== undefined;
}

async function readConversationId(path: string): Promise<ConversationId | undefined> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
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
    // Replace a malformed pointer on the next create.
  }
  return undefined;
}

async function writeConversationId(path: string, conversationId: ConversationId): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify({ conversationId })}\n`, "utf8");
  await rename(temporary, path);
}

class DurableTaskAgentSession implements TaskAgentSession {
  closed = false;
  readonly hub = new StreamHub();
  private runState: RunState = "idle";
  private currentText = "";
  private currentThinking = "";
  private draftRevision = 0;
  private lastViewEntryId: EntryRecord["id"] | undefined;
  private viewLive: LiveState | undefined;
  private watch: ConversationWatch | undefined;

  constructor(
    readonly taskId: string,
    private readonly harness: Harness,
    private readonly conversation: Conversation,
    private readonly relay?: (frame: SseFrame) => void,
  ) {}

  private emit(frame: SseFrame): void {
    this.hub.broadcast(frame);
    this.relay?.(frame);
  }

  running(): boolean {
    return this.runState === "running";
  }

  replayFrames(): SseFrame[] {
    const revision = this.bumpDraft();
    return [
      {
        event: "draft.sync",
        data: { text: this.currentText, thinking: this.currentThinking, revision },
      },
      { event: "run.state", data: this.runStatus() },
    ];
  }

  private runStatus(): StreamRunState {
    return { state: this.runState };
  }

  private bumpDraft(): number {
    this.draftRevision += 1;
    return this.draftRevision;
  }

  private setRunState(state: RunState): void {
    if (this.runState === state) return;
    this.runState = state;
    this.emit({ event: "run.state", data: this.runStatus() });
  }

  private publishDraft(): void {
    const revision = this.bumpDraft();
    this.emit({
      event: "message.delta",
      data: { text: "", full: this.currentText, revision },
    });
    this.emit({
      event: "thinking.delta",
      data: { text: "", full: this.currentThinking, revision },
    });
  }

  async snapshot(): Promise<TaskAgentChatSnapshot> {
    const context = await this.conversation.context(SESSION_CONTEXT);
    const built = buildTranscript(context.entries);
    return {
      taskId: this.taskId,
      messages: visibleTaskAgentMessages(built.messages),
      run: this.runState,
      draft: {
        text: this.currentText,
        thinking: this.currentThinking,
        revision: this.draftRevision,
      },
    };
  }

  async applyInstructions(instructions: string): Promise<void> {
    if (this.closed) return;
    await this.conversation.configure({ instructions }, SESSION_CONTEXT);
  }

  private identity<T>(run: () => T): T {
    // The numeric conversation id is unique only inside this task's
    // sqlite file. billion-context keys sessions process-wide, so stamp a
    // name that cannot collide with the main chat or another task.
    return withConversationIdentity(`task-agent:${this.taskId}`, run);
  }

  async start(): Promise<void> {
    const stream = await this.conversation.watch(SESSION_CONTEXT, { min: 50, max: 200 });
    this.watch = stream;
    this.resetView(stream.value);
    stream.start(async (call) => {
      if (this.closed || call.kind !== "value") return;
      try {
        await this.handleView(call.value);
      } catch (error) {
        console.error(`[task-agent] view handling failed for ${this.taskId}`, error);
      }
    });
    this.identity(() => this.harness.resume());
  }

  private resetView(view: ConversationView): void {
    let newest: EntryRecord["id"] | undefined;
    for (const entry of view.entries) {
      if (newest === undefined || entry.id > newest) newest = entry.id;
    }
    this.lastViewEntryId = newest;
    this.viewLive = view.docs["pi.live"] as LiveState | undefined;
    const message = this.viewLive?.generation?.message as AssistantMessage | undefined;
    this.currentText = assistantText(message);
    this.currentThinking = assistantThinking(message);
    this.runState = liveRunning(this.viewLive) ? "running" : "idle";
  }

  private async handleView(view: ConversationView): Promise<void> {
    const live = view.docs["pi.live"] as LiveState | undefined;
    const previousLive = this.viewLive;
    this.viewLive = live;

    const newEntries: EntryRecord[] = [];
    let newest = this.lastViewEntryId;
    for (const entry of view.entries) {
      if (this.lastViewEntryId === undefined || entry.id > this.lastViewEntryId) {
        newEntries.push(entry);
      }
      if (newest === undefined || entry.id > newest) newest = entry.id;
    }
    this.lastViewEntryId = newest;
    newEntries.sort((left, right) => left.id - right.id);

    const partial = live?.generation?.message as AssistantMessage | undefined;
    const nextText = assistantText(partial);
    const nextThinking = assistantThinking(partial);
    const draftChanged = nextText !== this.currentText || nextThinking !== this.currentThinking;
    this.currentText = nextText;
    this.currentThinking = nextThinking;
    if (draftChanged) this.publishDraft();

    if (newEntries.length > 0) {
      const built = buildTranscript(newEntries);
      for (const message of visibleTaskAgentMessages(built.messages)) {
        this.emit({ event: "message.done", data: { message } });
      }
      this.currentText = "";
      this.currentThinking = "";
      this.emit({
        event: "draft.sync",
        data: { text: "", thinking: "", revision: this.bumpDraft() },
      });
    }

    const running = liveRunning(live);
    const wasRunning = liveRunning(previousLive);
    if (running !== wasRunning || (running && this.runState !== "running")) {
      this.setRunState(running ? "running" : "idle");
    }
  }

  async submit(text: string): Promise<TaskAgentChatSnapshot> {
    if (this.closed) throw new TaskAgentError("Task agent has been closed", 409);
    // Model requests go through billion-context; they must carry this
    // conversation's id, not the main chat's, or the turn can hang or
    // attach itself to the parent session.
    const submission = await this.identity(() =>
      this.conversation.submit({ type: "input", content: text }, SESSION_CONTEXT),
    );
    this.setRunState("running");
    void this.identity(() => submission.wait(SESSION_CONTEXT))
      .then((settled) => {
        if (settled.status !== "unanswered") return;
        console.warn(
          `[task-agent] run ended without an answer for ${this.taskId}: ${settled.reason}` +
            (settled.detail === undefined ? "" : ` (${JSON.stringify(settled.detail)})`),
        );
        if (!this.closed && this.runState === "running") this.setRunState("idle");
      })
      .catch((error: unknown) => {
        console.error(`[task-agent] submit failed for ${this.taskId}`, error);
        if (!this.closed && this.runState === "running") this.setRunState("idle");
      });
    return this.snapshot();
  }

  async stop(): Promise<void> {
    if (this.closed || this.runState !== "running") return;
    try {
      await this.identity(() => this.conversation.abort(SESSION_CONTEXT));
    } catch (error) {
      console.error(`[task-agent] abort failed for ${this.taskId}`, error);
    } finally {
      this.currentText = "";
      this.currentThinking = "";
      this.setRunState("idle");
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    void this.watch?.stop();
    this.watch = undefined;
    const shutdown = async () => {
      try {
        if (this.runState === "running") {
          await this.identity(() => this.conversation.abort(SESSION_CONTEXT));
        }
      } catch {
        // Closing anyway.
      }
      await this.harness.close(SESSION_CONTEXT);
    };
    try {
      await Promise.race([
        shutdown(),
        new Promise<void>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("close timed out")), 3_000);
          timer.unref?.();
        }),
      ]);
    } catch (error) {
      console.error(`[task-agent] harness close failed for ${this.taskId}`, error);
    } finally {
      this.runState = "idle";
    }
  }
}

export class TaskAgentManager {
  private readonly sessions = new Map<string, TaskAgentSession>();
  private readonly opening = new Map<string, Promise<TaskAgentSession>>();
  private closed = false;
  readonly root: string;

  constructor(private readonly options: TaskAgentManagerOptions) {
    this.root = join(options.dataDir, "task-agents");
  }

  taskDir(taskId: string): string {
    return join(this.root, taskId);
  }

  async ensure(taskId: string): Promise<TaskAgentSession> {
    if (this.closed) throw new TaskAgentError("Task agents have shut down", 409);
    const task = this.options.store.ledger().tasks.find((item) => item.id === taskId);
    if (task === undefined) throw new TaskAgentError("Unknown task", 404);
    const existing = this.sessions.get(taskId);
    if (existing !== undefined && !existing.closed) return existing;
    let pending = this.opening.get(taskId);
    if (pending === undefined) {
      pending = this.open(taskId).finally(() => this.opening.delete(taskId));
      this.opening.set(taskId, pending);
    }
    return pending;
  }

  async snapshot(taskId: string): Promise<TaskAgentChatSnapshot> {
    return (await this.ensure(taskId)).snapshot();
  }

  async submit(taskId: string, text: string): Promise<TaskAgentChatSnapshot> {
    const task = this.options.store.ledger().tasks.find((item) => item.id === taskId);
    if (task === undefined) throw new TaskAgentError("Unknown task", 404);
    if (task.status === "done") {
      throw new TaskAgentError("Task is done", 409);
    }
    const trimmed = text.trim();
    if (trimmed.length === 0) throw new TaskAgentError("Message text is required", 400);
    const known = projectsOf(this.options.store.ledger().tasks);
    const patch = openingTaskPatch(task, trimmed, known);
    if (patch.message.length === 0) throw new TaskAgentError("Message text is required", 400);
    if (patch.title !== undefined || patch.project !== undefined) {
      const ledger = await this.options.store.update(taskId, {
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.project === undefined ? {} : { project: patch.project }),
      });
      this.options.publish(ledger);
    }
    const session = await this.ensure(taskId);
    return session.submit(patch.message);
  }

  async stopRun(taskId: string): Promise<void> {
    const session = this.sessions.get(taskId);
    if (session === undefined || session.closed) return;
    await session.stop();
  }

  async remove(taskId: string): Promise<void> {
    const pending = this.opening.get(taskId);
    if (pending !== undefined) {
      try {
        await Promise.race([
          pending,
          new Promise<void>((_, reject) => {
            const timer = setTimeout(() => reject(new Error("open timed out")), 3_000);
            timer.unref?.();
          }),
        ]);
      } catch {
        // The opener failed or stalled; still remove any files.
      }
    }
    const session = this.sessions.get(taskId);
    this.sessions.delete(taskId);
    if (session !== undefined) await session.close();
    await rm(this.taskDir(taskId), { recursive: true, force: true });
  }

  async close(): Promise<void> {
    this.closed = true;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => session.close()));
  }

  private async open(taskId: string): Promise<TaskAgentSession> {
    if (this.options.openSession !== undefined) {
      const session = await this.options.openSession(taskId, this);
      this.sessions.set(taskId, session);
      return session;
    }
    const session = await this.openDurable(taskId);
    this.sessions.set(taskId, session);
    return session;
  }

  private async openDurable(taskId: string): Promise<DurableTaskAgentSession> {
    const task = this.options.store.ledger().tasks.find((item) => item.id === taskId);
    if (task === undefined) throw new TaskAgentError("Unknown task", 404);
    const dir = this.taskDir(taskId);
    await mkdir(dir, { recursive: true });
    const databasePath = join(dir, "pi.sqlite3");
    const currentPath = join(dir, "current.json");
    const storage = await openNodeSqliteStorage(databasePath);
    const registry = createRegistry<ToolRegistration>();
    const coding = (createCodingTools().tools ?? []).filter(
      (tool) => tool.name === "read" || tool.name === "bash",
    );
    registry.install(defineExtension({ name: "task-agent-coding-tools", tools: coding }));
    registry.install(
      defineExtension({
        name: "task-agent-edit-tool",
        tools: [
          createTaskEditTool({
            taskId,
            store: this.options.store,
            publish: (ledger) => {
              this.options.publish(ledger);
              void this.refreshInstructions(taskId);
            },
          }),
        ],
      }),
    );
    const tools = selectTaskAgentTools(
      registry
        .snapshot()
        .tools()
        .map(({ tool }) => tool),
    );
    const model: ModelRef | undefined =
      this.options.model === undefined
        ? undefined
        : { provider: this.options.model.provider, modelId: this.options.model.id };
    const harness = await HarnessImpl.open(
      storage,
      {
        models: this.options.models as unknown as Parameters<typeof HarnessImpl.open>[1]["models"],
        registry,
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? this.options.cwd }),
        settings: {
          compaction: { enabled: false },
          retry: { enabled: false },
          steeringMode: "all",
        },
        onReport: (report) =>
          console.error(`[task-agent] harness report (${report.kind})`, report.error),
      },
      SESSION_CONTEXT,
    );
    const instructions = taskAgentInstructions(this.options.baseInstructions, task);
    const savedId = await readConversationId(currentPath);
    let conversation: Conversation | undefined;
    if (savedId !== undefined) {
      conversation = (await harness.conversation(savedId, SESSION_CONTEXT)) ?? undefined;
    }
    if (conversation === undefined) {
      conversation = await harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: {
            cwd: this.options.cwd,
            instructions,
            ...(model === undefined ? {} : { model }),
            tools,
          },
        },
        SESSION_CONTEXT,
      );
      await writeConversationId(currentPath, conversation.id);
    } else {
      await conversation.configure(
        {
          cwd: this.options.cwd,
          instructions,
          ...(model === undefined ? {} : { model }),
          tools,
        },
        SESSION_CONTEXT,
      );
    }
    const session = new DurableTaskAgentSession(
      taskId,
      harness,
      conversation,
      this.options.relay === undefined ? undefined : (frame) => this.options.relay?.(taskId, frame),
    );
    await session.start();
    return session;
  }

  private async refreshInstructions(taskId: string): Promise<void> {
    const session = this.sessions.get(taskId);
    if (session === undefined || session.closed || session.applyInstructions === undefined) return;
    const task = this.options.store.ledger().tasks.find((item) => item.id === taskId);
    if (task === undefined) return;
    try {
      await session.applyInstructions(taskAgentInstructions(this.options.baseInstructions, task));
    } catch (error) {
      console.error(`[task-agent] could not refresh instructions for ${taskId}`, error);
    }
  }
}
