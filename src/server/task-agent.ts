import { randomUUID } from "node:crypto";
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
  type HarnessSettings,
  type LiveState,
  type ModelRef,
  type Submission,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { Type } from "typebox";
import { parseProjectToken, projectsOf, sameProject } from "../shared/project.js";
import {
  parseTaskQuestions,
  questionAnswerItems,
  taskQuestionAnswerPayload,
  taskQuestionAnswerSummary,
} from "../shared/questions.js";
import { PENDING_QUEUE_ORDER, QUEUE_ENTRY_KIND } from "../shared/queue.js";
import { runErrorFromUnanswered } from "../shared/run-error.js";
import { steerDropReason } from "../shared/steers.js";
import { DEFAULT_NEW_TASK_TITLE, isActiveStatus, TASK_BODY_MAX_LENGTH } from "../shared/tasks.js";
import {
  type ChatMessage,
  type MessageMode,
  type QueuedMessage,
  type RunError,
  type RunState,
  STEER_ENTRY_KIND,
  type StreamRunState,
  type SubmitMessageResponse,
  type Task,
  type TaskLedger,
  type TaskQuestionSet,
} from "../shared/types.js";
import { withConversationIdentity } from "./billion-context.js";
import type { MediaStore } from "./media.js";
import { composeInstructions, type SnapshotCache } from "./memory/snapshot.js";
import type { MemoryStore } from "./memory/store.js";
import { createMemoryTools } from "./memory/tools.js";
import { PlanTurnNotifier, type PlanTurnPushSender } from "./plan-push.js";
import { retrySettings } from "./retry.js";
import { RunErrorNotifier, type RunErrorPushInput, type RunErrorPushSender } from "./run-push.js";
import { buildTranscript, SESSION_CONTEXT } from "./session.js";
import type { SseFrame } from "./sse.js";
import { StreamHub } from "./stream-hub.js";
import {
  type QuestionAnswerResult,
  TaskQuestionAnswerEntry,
  TaskQuestionsStore,
} from "./task-questions.js";
import { createProposeTaskTool } from "./task-tools.js";
import { TaskError, type TaskStore } from "./tasks.js";

/**
 * The only tools a task planning agent may call: inspect the repo, edit its task,
 * ask the operator, propose distinct follow-up work for approval, and read memory.
 */
export const TASK_AGENT_MEMORY_TOOL_NAMES = ["memory_read", "memory_grep", "memory_find"] as const;
export const TASK_AGENT_TOOL_NAMES = [
  "bash",
  "read",
  "edit_task",
  "propose_task",
  "ask_questions",
  "append_questions",
  ...TASK_AGENT_MEMORY_TOOL_NAMES,
] as const;
export type TaskAgentToolName = (typeof TASK_AGENT_TOOL_NAMES)[number];

const TASK_AGENT_TOOL_SET = new Set<string>(TASK_AGENT_TOOL_NAMES);
const TASK_AGENT_MEMORY_TOOL_SET = new Set<string>(TASK_AGENT_MEMORY_TOOL_NAMES);
/**
 * Planning is read-only, even if someone later widens the allow-list above. The
 * memory factory is shared with the main chat, so its write tool is filtered out
 * both at installation and again when the registry snapshot is selected.
 */
const TASK_AGENT_FORBIDDEN_TOOL_SET = new Set<string>(["memory_write"]);

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
  /** The last plan-run failure, until dismissed or the next submit. */
  runError?: RunError | null;
  draft: { text: string; thinking: string; revision: number };
  /** The unanswered set, or null. Persisted beside the task agent's conversation. */
  questions: TaskQuestionSet | null;
  /** Follow-ups waiting for the current plan run to end. */
  queue?: QueuedMessage[];
  /** Steers waiting for the run's next turn boundary. */
  steers?: QueuedMessage[];
  /** Revision of the two lists above, so a late snapshot cannot undo a newer update. */
  queueRevision?: number;
}

export interface TaskAgentSession {
  readonly taskId: string;
  readonly hub: StreamHub;
  closed: boolean;
  running(): boolean;
  snapshot(): Promise<TaskAgentChatSnapshot>;
  submit(text: string, attachments?: string[]): Promise<TaskAgentChatSnapshot>;
  /** The main-chat-shaped send answer, used by the shared client core. */
  send?(
    text: string,
    attachments: string[],
    mode: MessageMode,
    queueKey?: string,
  ): Promise<SubmitMessageResponse>;
  cancelQueued?(id: string): Promise<boolean>;
  steerQueued?(id: string): Promise<SubmitMessageResponse | null>;
  unsendSteer?(id: string): Promise<QueuedMessage | null>;
  dismissError?(id?: string): Promise<TaskAgentChatSnapshot>;
  stop(): Promise<void>;
  close(): Promise<void>;
  replayFrames(): SseFrame[];
  applyInstructions?(instructions: string): Promise<void>;
  /** The pending set for the answer panel, or null when nothing waits. */
  pendingQuestions?(): Promise<TaskQuestionSet | null>;
  /** Record the operator's answers, add a readable transcript row, and wake the tool. */
  answerQuestions?(setId: string, answers: unknown): Promise<TaskAgentChatSnapshot>;
}

/** The memory tree and its injected-snapshot cache, shared with the main chat. */
export interface TaskAgentMemory {
  readonly store: MemoryStore;
  readonly snapshot: SnapshotCache;
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
  /** Read-only memory and the snapshot block injected into the plan prompt. */
  readonly memory?: TaskAgentMemory;
  /** Tests inject a fake session instead of opening a durable harness. */
  readonly openSession?: (taskId: string, manager: TaskAgentManager) => Promise<TaskAgentSession>;
  /** Forward session frames onto the main /api/stream so the browser can reuse that EventSource. */
  readonly relay?: (taskId: string, frame: SseFrame) => void;
  /** A plan run started or ended, so the tasks payload can be pushed again with `planning`. */
  readonly onRunState?: (taskId: string) => void;
  /** Used to resolve image attachments sent in the plan chat. */
  readonly media?: MediaStore;
  /** Where a finished planning turn is announced. Defaults to web push. */
  readonly notify?: PlanTurnPushSender;
  /** Where a failed planning turn is announced. Defaults to web push. */
  readonly runErrorNotify?: RunErrorPushSender;
  /** Reuse the chat page's failure notifier, so their 60 s windows share one clock. */
  readonly runErrorNotifier?: Pick<RunErrorNotifier, "deliver">;
  /** Minimum milliseconds between pushes for the same task. Zero disables the guard. */
  readonly pushWindowMs?: number;
  readonly burstWindowMs?: number;
  readonly coalesceMs?: number;
  /** Override the clock in tests. */
  readonly now?: () => number;
}

/**
 * Keep only the TASK_AGENT_TOOL_NAMES allow-list. Used both when building a registry
 * and in tests that assert the restriction without starting a harness.
 */
export function selectTaskAgentTools<T extends { name: string }>(tools: readonly T[]): T[] {
  return tools.filter(
    (tool) => TASK_AGENT_TOOL_SET.has(tool.name) && !TASK_AGENT_FORBIDDEN_TOOL_SET.has(tool.name),
  );
}

/** Keep only the three read-only memory tools, never the shared factory's writer. */
export function selectTaskAgentMemoryTools<T extends { name: string }>(tools: readonly T[]): T[] {
  return tools.filter((tool) => TASK_AGENT_MEMORY_TOOL_SET.has(tool.name));
}

/** Compose the plan's base prompt with the same snapshot block the main chat uses. */
export async function taskAgentMemoryBase(
  base: string,
  memory: TaskAgentMemory | undefined,
): Promise<string> {
  if (memory === undefined) return base;
  const block = await memory.snapshot.get(memory.store, "first_turn");
  return composeInstructions(base, block);
}

export function isTaskAgentToolName(name: string): name is TaskAgentToolName {
  return TASK_AGENT_TOOL_SET.has(name);
}

/**
 * The task ids the tasks payload may report as Planning. `running` is the manager's
 * existing session bookkeeping; terminal and parked tasks are never planning work.
 */
export function derivePlanningTaskIds(
  tasks: readonly Pick<Task, "id" | "status">[],
  running: Iterable<string>,
): string[] {
  const live = new Set(running);
  return tasks
    .filter(
      (task) => live.has(task.id) && (isActiveStatus(task.status) || task.status === "planning"),
    )
    .map((task) => task.id);
}

/** Visible chat rows: user and assistant text, plus system notes. Never tool-call lists. */
export function visibleTaskAgentMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => {
    if (message.notice !== undefined) return false;
    return message.role === "user" || message.role === "assistant" || message.role === "system";
  });
}

/** The harness policy the plan agent opens with, so retries behave like the main chat. */
export function taskAgentHarnessSettings(env: NodeJS.ProcessEnv = process.env): HarnessSettings {
  return {
    compaction: { enabled: false },
    retry: retrySettings(env),
    steeringMode: "all",
  };
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
- Memory is what previous turns learned: read it with memory_read, memory_grep and memory_find before planning from scratch, and never write to it from a planning turn.
- You have additional tools, edit_task, propose_task, ask_questions and append_questions. edit_task updates this task's title, markdown body and/or project. Use it to capture the formulated task: a clear title, a markdown body with the problem and the proposed design (mermaid fences are allowed), and a project when one fits.
- Use propose_task to hand a follow-up task to the operator for approval. A proposal is not a task: only a human approving it creates work, so do not treat it as started or done. Do not propose a duplicate of the task you are planning; propose only distinct follow-up work.
- When a decision would be guessed in prose, call ask_questions with a structured set (single, multi or text) and wait for the operator's answers. Use append_questions to add to the same unanswered set while you are still composing it.
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

const questionOptionSchema = Type.Object({
  value: Type.String({ description: "Value stored in the answer." }),
  label: Type.String({ description: "Human label shown in the answer panel." }),
  detail: Type.Optional(Type.String({ description: "One line of context under the label." })),
});

const questionSchema = Type.Object({
  id: Type.String({ description: "Stable id, unique within the set." }),
  prompt: Type.String({ description: "The question the operator answers." }),
  kind: Type.Union([Type.Literal("single"), Type.Literal("multi"), Type.Literal("text")], {
    description: "single picks one option, multi picks several, text is free text.",
  }),
  options: Type.Optional(
    Type.Array(questionOptionSchema, {
      description: "Required for single and multi; one choice per value.",
      minItems: 1,
    }),
  ),
  allowOther: Type.Optional(
    Type.Boolean({ description: "Offer a free-text field next to the options." }),
  ),
});

const questionsSchema = Type.Object({
  questions: Type.Array(questionSchema, {
    description: "Questions to put in front of the operator.",
    minItems: 1,
  }),
});

function questionFailure(error: unknown) {
  const message = error instanceof Error ? error.message : "Could not update the questions";
  return { output: [{ type: "text" as const, text: message }], isError: true };
}

function answerToolResult(result: QuestionAnswerResult) {
  return {
    output: [
      {
        type: "text" as const,
        text: `${result.summary}\n${taskQuestionAnswerPayload(result.items, result.record.answers)}`,
      },
    ],
    details: { setId: result.set.id, answers: result.items } as never,
  };
}

/**
 * The two plan-chat question tools. They are bound to one task and share the persisted pending
 * set, so append_questions can grow a set that ask_questions is already waiting on.
 */
export function createTaskQuestionTools(options: {
  taskId: string;
  questions: TaskQuestionsStore;
}): ToolRegistration[] {
  return [
    defineTool({
      name: "ask_questions",
      description:
        "Ask the operator a structured set of questions and wait for the answers. Use single for one choice, multi for several, and text for free text. Every single or multi question needs options. Returns the answers as JSON plus a one-line summary.",
      parameters: questionsSchema,
      replay: "safe",
      async execute(args, api, context) {
        try {
          const parsed = parseTaskQuestions(args.questions);
          if (!parsed.ok) return questionFailure(new Error(parsed.error));
          const askedBy = typeof api.taskId === "string" ? api.taskId : undefined;
          const replayed =
            askedBy === undefined ? null : await options.questions.answeredBy(askedBy);
          if (replayed !== null) return answerToolResult(replayed);
          const { set } = await options.questions.add(options.taskId, parsed.questions, askedBy);
          const answered = await options.questions.waitForAnswers(set.id, context.abortSignal);
          return answerToolResult(answered);
        } catch (error) {
          return questionFailure(error);
        }
      },
    }),
    defineTool({
      name: "append_questions",
      description:
        "Add questions to the same unanswered set ask_questions is composing. Duplicate ids are refused. Use this when you learn something while writing the questions, before the operator answers.",
      parameters: questionsSchema,
      replay: "safe",
      async execute(args, api) {
        try {
          const parsed = parseTaskQuestions(args.questions);
          if (!parsed.ok) return questionFailure(new Error(parsed.error));
          const askedBy = typeof api.taskId === "string" ? api.taskId : undefined;
          const added = await options.questions.add(options.taskId, parsed.questions, askedBy);
          const pending = await options.questions.pending();
          const count = pending?.questions.length ?? added.set.questions.length;
          return {
            output: [
              {
                type: "text" as const,
                text: `Added ${added.added} question${added.added === 1 ? "" : "s"}; ${count} waiting for the operator.\n${JSON.stringify({ setId: added.set.id, questions: added.set.questions })}`,
              },
            ],
            details: { setId: added.set.id, questions: added.set.questions } as never,
          };
        } catch (error) {
          return questionFailure(error);
        }
      },
    }),
  ];
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

/** Exported so the session's submit/settle/dismiss path can be exercised with a fake conversation. */
export class DurableTaskAgentSession implements TaskAgentSession {
  closed = false;
  readonly hub = new StreamHub();
  private runState: RunState = "idle";
  private runError: RunError | null = null;
  /** A deliberate stop must not turn its aborted turn into a phone notification. */
  private stopRequested = false;
  /** One failure id reaches the notifier once, even if a watch replays it. */
  private pushedRunErrorId: string | undefined;
  private currentText = "";
  private currentThinking = "";
  private draftRevision = 0;
  private lastViewEntryId: EntryRecord["id"] | undefined;
  private viewLive: LiveState | undefined;
  private watch: ConversationWatch | undefined;
  /** Follow-ups durable has not placed yet, grouped by submission id. */
  private readonly queued = new Map<string, QueuedMessage>();
  /** Steers still waiting for the current run, by submission id. */
  private readonly steers = new Map<string, QueuedMessage>();
  /** Bumped on every queue/steer mutation; the client's monotonic guard reads this. */
  private queueRevision = 0;

  constructor(
    readonly taskId: string,
    private readonly harness: Harness,
    private readonly conversation: Conversation,
    private readonly questions?: TaskQuestionsStore,
    private readonly onRunState?: (taskId: string) => void,
    private readonly relay?: (frame: SseFrame) => void,
    private readonly media?: MediaStore,
    private readonly onTurnFinished?: (taskId: string) => void | Promise<void>,
    private readonly onRunError?: (input: RunErrorPushInput) => void | Promise<void>,
  ) {}

  private readonly mediaRef = (data: string, mimeType: string) =>
    this.media?.refFor(data, mimeType);

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
    return {
      state: this.runState,
      runError: this.runError,
      queue: this.queueItems(),
      steers: this.steerItems(),
      queueRevision: this.queueRevision,
    };
  }

  private bumpDraft(): number {
    this.draftRevision += 1;
    return this.draftRevision;
  }

  private setRunState(state: RunState, error: RunError | null = this.runError): void {
    if (this.runState === state && this.runError === error) return;
    this.runState = state;
    this.runError = error;
    this.emit({ event: "run.state", data: this.runStatus() });
    this.onRunState?.(this.taskId);
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
    const built = buildTranscript(context.entries, this.mediaRef);
    return {
      taskId: this.taskId,
      messages: visibleTaskAgentMessages(built.messages),
      run: this.runState,
      runError: this.runError,
      draft: {
        text: this.currentText,
        thinking: this.currentThinking,
        revision: this.draftRevision,
      },
      questions: this.questions === undefined ? null : await this.questions.pending(),
      queue: this.queueItems(),
      steers: this.steerItems(),
      queueRevision: this.queueRevision,
    };
  }

  async pendingQuestions(): Promise<TaskQuestionSet | null> {
    return this.questions === undefined ? null : this.questions.pending();
  }

  async answerQuestions(setId: string, answers: unknown): Promise<TaskAgentChatSnapshot> {
    if (this.closed) throw new TaskAgentError("Task agent has been closed", 409);
    if (this.questions === undefined) {
      throw new TaskAgentError("Questions are not available for this task", 409);
    }
    const result = await this.questions.answer(setId, answers);
    const answersBlock = questionAnswerItems(result.record.questions, result.record.answers);
    try {
      await this.conversation.commit(
        (tx) =>
          tx.appendEntry(TaskQuestionAnswerEntry, this.conversation.id, {
            data: {
              setId: result.set.id,
              taskId: this.taskId,
              text: taskQuestionAnswerSummary(answersBlock),
              answers: answersBlock,
              createdAt: result.record.answeredAt,
            },
          }),
        SESSION_CONTEXT,
      );
    } catch (error) {
      console.error(`[task-agent] could not record answers for ${this.taskId}`, error);
    } finally {
      // The tool result must not stay blocked just because the display row failed.
      this.questions.resolve(setId, result);
    }
    return this.snapshot();
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

    // The run state goes out before the transcript rows. A client refresh triggered by
    // `message.done` then cannot read a snapshot from before the run started and paint idle.
    const running = liveRunning(live);
    const wasRunning = liveRunning(previousLive);
    if (running !== wasRunning || (running && this.runState !== "running")) {
      this.setRunState(running ? "running" : "idle");
    }

    if (newEntries.length > 0) {
      const built = buildTranscript(newEntries, this.mediaRef);
      // A placed steer leaves the pending list in the same update as its transcript row.
      // Otherwise a snapshot read before this entry still lists it, and the client would
      // rebuild the pending bubble beside the delivered row.
      let consumedSteer = false;
      for (const message of built.messages) {
        if (this.takeTrackedSteer(message)) consumedSteer = true;
      }
      for (const message of visibleTaskAgentMessages(built.messages)) {
        this.emit({ event: "message.done", data: { message } });
      }
      this.currentText = "";
      this.currentThinking = "";
      this.emit({
        event: "draft.sync",
        data: { text: "", thinking: "", revision: this.bumpDraft() },
      });
      if (consumedSteer) this.broadcastQueue();
    }
  }

  /** Takes a tracked steer off the queue when its transcript entry carries the same key. */
  private takeTrackedSteer(message: ChatMessage, submissionId?: string): boolean {
    if (message.steerKey === undefined) return false;
    let removed = false;
    if (submissionId !== undefined && this.steers.delete(submissionId)) removed = true;
    for (const [id, steer] of this.steers) {
      if (steer.key !== message.steerKey) continue;
      this.steers.delete(id);
      removed = true;
    }
    // Consuming a steer is a queue mutation too: the revision must move before any
    // snapshot taken after this entry is accepted.
    if (removed) this.markQueueChanged();
    return removed;
  }

  private queueItems(): QueuedMessage[] {
    return [...this.queued.values()];
  }

  private steerItems(): QueuedMessage[] {
    return [...this.steers.values()];
  }

  /** Bump before an await can interleave a snapshot read with a queue mutation. */
  private markQueueChanged(): void {
    this.queueRevision += 1;
  }

  private broadcastQueue(): void {
    this.emit({ event: "run.state", data: this.runStatus() });
  }

  /** The placed transcript row for a submission, or the pending row while it waits. */
  private async submittedMessage(
    submission: Submission,
    text: string,
    steer: boolean,
    attachments: string[],
    steerKey: string | undefined,
    pendingKey: string | undefined,
  ): Promise<{ message: ChatMessage; placed: boolean }> {
    const status = (
      submission as { status?: (context: typeof SESSION_CONTEXT) => Promise<unknown> }
    ).status;
    const record =
      typeof status === "function"
        ? ((await status.call(submission, SESSION_CONTEXT)) as
            | { status?: string; entry?: number }
            | undefined)
        : undefined;
    const placed = record === undefined || record.status === "placed" || record.status === "done";
    const entryId = record?.entry;
    if (entryId !== undefined) {
      const context = await this.conversation.context(SESSION_CONTEXT);
      const entry = context.entries.find((candidate) => candidate.id === entryId);
      if (entry !== undefined) {
        const message = buildTranscript([entry], this.mediaRef).messages[0];
        if (message !== undefined) {
          return {
            message: {
              ...message,
              ...(steer ? { steer: true } : {}),
              ...(steerKey === undefined ? {} : { steerKey }),
            },
            placed,
          };
        }
      }
    }
    const pendingId = steer
      ? `steer-pending-${pendingKey ?? String(submission.id)}`
      : `m-${pendingKey ?? String(submission.id)}`;
    return {
      message: {
        id: pendingId,
        role: "user",
        text,
        ...(attachments.length > 0
          ? { attachments: attachments.map((id) => ({ id, mimeType: "image/*" })) }
          : {}),
        timestamp: new Date().toISOString(),
        order: PENDING_QUEUE_ORDER,
        ...(steer ? { steer: true } : {}),
        ...(steerKey === undefined ? {} : { steerKey }),
      },
      placed,
    };
  }

  /**
   * Waits for a submission to be placed or settled, retires its pending queue/steer
   * row, and keeps the plan chat's run-error behaviour identical to the main chat.
   */
  private async monitorSubmission(
    submission: Submission,
    startsRun: boolean,
    queuedId: string | undefined,
    steerId: string | undefined,
  ): Promise<void> {
    let final: Awaited<ReturnType<Submission["wait"]>> | undefined;
    try {
      const settled = await this.identity(() => submission.wait(SESSION_CONTEXT));
      final = settled;
      if (settled.status === "unanswered") {
        console.warn(
          `[task-agent] run ended without an answer for ${this.taskId}: ${settled.reason}` +
            (settled.detail === undefined ? "" : ` (${JSON.stringify(settled.detail)})`),
        );
      }
    } catch (error) {
      console.error(`[task-agent] submission wait failed for ${this.taskId}`, error);
    }

    if (steerId !== undefined && this.steers.has(steerId)) {
      if (final !== undefined && final.status === "unanswered") {
        this.dropTrackedSteer(steerId, steerDropReason(final.reason, final.detail));
      } else if (final !== undefined && final.type === "input" && final.status === "done") {
        // The row may have been placed but the watch has not consumed it yet. Read the
        // entry directly, then leave a failed bubble if the run ended without delivering it.
        if (await this.consumeSteerEntry(final.entry, steerId)) this.broadcastQueue();
        if (this.steers.has(steerId)) {
          this.dropTrackedSteer(steerId, "The run ended before the steer was delivered.");
        }
      } else {
        this.dropTrackedSteer(
          steerId,
          "The server lost track of the steer before it was delivered.",
        );
      }
    }
    if (queuedId !== undefined && this.queued.delete(queuedId)) {
      this.markQueueChanged();
      this.broadcastQueue();
    }

    // `done` is the run's successful answer, including a steer or follow-up placed into it.
    // A failed, stopped or cancelled run settles `unanswered`, and keeps its in-app error.
    if (final !== undefined && final.status === "done") {
      try {
        await this.onTurnFinished?.(this.taskId);
      } catch (error) {
        console.error(`[task-agent] plan notification failed for ${this.taskId}`, error);
      }
    }

    // A cancelled queued follow-up settles `unanswered`/`aborted` while the earlier run is
    // still live. It must not turn that run idle or hand it a run error. The submission that
    // started the run still ends it normally (including a deliberate stop).
    if (final !== undefined && final.status === "unanswered") {
      if (this.closed) return;
      const errorId = `${this.taskId}:${submission.id}`;
      const runError = runErrorFromUnanswered(final.reason, final.detail, errorId);
      const cancelledFollowUp = !startsRun && runError === null;
      if (!cancelledFollowUp) {
        if (runError !== null) {
          this.setRunState(this.runState === "running" ? "idle" : this.runState, runError);
          await this.announceRunError(runError);
        } else if (this.queued.size === 0) {
          this.setRunState(this.runState === "running" ? "idle" : this.runState, this.runError);
        }
      }
    }
  }

  /** Sends one failed planning turn to the phone, unless it was deliberately stopped. */
  private async announceRunError(runError: RunError): Promise<void> {
    if (this.stopRequested || this.pushedRunErrorId === runError.id) return;
    this.pushedRunErrorId = runError.id;
    try {
      await this.onRunError?.({ taskId: this.taskId, message: runError.message });
    } catch (error) {
      console.error(`[task-agent] plan error push failed for ${this.taskId}`, error);
    }
  }

  /** Drops a pending steer and reveals why it never reached the transcript. */
  private dropTrackedSteer(id: string, reason: string): boolean {
    if (!this.steers.delete(id)) return false;
    this.markQueueChanged();
    this.emit({ event: "steer.dropped", data: { id, reason } });
    this.broadcastQueue();
    return true;
  }

  /** Reads a done submission's entry and consumes the pending steer it placed. */
  private async consumeSteerEntry(entryId: number, submissionId: string): Promise<boolean> {
    const context = await this.conversation.context(SESSION_CONTEXT);
    const entry = context.entries.find((candidate) => candidate.id === entryId);
    if (entry === undefined) return false;
    const message = buildTranscript([entry], this.mediaRef).messages[0];
    return message === undefined ? false : this.takeTrackedSteer(message, submissionId);
  }

  /** The shared chat core's send: a queued follow-up or a steer, with main-chat semantics. */
  async send(
    text: string,
    attachments: string[] = [],
    mode: MessageMode = "queue",
    queueKey?: string,
  ): Promise<SubmitMessageResponse> {
    if (this.closed) throw new TaskAgentError("Task agent has been closed", 409);
    if (attachments.length > 0 && this.media === undefined) {
      throw new TaskAgentError("Images cannot be sent in this session", 400);
    }
    const images =
      attachments.length === 0 || this.media === undefined
        ? []
        : await this.media.images(attachments);
    const content =
      images.length === 0
        ? text
        : [...(text.length > 0 ? [{ type: "text" as const, text }] : []), ...images];

    const steer = mode === "steer";
    const startsRun = this.runState !== "running" && this.queued.size === 0;
    const key = queueKey ?? randomUUID();
    const createdAt = new Date().toISOString();
    // Model requests go through billion-context; they must carry this
    // conversation's id, not the main chat's, or the turn can hang or
    // attach itself to the parent session.
    const submission = await this.identity(() =>
      this.conversation.submit(
        {
          type: "input",
          content,
          whenBusy: steer ? "steer" : "followUp",
          requestId: `queue:${key}`,
          entry: {
            kind: steer ? STEER_ENTRY_KIND : QUEUE_ENTRY_KIND,
            data: { key, createdAt },
          },
        },
        SESSION_CONTEXT,
      ),
    );
    if (startsRun) {
      this.stopRequested = false;
      this.setRunState("running", null);
    }
    const id = String(submission.id);
    const { message, placed } = await this.submittedMessage(
      submission,
      text,
      steer,
      attachments,
      steer ? key : undefined,
      key,
    );

    if (steer) {
      if (!placed) {
        this.steers.set(id, {
          id,
          text,
          createdAt,
          key,
          ...(attachments.length > 0 ? { attachments } : {}),
        });
      }
    } else if (!placed) {
      this.queued.set(id, {
        id,
        text,
        createdAt,
        key,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
    }
    this.markQueueChanged();
    this.broadcastQueue();
    void this.monitorSubmission(
      submission,
      startsRun,
      steer ? undefined : id,
      steer ? id : undefined,
    );

    return {
      message,
      mode,
      queued: !steer && !placed,
      placed,
      queue: this.queueItems(),
      steers: this.steerItems(),
      queueRevision: this.queueRevision,
    };
  }

  async cancelQueued(id: string): Promise<boolean> {
    if (!this.queued.has(id)) return false;
    this.queued.delete(id);
    this.markQueueChanged();
    this.broadcastQueue();
    try {
      await this.harness.abortSubmission(
        Number(id) as never,
        SESSION_CONTEXT,
        this.conversation.id,
      );
    } catch (error) {
      console.error(`[task-agent] could not cancel a queued message for ${this.taskId}`, error);
    }
    return true;
  }

  async steerQueued(id: string): Promise<SubmitMessageResponse | null> {
    const item = this.queued.get(id);
    if (item === undefined) return null;
    this.queued.delete(id);
    this.markQueueChanged();
    this.broadcastQueue();
    let aborted = false;
    try {
      aborted =
        (await this.harness.abortSubmission(
          Number(id) as never,
          SESSION_CONTEXT,
          this.conversation.id,
        )) === "aborted";
    } catch (error) {
      console.error(`[task-agent] could not move a queued message for ${this.taskId}`, error);
    }
    // A message durable already placed is in the transcript; sending it again would
    // duplicate it. Return null so the client refreshes from the authoritative state.
    if (!aborted) return null;
    // Do not reuse the queue key: it is also the submission request id, so durable
    // would deduplicate the new steer against the queued submission just aborted.
    return this.send(item.text, item.attachments ?? [], "steer");
  }

  async unsendSteer(id: string): Promise<QueuedMessage | null> {
    const item = this.steers.get(id);
    if (item === undefined) return null;
    let aborted = false;
    try {
      aborted =
        (await this.harness.abortSubmission(
          Number(id) as never,
          SESSION_CONTEXT,
          this.conversation.id,
        )) === "aborted";
    } catch (error) {
      console.error(`[task-agent] could not take back a steer for ${this.taskId}`, error);
    }
    this.steers.delete(id);
    this.markQueueChanged();
    this.broadcastQueue();
    return aborted ? item : null;
  }

  async submit(text: string, attachments: string[] = []): Promise<TaskAgentChatSnapshot> {
    await this.send(text, attachments);
    return this.snapshot();
  }

  async dismissError(id?: string): Promise<TaskAgentChatSnapshot> {
    if (this.runError !== null && (id === undefined || this.runError.id === id)) {
      this.setRunState(this.runState, null);
    }
    return this.snapshot();
  }

  async stop(): Promise<void> {
    if (this.closed || this.runState !== "running") return;
    this.stopRequested = true;
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
    this.stopRequested = true;
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
      const wasRunning = this.runState === "running";
      this.runState = "idle";
      if (wasRunning) this.onRunState?.(this.taskId);
    }
  }
}

export class TaskAgentManager {
  private readonly sessions = new Map<string, TaskAgentSession>();
  private readonly opening = new Map<string, Promise<TaskAgentSession>>();
  private closed = false;
  readonly root: string;
  private readonly planTurnNotifier: PlanTurnNotifier;
  private readonly runErrorNotifier: Pick<RunErrorNotifier, "deliver">;

  constructor(private readonly options: TaskAgentManagerOptions) {
    this.root = join(options.dataDir, "task-agents");
    const runErrorNotify = options.runErrorNotify ?? options.notify;
    this.runErrorNotifier =
      options.runErrorNotifier ??
      new RunErrorNotifier({
        ...(runErrorNotify === undefined ? {} : { notify: runErrorNotify }),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.pushWindowMs === undefined ? {} : { windowMs: options.pushWindowMs }),
        ...(options.burstWindowMs === undefined ? {} : { burstWindowMs: options.burstWindowMs }),
        ...(options.coalesceMs === undefined ? {} : { coalesceMs: options.coalesceMs }),
      });
    this.planTurnNotifier = new PlanTurnNotifier(options.store, {
      ...(options.notify === undefined ? {} : { notify: options.notify }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.pushWindowMs === undefined ? {} : { windowMs: options.pushWindowMs }),
      ...(options.burstWindowMs === undefined ? {} : { burstWindowMs: options.burstWindowMs }),
      ...(options.coalesceMs === undefined ? {} : { coalesceMs: options.coalesceMs }),
    });
  }

  /** Announce one finished planning turn. Exposed so a caller can flush or test the path. */
  notifyTurnFinished(taskId: string): Promise<boolean> {
    return this.planTurnNotifier.notifyTurn(taskId);
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

  async submit(
    taskId: string,
    text: string,
    attachments: string[] = [],
  ): Promise<TaskAgentChatSnapshot> {
    const task = this.options.store.ledger().tasks.find((item) => item.id === taskId);
    if (task === undefined) throw new TaskAgentError("Unknown task", 404);
    if (task.status === "done") {
      throw new TaskAgentError("Task is done", 409);
    }
    const trimmed = text.trim();
    if (trimmed.length === 0 && attachments.length === 0) {
      throw new TaskAgentError("Message text is required", 400);
    }
    const known = projectsOf(this.options.store.ledger().tasks);
    const patch = trimmed.length === 0 ? { message: "" } : openingTaskPatch(task, trimmed, known);
    if (patch.message.length === 0 && attachments.length === 0) {
      throw new TaskAgentError("Message text is required", 400);
    }
    if (patch.title !== undefined || patch.project !== undefined) {
      const ledger = await this.options.store.update(taskId, {
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.project === undefined ? {} : { project: patch.project }),
      });
      this.options.publish(ledger);
    }
    const session = await this.ensure(taskId);
    return session.submit(patch.message, attachments);
  }

  /** Send through the shared client core's main-chat-shaped endpoint. */
  async send(
    taskId: string,
    text: string,
    attachments: string[] = [],
    mode: MessageMode = "queue",
    queueKey?: string,
  ): Promise<SubmitMessageResponse> {
    const task = this.options.store.ledger().tasks.find((item) => item.id === taskId);
    if (task === undefined) throw new TaskAgentError("Unknown task", 404);
    if (task.status === "done") {
      throw new TaskAgentError("Task is done", 409);
    }
    const trimmed = text.trim();
    if (trimmed.length === 0 && attachments.length === 0) {
      throw new TaskAgentError("Message text is required", 400);
    }
    const known = projectsOf(this.options.store.ledger().tasks);
    const patch = trimmed.length === 0 ? { message: "" } : openingTaskPatch(task, trimmed, known);
    if (patch.message.length === 0 && attachments.length === 0) {
      throw new TaskAgentError("Message text is required", 400);
    }
    if (patch.title !== undefined || patch.project !== undefined) {
      const ledger = await this.options.store.update(taskId, {
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.project === undefined ? {} : { project: patch.project }),
      });
      this.options.publish(ledger);
    }
    const session = await this.ensure(taskId);
    if (session.send !== undefined) {
      return session.send(patch.message, attachments, mode, queueKey);
    }
    const snapshot = await session.submit(patch.message, attachments);
    const message = snapshot.messages.at(-1);
    if (message === undefined) {
      throw new TaskAgentError("The message could not be placed", 500);
    }
    return {
      message,
      mode,
      queued: false,
      placed: true,
      queue: snapshot.queue ?? [],
      steers: snapshot.steers ?? [],
      queueRevision: snapshot.queueRevision ?? 0,
    };
  }

  async cancelQueued(taskId: string, id: string): Promise<TaskAgentChatSnapshot> {
    const session = await this.ensure(taskId);
    await session.cancelQueued?.(id);
    return session.snapshot();
  }

  async steerQueued(taskId: string, id: string): Promise<SubmitMessageResponse | null> {
    const session = await this.ensure(taskId);
    return session.steerQueued === undefined ? null : session.steerQueued(id);
  }

  async unsendSteer(
    taskId: string,
    id: string,
  ): Promise<{ steer: QueuedMessage; snapshot: TaskAgentChatSnapshot } | null> {
    const session = await this.ensure(taskId);
    if (session.unsendSteer === undefined) return null;
    const steer = await session.unsendSteer(id);
    return steer === null ? null : { steer, snapshot: await session.snapshot() };
  }

  async dismissError(taskId: string, id?: string): Promise<TaskAgentChatSnapshot> {
    const session = await this.ensure(taskId);
    if (session.dismissError === undefined) return session.snapshot();
    return session.dismissError(id);
  }

  async stopRun(taskId: string): Promise<void> {
    const session = this.sessions.get(taskId);
    if (session === undefined || session.closed) return;
    await session.stop();
  }

  async answerQuestions(
    taskId: string,
    setId: string,
    answers: unknown,
  ): Promise<TaskAgentChatSnapshot> {
    const session = await this.ensure(taskId);
    if (session.answerQuestions === undefined) {
      throw new TaskAgentError("Questions are not available for this task", 409);
    }
    return session.answerQuestions(setId, answers);
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

  /** Task ids whose plan agent has a live run, filtered to work the UI may badge. */
  planningTaskIds(): string[] {
    const running: string[] = [];
    for (const [taskId, session] of this.sessions) {
      if (!session.closed && session.running()) running.push(taskId);
    }
    return derivePlanningTaskIds(this.options.store.ledger().tasks, running);
  }

  private async open(taskId: string): Promise<TaskAgentSession> {
    if (this.options.openSession !== undefined) {
      const session = await this.options.openSession(taskId, this);
      this.sessions.set(taskId, session);
      if (session.running()) this.options.onRunState?.(taskId);
      return session;
    }
    const session = await this.openDurable(taskId);
    this.sessions.set(taskId, session);
    if (session.running()) this.options.onRunState?.(taskId);
    return session;
  }

  private async openDurable(taskId: string): Promise<DurableTaskAgentSession> {
    const task = this.options.store.ledger().tasks.find((item) => item.id === taskId);
    if (task === undefined) throw new TaskAgentError("Unknown task", 404);
    const dir = this.taskDir(taskId);
    await mkdir(dir, { recursive: true });
    const databasePath = join(dir, "pi.sqlite3");
    const currentPath = join(dir, "current.json");
    const questions = new TaskQuestionsStore(join(dir, "questions.json"));
    await questions.load();
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
    registry.install(
      defineExtension({
        name: "task-agent-propose-tool",
        tools: [
          createProposeTaskTool({
            store: this.options.store,
            media: this.options.media,
            publish: this.options.publish,
          }),
        ],
      }),
    );
    registry.install(
      defineExtension({
        name: "task-agent-question-tools",
        tools: createTaskQuestionTools({ taskId, questions }),
      }),
    );
    if (this.options.memory !== undefined) {
      const memoryTools = selectTaskAgentMemoryTools(
        createMemoryTools(this.options.memory.store, this.options.memory.snapshot),
      );
      registry.install(defineExtension({ name: "task-agent-memory-tools", tools: memoryTools }));
    }
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
        settings: taskAgentHarnessSettings(),
        onReport: (report) =>
          console.error(`[task-agent] harness report (${report.kind})`, report.error),
      },
      SESSION_CONTEXT,
    );
    const instructions = taskAgentInstructions(await this.resolveMemoryBase(), task);
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
      questions,
      this.options.onRunState,
      this.options.relay === undefined ? undefined : (frame) => this.options.relay?.(taskId, frame),
      this.options.media,
      (finishedTaskId) => {
        void this.planTurnNotifier.notifyTurn(finishedTaskId);
      },
      async (input) => {
        await this.runErrorNotifier.deliver(input);
      },
    );
    await session.start();
    return session;
  }

  /**
   * The snapshot cache returns its built block without touching memory files;
   * only an invalidation, a new day or a long-term write rebuilds it. Ledger
   * updates therefore compose from the cache instead of rereading the tree.
   */
  private resolveMemoryBase(): Promise<string> {
    return taskAgentMemoryBase(this.options.baseInstructions, this.options.memory);
  }

  private async refreshInstructions(taskId: string): Promise<void> {
    const session = this.sessions.get(taskId);
    if (session === undefined || session.closed || session.applyInstructions === undefined) return;
    const task = this.options.store.ledger().tasks.find((item) => item.id === taskId);
    if (task === undefined) return;
    try {
      const base = await this.resolveMemoryBase();
      await session.applyInstructions(taskAgentInstructions(base, task));
    } catch (error) {
      console.error(`[task-agent] could not refresh instructions for ${taskId}`, error);
    }
  }
}
