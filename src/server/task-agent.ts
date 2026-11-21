import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  loadProjectContextFiles,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import {
  type Conversation,
  type ConversationId,
  type ConversationView,
  type ConversationWatch,
  createRegistry,
  defineExtension,
  defineTool,
  type EntryDraft,
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
import { createCodingTools, createReadTool } from "@earendil-works/pi-durable/tools";
import { Type } from "typebox";
import { parseProjectToken, projectsOf, sameProject } from "../shared/project.js";
import { parseTaskQuestions, taskQuestionAnswerPayload } from "../shared/questions.js";
import { PENDING_QUEUE_ORDER, QUEUE_ENTRY_KIND, queuedNoticeIcon } from "../shared/queue.js";
import { runErrorFromUnanswered } from "../shared/run-error.js";
import { steerDropReason } from "../shared/steers.js";
import { DEFAULT_NEW_TASK_TITLE, isActiveStatus, TASK_BODY_MAX_LENGTH } from "../shared/tasks.js";
import {
  type ActivityItem,
  type ChatMessage,
  type MessageMode,
  type QueuedMessage,
  type QueuedNotice,
  type RunError,
  type RunState,
  STEER_ENTRY_KIND,
  type StreamRunState,
  type SubmitMessageResponse,
  type Task,
  type TaskLedger,
  type TaskQuestionSet,
} from "../shared/types.js";
import { createTimedBashTool } from "./bash-tool.js";
import { withConversationIdentity } from "./billion-context.js";
import { createJobTools } from "./job-tools.js";
import type { JobManager } from "./jobs.js";
import type { MediaStore } from "./media.js";
import { buildSnapshot, composeInstructions, SnapshotCache } from "./memory/snapshot.js";
import type { MemoryStore } from "./memory/store.js";
import { createMemoryTools } from "./memory/tools.js";
import { formatToolArguments, formatToolDetails, formatToolResult } from "./pi.js";
import { PlanTurnNotifier, type PlanTurnPushSender } from "./plan-push.js";
import { retrySettings } from "./retry.js";
import { type RunMarker, RunMarkerStore } from "./run-marker.js";
import { RunErrorNotifier, type RunErrorPushInput, type RunErrorPushSender } from "./run-push.js";
import {
  buildTranscript,
  JOB_NOTICE_ENTRY_KIND,
  SESSION_CONTEXT,
  TASK_ATTACHMENTS_ENTRY_KIND,
  TASK_QUESTION_PROMPT_ENTRY_KIND,
  type TaskQuestionPromptData,
  toolActivityFromEntry,
} from "./session.js";
import type { SseFrame } from "./sse.js";
import { StreamHub } from "./stream-hub.js";
import { type QuestionAnswerResult, TaskQuestionsStore } from "./task-questions.js";
import { createProposeTaskTool, createTaskTools } from "./task-tools.js";
import { TaskError, type TaskStore } from "./tasks.js";
import { diffToolSlots, type ToolSlotFrame } from "./tool-frames.js";

/**
 * The only tools a task planning agent may call: inspect the repo, read the task
 * ledger for this project, edit its task, ask the operator, propose distinct
 * follow-up work for approval, and use memory.
 */
export const TASK_AGENT_MEMORY_TOOL_NAMES = [
  "memory_read",
  "memory_grep",
  "memory_find",
  "memory_status",
  "memory_write",
] as const;
export const TASK_AGENT_TOOL_NAMES = [
  "bash",
  "read",
  "edit_task",
  "propose_task",
  "task_list",
  "task_view",
  "task_depends",
  "ask_questions",
  "append_questions",
  "job_list",
  "job_output",
  "job_cancel",
  ...TASK_AGENT_MEMORY_TOOL_NAMES,
] as const;
export type TaskAgentToolName = (typeof TASK_AGENT_TOOL_NAMES)[number];

const TASK_AGENT_TOOL_SET = new Set<string>(TASK_AGENT_TOOL_NAMES);
const TASK_AGENT_MEMORY_TOOL_SET = new Set<string>(TASK_AGENT_MEMORY_TOOL_NAMES);
/**
 * The memory factory is shared with the main chat. Plan mode may write memory
 * (carried into the main chat by SnapshotCache.notePlanWrite), but dreaming stays
 * forbidden because it is not a plan action.
 */
const TASK_AGENT_FORBIDDEN_TOOL_SET = new Set<string>(["memory_dream"]);

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
  /** Tool calls and thinking blocks from the same transcript the chat page renders. */
  activity: ActivityItem[];
  run: RunState;
  /** The last plan-run failure, until dismissed or the next submit. */
  runError?: RunError | null;
  draft: { text: string; thinking: string; revision: number };
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
  /** Put the task's images in an already-open plan conversation. */
  syncTaskAttachments?(task: Task): Promise<void>;
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
  /** Persist the live turn and close the harness without aborting it. */
  shutdown?(): Promise<void>;
  close(): Promise<void>;
  applyInstructions?(instructions: string): Promise<void>;
  /** The pending set for the answer panel, or null when nothing waits. */
  pendingQuestions?(): Promise<TaskQuestionSet | null>;
  /** Record the operator's answers and nudge the agent with them as a notice. */
  answerQuestions?(setId: string, answers: unknown): Promise<void>;
  /** Clear a pending set and nudge the agent to decide it itself. */
  dismissQuestions?(setId: string): Promise<void>;
  /** Deliver a finished background job's notice to this plan conversation. */
  submitJobNotice?(text: string): Promise<void>;
}

/** The memory tree and the chat snapshot cache; plan sessions keep their own cache. */
export interface TaskAgentMemory {
  readonly store: MemoryStore;
  readonly snapshot?: SnapshotCache;
}

export interface TaskAgentManagerOptions {
  readonly dataDir: string;
  readonly cwd: string;
  readonly models: ModelRuntime;
  readonly model: Model<Api> | undefined;
  readonly store: TaskStore;
  readonly publish: (ledger: TaskLedger) => void;
  /**
   * Base system prompt (coding-agent path with only read and bash described), or a
   * builder for a per-session prompt that already includes the memory block.
   */
  readonly baseInstructions: string | (() => Promise<string>);
  /** The memory tree and snapshot block injected into the plan prompt. */
  readonly memory?: TaskAgentMemory;
  /** Background jobs shared with the chat, so a handed-off plan command reports back. */
  readonly jobs?: JobManager;
  /** Tests inject a fake session instead of opening a durable harness. */
  readonly openSession?: (taskId: string, manager: TaskAgentManager) => Promise<TaskAgentSession>;
  /** Forward session frames onto the main /api/stream so the browser can reuse that EventSource. */
  readonly relay?: (taskId: string, frame: SseFrame) => void;
  /** A plan run started or ended, so the tasks payload can be pushed again with `planning`. */
  readonly onRunState?: (taskId: string) => void;
  /** The pending question set changed, so the tasks payload can be pushed again. */
  readonly onQuestions?: (taskId: string) => void;
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

/** Keep only the memory tools the plan agent is allowed to call. */
export function selectTaskAgentMemoryTools<T extends { name: string }>(tools: readonly T[]): T[] {
  return tools.filter(
    (tool) =>
      TASK_AGENT_MEMORY_TOOL_SET.has(tool.name) && !TASK_AGENT_FORBIDDEN_TOOL_SET.has(tool.name),
  );
}

export interface PlanPromptFingerprintOptions {
  /** Override the home directory in tests. */
  readonly homeDir?: string;
  /** Override the coding agent directory in tests. */
  readonly agentDir?: string;
}

async function fingerprintPath(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return `${path}\u0000${info.mtimeMs}\u0000${info.size}`;
  } catch {
    return `${path}\u0000missing`;
  }
}

/** Include the directories and markdown skill files below one skills root. */
async function collectSkillTree(root: string, paths: Set<string>): Promise<void> {
  paths.add(root);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => undefined);
  if (entries === undefined) return;
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await collectSkillTree(path, paths);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      paths.add(path);
    }
  }
}

/**
 * The plan prompt is rebuilt only when the skills or guidance files it lists have
 * changed. mtimeMs plus size is enough to notice an edit or a newly added skill;
 * a missing path is part of the signature, so creating one also rebuilds.
 */
export async function planPromptFingerprint(
  cwd: string,
  options: PlanPromptFingerprintOptions = {},
): Promise<string> {
  const home = options.homeDir ?? homedir();
  const agentDir = options.agentDir ?? getAgentDir();
  const paths = new Set<string>();
  const skillRoots = [
    join(home, ".agents", "skills"),
    join(agentDir, "skills"),
    join(cwd, ".agents", "skills"),
    join(cwd, ".pi", "skills"),
  ];
  await Promise.all(skillRoots.map((root) => collectSkillTree(root, paths)));
  for (const file of loadProjectContextFiles({ cwd, agentDir })) paths.add(file.path);
  for (const file of [
    join(cwd, "AGENTS.md"),
    join(cwd, "AGENTS.override.md"),
    join(cwd, "CLAUDE.md"),
    join(agentDir, "AGENTS.md"),
  ]) {
    paths.add(file);
  }
  const signatures = await Promise.all([...paths].sort().map((path) => fingerprintPath(path)));
  return signatures.join("\n");
}

export interface PlanPromptBuilderOptions {
  readonly cwd: string;
  /** Re-runs DefaultResourceLoader and returns the coding-agent system prompt. */
  readonly buildBase: () => Promise<string>;
  readonly memory?: TaskAgentMemory;
  /** Set false for PI_PLAN_MEMORY=0; defaults to the environment. */
  readonly memoryEnabled?: boolean;
  /** Override the file fingerprint in tests. */
  readonly fingerprint?: () => Promise<string>;
}

/**
 * One lazy plan-prompt builder shared by every plan session. The expensive
 * coding-agent prompt is memoized on a file fingerprint, while the memory block
 * is composed fresh so a plan never opens with the previous boot's snapshot.
 */
export function createPlanPromptBuilder(options: PlanPromptBuilderOptions): () => Promise<string> {
  let cached: { key: string; base: Promise<string> } | undefined;
  const fingerprint = options.fingerprint ?? (() => planPromptFingerprint(options.cwd));
  return async () => {
    const key = await fingerprint();
    if (cached === undefined || cached.key !== key) {
      const base = options.buildBase();
      cached = { key, base };
      base.catch(() => {
        if (cached?.base === base) cached = undefined;
      });
    }
    const base = await cached.base;
    const memoryEnabled = options.memoryEnabled ?? process.env.PI_PLAN_MEMORY !== "0";
    return taskAgentMemoryBase(base, memoryEnabled ? options.memory : undefined, {
      cwd: options.cwd,
      fresh: true,
    });
  };
}

export interface TaskAgentMemoryBaseOptions {
  /** Read the project's current guidance files as part of the block. */
  readonly cwd?: string;
  /**
   * Build the memory block from the files instead of the shared snapshot cache.
   * Defaults to true so a new session never inherits a block cached at boot.
   */
  readonly fresh?: boolean;
}

const EMBEDDED_PROJECT_CONTEXT = /<project_context>[\s\S]*?<\/project_context>\s*/g;

/** Drop the boot-time project block so the current files can be the only copy. */
function withoutEmbeddedProjectContext(base: string): string {
  return base.replace(EMBEDDED_PROJECT_CONTEXT, "").trimEnd();
}

/**
 * The project guidance a session can be given, using the same files the coding
 * agent loads (AGENTS.override.md, AGENTS.md, CLAUDE.md, ancestor and global
 * files). The skills list itself comes from buildPiSystemPrompt.
 */
export async function taskAgentProjectInstructions(cwd: string): Promise<string | undefined> {
  const files = loadProjectContextFiles({ cwd, agentDir: getAgentDir() });
  const blocks: string[] = [];
  for (const file of files) {
    const content = file.content.replace(/^\uFEFF/, "").trim();
    if (content.length === 0) continue;
    blocks.push(`<project_instructions path="${file.path}">\n${content}\n</project_instructions>`);
  }
  return blocks.length === 0 ? undefined : blocks.join("\n\n");
}

/**
 * Compose the plan's base prompt with the memory snapshot as it is now, plus the
 * current project guidance. The fresh path builds from the files and never
 * invalidates the chat's shared snapshot cache.
 */
export async function taskAgentMemoryBase(
  base: string | (() => Promise<string>),
  memory: TaskAgentMemory | undefined,
  options: TaskAgentMemoryBaseOptions = {},
): Promise<string> {
  const resolved = typeof base === "function" ? await base() : base;
  let prompt = options.cwd === undefined ? resolved : withoutEmbeddedProjectContext(resolved);
  if (memory !== undefined) {
    const cache = memory.snapshot ?? new SnapshotCache();
    const block =
      options.fresh === false
        ? await cache.get(memory.store, "first_turn")
        : await buildSnapshot(memory.store, "first_turn");
    prompt = composeInstructions(prompt, block);
  }
  if (options.cwd !== undefined) {
    const project = await taskAgentProjectInstructions(options.cwd);
    if (project !== undefined) prompt = composeInstructions(prompt, project);
  }
  return prompt;
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

/**
 * Visible chat rows: user and assistant text, plus system notes. A machine notice is
 * shown only when it is a system row, so the plan chat renders answer/dismiss chips
 * without turning user notices into bubbles. Never tool-call lists.
 */
export function visibleTaskAgentMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => {
    if (message.notice !== undefined && message.role !== "system") return false;
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

export interface TaskAgentInstructionOptions {
  /** False when PI_PLAN_MEMORY=0 or no memory store was supplied. */
  readonly memoryEnabled?: boolean;
  /** How many images the task carries, for the prompt header and the look-first rule. */
  readonly attachmentCount?: number;
  /** False when the plan model cannot take image blocks. */
  readonly imagesInContext?: boolean;
}

function taskAttachmentsPrompt(
  task: Pick<Task, "id" | "title">,
  count: number,
  imageInput: boolean,
): string {
  const images = count === 1 ? "image" : "images";
  if (!imageInput) {
    return `Task ${task.id} "${task.title}" has ${count} attached ${images}. This plan model cannot view images, so they are not in your context. Ask the operator to describe what they show or put the important details in the task body before planning from them.`;
  }
  return `Task ${task.id} "${task.title}" has ${count} attached ${images}. These are the task's own attachments and are part of your context. Look at what they actually show — layout, states, visible text and what looks wrong — before you ask the operator anything.`;
}

/** A write whose entry is not yet committed to the transcript. */
interface PendingAttachmentWrite {
  readonly submission: Submission;
  readonly ids: string[];
  /** Whether this write carries image blocks (a text fallback does not). */
  readonly images: boolean;
}

/** Serialize the read-diff-write per conversation, so concurrent PATCHes cannot duplicate. */
const attachmentSyncQueues = new WeakMap<Conversation, Promise<void>>();
/** Writes admitted while the conversation is busy, until durable places or drops them. */
const pendingAttachmentWrites = new WeakMap<Conversation, PendingAttachmentWrite[]>();

async function withAttachmentSync<T>(
  conversation: Conversation,
  run: () => Promise<T>,
): Promise<T> {
  const previous = attachmentSyncQueues.get(conversation) ?? Promise.resolve();
  let release: () => void = () => {};
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  attachmentSyncQueues.set(
    conversation,
    previous.then(
      () => current,
      () => current,
    ),
  );
  await previous.catch(() => undefined);
  try {
    return await run();
  } finally {
    release();
  }
}

/** Keep only writes durable still holds queued; a done or dropped write is in context or gone. */
async function livePendingAttachmentWrites(
  conversation: Conversation,
): Promise<PendingAttachmentWrite[]> {
  const pending = pendingAttachmentWrites.get(conversation) ?? [];
  const live: PendingAttachmentWrite[] = [];
  for (const write of pending) {
    try {
      const record = await write.submission.status(SESSION_CONTEXT);
      if (record.status === "queued") live.push(write);
    } catch {
      // A fake submission, or one whose conversation closed, cannot be inspected.
      // Keep its ids: appending a duplicate image block is worse than skipping one.
      live.push(write);
    }
  }
  if (live.length === 0) pendingAttachmentWrites.delete(conversation);
  else pendingAttachmentWrites.set(conversation, live);
  return live;
}

/**
 * Put the task's images into a plan conversation as a model-facing entry. Only the
 * added ids get image blocks; the entry's data keeps the full current set so the
 * next open, or a later PATCH, can diff without a state file. A text-only model
 * gets a truthful text note instead of image blocks it would reject.
 */
export async function syncTaskAttachments(
  conversation: Conversation,
  task: Pick<Task, "id" | "title" | "attachments">,
  media: MediaStore,
  imageInput = true,
): Promise<void> {
  await withAttachmentSync(conversation, async () => {
    const pending = await livePendingAttachmentWrites(conversation);
    const context = await conversation.context(SESSION_CONTEXT);
    let previous: string[] | undefined;
    for (const entry of context.entries) {
      if (entry.kind !== TASK_ATTACHMENTS_ENTRY_KIND) continue;
      if (!isRecord(entry.data) || !Array.isArray(entry.data.ids)) continue;
      previous = entry.data.ids.filter((id): id is string => typeof id === "string");
    }
    const ids = task.attachments ?? [];
    const known = new Set(previous);
    for (const write of pending) {
      if (write.images) for (const id of write.ids) known.add(id);
    }
    const added = ids.filter((id) => !known.has(id));
    const lastPlanned = pending.at(-1)?.ids ?? previous;
    const unchanged =
      lastPlanned !== undefined &&
      lastPlanned.length === ids.length &&
      lastPlanned.every((id, index) => id === ids[index]);
    if (unchanged || (lastPlanned === undefined && ids.length === 0)) return;
    const createdAt = new Date().toISOString();
    const blocks: Array<
      { type: "image"; data: string; mimeType: string } | { type: "text"; text: string }
    > = [];
    if (imageInput) {
      for (const id of added) {
        try {
          blocks.push(...(await media.images([id])));
        } catch {
          // One bad id must not suppress every image, as in task_view.
          blocks.push({ type: "text", text: `image ${id} is missing` });
        }
      }
    }
    const hasImages = blocks.some((block) => block.type === "image");
    const entry: EntryDraft = {
      kind: TASK_ATTACHMENTS_ENTRY_KIND,
      data: { taskId: task.id, ids, createdAt },
      ...(added.length === 0
        ? {}
        : {
            model: [
              {
                role: "user" as const,
                content: [
                  {
                    type: "text" as const,
                    text: taskAttachmentsPrompt(task, ids.length, imageInput),
                  },
                  ...blocks,
                ],
                timestamp: Date.parse(createdAt),
              },
            ],
          }),
    };
    const submission = await conversation.submit({ type: "write", entry }, SESSION_CONTEXT);
    const writes = pendingAttachmentWrites.get(conversation) ?? [];
    writes.push({ submission, ids: [...ids], images: hasImages });
    pendingAttachmentWrites.set(conversation, writes);
  });
}

export function taskAgentInstructions(
  base: string,
  task: Pick<Task, "id" | "title" | "body" | "project"> & {
    attachments?: readonly string[];
  },
  options: TaskAgentInstructionOptions = {},
): string {
  const project = task.project === undefined ? "none" : task.project;
  const body = task.body === undefined || task.body.length === 0 ? "(empty)" : task.body;
  const memoryEnabled = options.memoryEnabled !== false;
  const attachmentCount = options.attachmentCount ?? task.attachments?.length ?? 0;
  const imagesInContext = options.imagesInContext !== false;
  const attachments =
    attachmentCount === 0
      ? ""
      : imagesInContext
        ? `- attachments: ${attachmentCount} image${attachmentCount === 1 ? "" : "s"} (in your context)\n`
        : `- attachments: ${attachmentCount} image${attachmentCount === 1 ? "" : "s"} (this plan model cannot view images; ask the operator to describe them)\n`;
  const look =
    imagesInContext && attachmentCount > 0
      ? "- **Look before you ask — investigate first.** Images attached to this task are already in your context as the opening user message; describe what you actually see (layout, states, visible text, what looks wrong) before you ask the operator anything. Never ask a question an attached image or the repository already answers: read the code first (`read`, `bash`), then ask only what is genuinely undecidable. If an image is unreadable, say which one and what it should show.\n"
      : "";
  const memoryPolicy = memoryEnabled
    ? `- You must not edit, write, create or delete any workspace files, and you must not run commands that change the workspace. The memory_write tool is the one write you may make, and it only touches the memory store.

Memory and skills:
- The block injected above is the main chat's live memory snapshot: standing rules and map, today, and the open scratchpad. It is truncated, so use memory_find for ranked topic search, memory_grep for literal or regex text across topics, MEMORY.md, SCRATCHPAD.md and recent dailies, memory_read for one body, and memory_status for the tree's size and shape.
- Write to memory only when the operator states a durable instruction: a rule, preference or decision that will matter in later sessions. Use memory_write with target long_term for a topic (append into an existing topic when one fits, with mode append), daily for a dated note, or scratchpad for an open loop. Never write repository facts derivable from the code, the task body, a duplicate of what the snapshot already says, or anything speculative; the operator reads memory later as standing truth.
- After a write, report the path you wrote (topics/<scope>/<slug>.md) and nothing more. Never claim to have recorded something you did not write.
- Skills are listed in the prompt above with absolute paths such as /home/pi/.agents/skills/<name>/SKILL.md and the project's /path/to/repo/.agents/skills/<name>/SKILL.md. Read a skill's SKILL.md before following it. The main chat authors skills (skills-meta), so a skill can be newer than that list: when the work looks skill-shaped, ls or grep the skills directories instead of assuming the list is complete.
- Project guidance lives in the repository's AGENTS.md.`
    : `- You must not edit, write, create or delete any workspace files, and you must not run commands that change the workspace. No memory writer is available in this session.

Skills:
- Memory is disabled for this server, so no memory block was injected and no memory tools are installed. Do not claim to have read or written memory.
- Skills are listed in the prompt above with absolute paths such as /home/pi/.agents/skills/<name>/SKILL.md and the project's /path/to/repo/.agents/skills/<name>/SKILL.md. Read a skill's SKILL.md before following it. The main chat authors skills (skills-meta), so a skill can be newer than that list: when the work looks skill-shaped, ls or grep the skills directories instead of assuming the list is complete.
- Project guidance lives in the repository's AGENTS.md.`;
  return `${base}

You are a planning agent for a single task in pi-ui (id: ${task.id}).
Your job is to help the operator formulate the task and propose a solution — a concrete design for how it would be solved.

Plan mode only:
${memoryPolicy}
- You may use the read and bash tools to inspect the repository.
${look}- You have additional tools, edit_task, propose_task, task_list, task_view, task_depends, ask_questions and append_questions. edit_task updates this task's title, markdown body and/or project. Use it to capture the formulated task: a clear title, a markdown body in the sections below, and a project when one fits.
- Use propose_task with the prompt for a follow-up task. It saves a planning draft whose title and body are that prompt and starts its own plan agent; the operator approves the draft when its body is ready. There is no rationale or flag to pass. Do not propose a duplicate of the task you are planning; propose only distinct follow-up work.
- Before designing, list the other tasks in this project with task_list and open with task_view any whose title suggests the same files, feature or decision. Align by naming the shared module, API or type and the order in which the two must land instead of designing a second mechanism. Record a real ordering with task_depends, in one direction only and never both. A task still in planning is not approved work: read it to avoid conflict, not to assume its outcome exists.
- Investigate before asking. Read the files, the task body, the docs and prior tasks with read/bash
  first; most questions answer themselves.
- Decide alone: naming, file layout, data shape, library choice, UI micro-layout, defaults, test
  style, and anything the repo or the task body already answers. State the decision and its reason
  in the task body instead of asking.
- Ask only when the answer changes what gets built and cannot be derived: product intent, an
  irreversible trade-off, two requirements that contradict each other, or access you cannot see.
  Never ask "should I proceed", "is this ok", "any preferences", or anything already written in the
  task body.
- At most 2 questions in one set, each with 2–4 concrete options, one line of detail, and your
  recommended option named in the detail text.
- ask_questions returns immediately — never wait for answers. Keep working on everything they do not
  block, or end the turn with a short status. The answers arrive as a notice; apply them, then
  update the task body.
- Never re-ask an answered question. If a set was dismissed, decide it yourself.
- Do not change the task's status. The operator owns that.
- Do not list or narrate your tool calls in the task body.
- Write the body as a specification in four \`##\` sections, in this order: \`## Goal\`, \`## Requirements\`,
  \`## Scenarios\`, \`## Architecture\`.
- **Goal** — one sentence: the outcome the operator has when the work lands; no preamble, background,
  file names or steps. If it needs two sentences, it is two tasks.
- **Requirements** — a numbered list of invariants, not steps: guarantees the operator can check, each
  naming the check that covers it when one exists (\`npm test\`, a test file, a command), what must not
  change, and which wins when two conflict. A decision you made alone goes here with its reason.
- **Scenarios** — Gherkin in one fenced \`\`\`gherkin block: \`Feature:\`, then \`Scenario:\` with
  \`Given\`/\`When\`/\`Then\`; happy path, boundary, failure path. If the project has feature files
  (\`find . -name '*.feature'\`), read the closest one first and reuse its \`Feature:\` name, step
  vocabulary and tags, pasting only the scenarios that pin this change; with none, write them anyway —
  they are how the implementer learns what done means.
- **Architecture** — one bullet per module: its path and what changes in it
  (\`src/server/task-agent.ts:601 — taskAgentInstructions gains this block\`); a \`mermaid\` fence only when
  a picture saves a paragraph. No rewritten code, no whole files, no diff.
- Do not invent requirements, scenarios, architecture or acceptance criteria the operator never implied;
  anything undecided goes to ask_questions. Keep the body under ~8,000 characters (the cap is 20,000);
  never paste logs, whole files or a diff. A one-line chore still gets all four headings.

Current task:
- id: ${task.id}
- title: ${task.title}
- project: ${project}
${attachments}- body:
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

/** The model prompt that delivers the operator's choices as decided facts. */
export function questionAnswerPrompt(result: Pick<QuestionAnswerResult, "set" | "items">): string {
  const lines = result.items.map((item) => {
    const choice = item.labels.length > 0 ? item.labels.join(", ") : item.text;
    return `- ${item.prompt}: ${choice.length === 0 ? "(blank)" : choice}`;
  });
  return `The operator answered your questions (set ${result.set.id}).\n${lines.join("\n")}\nTreat these as decided. Do not ask them again; continue the plan and record the design in this task's body.`;
}

/** The model prompt for a dismissed set: the agent owns the decision now. */
export function questionDismissedPrompt(setId: string): string {
  return `Questions dismissed — decide yourself (set ${setId}). Continue the plan and record the decision in this task's body; do not ask them again.`;
}

/**
 * The two plan-chat question tools. They are bound to one task and share the persisted pending
 * set, so append_questions can grow a set the operator has not answered yet.
 */
export function createTaskQuestionTools(options: {
  taskId: string;
  questions: TaskQuestionsStore;
}): ToolRegistration[] {
  return [
    defineTool({
      name: "ask_questions",
      description:
        "Register a structured question set for the operator and return immediately. Investigate first and ask only genuinely unobvious scope-level questions; at most 2, each with 2–4 concrete options and your recommended option named in the detail. Never wait for answers: keep working or end the turn, and the answers arrive as a notice.",
      parameters: questionsSchema,
      replay: "safe",
      async execute(args, api) {
        try {
          const parsed = parseTaskQuestions(args.questions);
          if (!parsed.ok) return questionFailure(new Error(parsed.error));
          // A tool task id is numeric; the call id is the stable string a replay reuses.
          const askedBy = api.callId;
          const replayed = await options.questions.answeredBy(askedBy);
          if (replayed !== null) return answerToolResult(replayed);
          const { set } = await options.questions.add(options.taskId, parsed.questions, askedBy);
          const count = set.questions.length;
          return {
            output: [
              {
                type: "text" as const,
                text: `Registered ${count} question${count === 1 ? "" : "s"} (set ${set.id}): ${set.questions.map((question) => question.id).join(", ")}.\nThe operator answers them on this task's Plan tab.\nDo not wait and do not repeat them. Keep working on what the answers do not block, or end your turn with a short status; the answers arrive as a new notice.`,
              },
            ],
            details: { setId: set.id, questions: set.questions } as never,
          };
        } catch (error) {
          return questionFailure(error);
        }
      },
    }),
    defineTool({
      name: "append_questions",
      description:
        "Add questions to the same unanswered set before the operator answers. Duplicate ids are refused. Same rules as ask_questions: investigate first, ask only genuinely unobvious scope-level questions, at most 2 in the set, and never wait.",
      parameters: questionsSchema,
      replay: "safe",
      async execute(args, api) {
        try {
          const parsed = parseTaskQuestions(args.questions);
          if (!parsed.ok) return questionFailure(new Error(parsed.error));
          const added = await options.questions.add(options.taskId, parsed.questions, api.callId);
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
  /** The durable hint that this task had a live turn, kept beside pi.sqlite3. */
  private marker: RunMarker | undefined;
  private markerTimer: ReturnType<typeof setTimeout> | undefined;
  private markerWrites: Promise<void> = Promise.resolve();
  /** True while shutting down, so an idle state cannot clear the marker being flushed. */
  private shuttingDown = false;

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
    private readonly markerStore?: RunMarkerStore,
    private readonly imagesSupported = true,
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
    if (this.runState === state && this.runError === error) {
      this.maybeClearMarker();
      return;
    }
    this.runState = state;
    this.runError = error;
    this.emit({ event: "run.state", data: this.runStatus() });
    this.onRunState?.(this.taskId);
    this.maybeClearMarker();
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
      activity: built.activity,
      run: this.runState,
      runError: this.runError,
      draft: {
        text: this.currentText,
        thinking: this.currentThinking,
        revision: this.draftRevision,
      },
      queue: this.queueItems(),
      steers: this.steerItems(),
      queueRevision: this.queueRevision,
    };
  }

  async pendingQuestions(): Promise<TaskQuestionSet | null> {
    return this.questions === undefined ? null : this.questions.pending();
  }

  async answerQuestions(setId: string, answers: unknown): Promise<void> {
    if (this.closed) throw new TaskAgentError("Task agent has been closed", 409);
    if (this.questions === undefined) {
      throw new TaskAgentError("Questions are not available for this task", 409);
    }
    const result = await this.questions.answer(setId, answers);
    await this.submitQuestionPrompt({
      setId: result.set.id,
      taskId: this.taskId,
      text: questionAnswerPrompt(result),
      answers: result.items,
      createdAt: result.record.answeredAt,
    });
  }

  async dismissQuestions(setId: string): Promise<void> {
    if (this.closed) throw new TaskAgentError("Task agent has been closed", 409);
    if (this.questions === undefined) {
      throw new TaskAgentError("Questions are not available for this task", 409);
    }
    const set = await this.questions.dismiss(setId);
    await this.submitQuestionPrompt({
      setId: set.id,
      taskId: this.taskId,
      text: questionDismissedPrompt(set.id),
      answers: [],
      createdAt: new Date().toISOString(),
      dismissed: true,
    });
  }

  /**
   * Delivers answers as one notice chip. A follow-up starts an idle run and joins a live
   * one at its next boundary; the set id makes a retried delivery a no-op.
   */
  private async submitQuestionPrompt(data: TaskQuestionPromptData): Promise<void> {
    const startsRun = this.runState !== "running" && this.queued.size === 0;
    const key = `questions:${data.setId}`;
    const submission = await this.identity(() =>
      this.conversation.submit(
        {
          type: "input",
          content: data.text,
          whenBusy: "followUp",
          requestId: key,
          entry: { kind: TASK_QUESTION_PROMPT_ENTRY_KIND, data },
        },
        SESSION_CONTEXT,
      ),
    );
    if (startsRun) {
      this.stopRequested = false;
      this.setRunState("running", null);
    }
    const notice: QueuedNotice = {
      kind: "questions",
      label: data.dismissed === true ? "Questions dismissed" : "Answers sent",
      glyph: "questions",
    };
    const id = String(submission.id);
    const { placed } = await this.submittedMessage(
      submission,
      data.text,
      false,
      [],
      undefined,
      key,
      notice,
    );
    if (!placed) {
      this.queued.set(id, {
        id,
        text: data.text,
        createdAt: data.createdAt,
        key,
        notice,
      });
    }
    this.markQueueChanged();
    this.broadcastQueue();
    void this.monitorSubmission(submission, startsRun, id, undefined);
  }

  async applyInstructions(instructions: string): Promise<void> {
    if (this.closed) return;
    await this.conversation.configure({ instructions }, SESSION_CONTEXT);
  }

  async syncTaskAttachments(task: Task): Promise<void> {
    if (this.closed || this.media === undefined) return;
    await syncTaskAttachments(this.conversation, task, this.media, this.imagesSupported);
  }

  private identity<T>(run: () => T): T {
    // The numeric conversation id is unique only inside this task's
    // sqlite file. billion-context keys sessions process-wide, so stamp a
    // name that cannot collide with the main chat or another task.
    return withConversationIdentity(`task-agent:${this.taskId}`, run);
  }

  async start(): Promise<void> {
    if (this.markerStore !== undefined) {
      try {
        this.marker = await this.markerStore.read();
      } catch (error) {
        console.error(`[task-agent] could not read the run marker for ${this.taskId}`, error);
      }
    }
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
    // A stop requested before the process died is settled by the boot restore; never
    // let opening the task chat quietly continue it.
    if (this.marker?.stopRequested !== true) {
      this.identity(() => this.harness.resume());
      const inspection = await this.harness.inspect(SESSION_CONTEXT);
      if (inspection.tasks.length > 0 || inspection.submissions.length > 0) {
        this.setRunState("running");
      }
    }
    this.maybeClearMarker();
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

    for (const frame of diffToolSlots(view.entries, previousLive, live)) {
      this.emitToolFrame(frame);
    }

    if (newEntries.length > 0) {
      const built = buildTranscript(newEntries, this.mediaRef);
      // A job result rebuilds as its chip and its activity row; durable committed it already,
      // so both match what a later snapshot builds.
      for (const activity of built.activity) {
        if (activity.kind === "job") {
          this.emit({ event: "activity", data: { activity } });
        }
      }
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

  /** Emit the same tool frames the main chat publishes, using the committed result row when present. */
  private emitToolFrame(frame: ToolSlotFrame): void {
    if (frame.type === "start") {
      this.emit({
        event: "tool.start",
        data: {
          toolCallId: frame.toolCallId,
          name: frame.toolName,
          arguments: frame.args,
          timestamp: new Date().toISOString(),
        },
      });
      return;
    }
    const committed =
      frame.entry === undefined ? undefined : toolActivityFromEntry(frame.entry, frame.args);
    const result = frame.result;
    // This is the same fallback `ChatService.toolActivity` uses when no committed row exists.
    const activity = committed ?? {
      kind: "tool" as const,
      id: `local-${frame.toolCallId}`,
      toolCallId: frame.toolCallId,
      name: frame.toolName,
      arguments: formatToolArguments(frame.args),
      output: result?.output === undefined ? "The tool did not finish." : formatToolResult(result),
      details: formatToolDetails(result?.details),
      isError: result?.isError ?? true,
      durationMs: result?.durationMs,
      timestamp: new Date().toISOString(),
      order: Number.MAX_SAFE_INTEGER,
    };
    this.emit({
      event: "tool.end",
      data: {
        toolCallId: frame.toolCallId,
        name: activity.name,
        isError: activity.isError,
        output: activity.output,
        durationMs: activity.durationMs,
        timestamp: activity.timestamp,
        activity,
      },
    });
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
    void this.persistMarkerState();
    this.maybeClearMarker();
  }

  /** Keep the durable hint in step with the pending queue without a write per mutation. */
  private async persistMarkerState(flush = false): Promise<void> {
    const marker = this.marker;
    if (marker === undefined) return;
    this.marker = {
      ...marker,
      queue: this.queueItems(),
      updatedAt: new Date().toISOString(),
    };
    if (flush) {
      await this.flushMarkerState();
      return;
    }
    this.scheduleMarkerWrite();
  }

  private scheduleMarkerWrite(): void {
    if (this.markerTimer !== undefined) return;
    this.markerTimer = setTimeout(() => {
      this.markerTimer = undefined;
      const marker = this.marker;
      if (marker !== undefined) void this.writeMarker(marker);
    }, 0);
    this.markerTimer.unref?.();
  }

  private async flushMarkerState(): Promise<void> {
    if (this.markerTimer !== undefined) {
      clearTimeout(this.markerTimer);
      this.markerTimer = undefined;
    }
    const marker = this.marker;
    if (marker !== undefined) await this.writeMarker(marker);
    else await this.markerWrites;
  }

  private async writeMarker(marker: RunMarker): Promise<void> {
    if (this.markerStore === undefined) return;
    this.markerWrites = this.markerWrites
      .then(() => this.markerStore?.write(marker))
      .catch((error: unknown) => {
        console.error(`[task-agent] could not persist the run marker for ${this.taskId}`, error);
      });
    await this.markerWrites;
  }

  private async clearMarker(): Promise<void> {
    this.marker = undefined;
    if (this.markerTimer !== undefined) {
      clearTimeout(this.markerTimer);
      this.markerTimer = undefined;
    }
    if (this.markerStore === undefined) return;
    this.markerWrites = this.markerWrites
      .then(() => this.markerStore?.clear())
      .catch((error: unknown) => {
        console.error(`[task-agent] could not clear the run marker for ${this.taskId}`, error);
      });
    await this.markerWrites;
  }

  private maybeClearMarker(): void {
    if (this.closed || this.shuttingDown) return;
    if (this.runState !== "idle" || this.queued.size > 0 || this.steers.size > 0) return;
    void this.clearMarker();
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
    notice?: QueuedNotice,
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
        role: notice === undefined ? "user" : "system",
        text,
        ...(attachments.length > 0
          ? { attachments: attachments.map((id) => ({ id, mimeType: "image/*" })) }
          : {}),
        timestamp: new Date().toISOString(),
        order: PENDING_QUEUE_ORDER,
        ...(steer ? { steer: true } : {}),
        ...(steerKey === undefined ? {} : { steerKey }),
        ...(notice === undefined ? {} : { notice }),
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
    if (startsRun) {
      this.stopRequested = false;
      this.marker = {
        version: 1,
        userMessage: text,
        startedAt: createdAt,
        mode,
        stopRequested: false,
        idempotencyKey: randomUUID(),
        queue: this.queueItems(),
        partialEntryId: null,
        updatedAt: new Date().toISOString(),
      };
      // The hint must be on disk before durable admits the turn: a process that dies
      // after the submission is placed must still leave enough behind to resume it.
      await this.flushMarkerState();
      this.setRunState("running", null);
    }
    let submission: Submission;
    // Model requests go through billion-context; they must carry this
    // conversation's id, not the main chat's, or the turn can hang or
    // attach itself to the parent session.
    try {
      submission = await this.identity(() =>
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
    } catch (error) {
      if (startsRun) {
        await this.clearMarker();
        this.setRunState("idle", null);
      }
      throw error;
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

  /** Delivers a finished job's notice as a queued message in this plan conversation. */
  async submitJobNotice(text: string): Promise<void> {
    if (this.closed) throw new TaskAgentError("Task agent has been closed", 409);
    const startsRun = this.runState !== "running" && this.queued.size === 0;
    const key = randomUUID();
    const createdAt = new Date().toISOString();
    const submission = await this.identity(() =>
      this.conversation.submit(
        {
          type: "input",
          content: text,
          whenBusy: "followUp",
          requestId: `queue:${key}`,
          entry: {
            kind: JOB_NOTICE_ENTRY_KIND,
            data: { text, createdAt, ...(startsRun ? {} : { queueKey: key }) },
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
    const { placed } = await this.submittedMessage(submission, text, false, [], undefined, key);
    if (!placed) {
      this.queued.set(id, {
        id,
        text,
        createdAt,
        key,
        notice: {
          kind: JOB_NOTICE_ENTRY_KIND,
          label: "Background job",
          glyph: queuedNoticeIcon(JOB_NOTICE_ENTRY_KIND),
        },
      });
    }
    this.markQueueChanged();
    this.broadcastQueue();
    void this.monitorSubmission(submission, startsRun, placed ? undefined : id, undefined);
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
    if (this.marker !== undefined) {
      this.marker = {
        ...this.marker,
        stopRequested: true,
        updatedAt: new Date().toISOString(),
      };
      await this.persistMarkerState(true);
    }
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

  /** Delete or replace: abort the turn and forget the marker before the directory goes. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopRequested = true;
    this.shuttingDown = true;
    void this.watch?.stop();
    this.watch = undefined;
    await this.clearMarker();
    try {
      if (this.runState === "running") {
        await this.identity(() => this.conversation.abort(SESSION_CONTEXT));
      }
    } catch {
      // Closing anyway.
    }
    await this.closeHarness();
  }

  /** Process shutdown: keep the live turn and its marker for the next boot. */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopRequested = true;
    this.shuttingDown = true;
    void this.watch?.stop();
    this.watch = undefined;
    await this.flushMarkerState();
    await this.closeHarness();
  }

  private async closeHarness(): Promise<void> {
    try {
      await Promise.race([
        this.harness.close(SESSION_CONTEXT),
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

/**
 * A plan session holds a durable store, a harness and its own transcript. Opening one per
 * task and keeping it for the life of the process cost 2.5 MB each: 298 tasks reached
 * 750 MB and pushed the heap into a GC storm at V8's container-sized cap. A session nobody
 * is looking at is closed and reopened on demand instead.
 */
const IDLE_SESSION_MS = 10 * 60_000;
/** Idle sessions kept open even before one has been idle long enough to expire. */
const IDLE_SESSION_MAX = 8;
const IDLE_SWEEP_MS = 60_000;

export class TaskAgentManager {
  private readonly sessions = new Map<string, TaskAgentSession>();
  /** When each open session was last asked for, so the sweep can tell idle from in use. */
  private readonly lastUsed = new Map<string, number>();
  /** Pending question stores live as long as the manager, so badging does not need a session. */
  private readonly questionStores = new Map<string, TaskQuestionsStore>();
  private sweeper: ReturnType<typeof setInterval> | undefined;
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
    this.sweeper = setInterval(() => void this.evictIdle(), IDLE_SWEEP_MS);
    this.sweeper.unref?.();
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
    if (existing !== undefined && !existing.closed) {
      this.lastUsed.set(taskId, this.clock());
      return existing;
    }
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

  /**
   * Delivers a finished job's notice to a live plan session. It never opens a session:
   * a notice for a closed plan pane is recorded in the main chat as its chip and activity
   * row instead of a paid plan turn.
   */
  async submitJobNotice(taskId: string, text: string): Promise<boolean> {
    const session = this.sessions.get(taskId);
    if (session === undefined || session.closed || session.submitJobNotice === undefined) {
      return false;
    }
    await session.submitJobNotice(text);
    return true;
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

  /**
   * Seed an already-open plan conversation with images attached to its task.
   * A closed session needs no work: the next open diffs the attachments itself.
   */
  async syncTaskAttachments(taskId: string): Promise<void> {
    if (this.options.media === undefined) return;
    const opening = this.opening.get(taskId);
    if (opening !== undefined) {
      try {
        await opening;
      } catch {
        return;
      }
    }
    const session = this.sessions.get(taskId);
    if (session === undefined || session.closed || session.syncTaskAttachments === undefined)
      return;
    const task = this.options.store.ledger().tasks.find((item) => item.id === taskId);
    if (task === undefined) return;
    try {
      await session.syncTaskAttachments(task);
      await this.refreshInstructions(taskId);
    } catch (error) {
      console.error(`[task-agent] could not sync attachments for ${taskId}`, error);
    }
  }

  async answerQuestions(taskId: string, setId: string, answers: unknown): Promise<void> {
    const session = await this.ensure(taskId);
    if (session.answerQuestions === undefined) {
      throw new TaskAgentError("Questions are not available for this task", 409);
    }
    await session.answerQuestions(setId, answers);
  }

  async dismissQuestions(taskId: string, setId: string): Promise<void> {
    const session = await this.ensure(taskId);
    if (session.dismissQuestions === undefined) {
      throw new TaskAgentError("Questions are not available for this task", 409);
    }
    await session.dismissQuestions(setId);
  }

  /** Drop any pending plan question set when the task leaves planning, without waking the agent. */
  async clearQuestions(taskId: string): Promise<void> {
    const store = this.questionStores.get(taskId);
    if (store !== undefined) await store.clearPending();
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
    this.lastUsed.delete(taskId);
    this.questionStores.delete(taskId);
    if (session !== undefined) await session.close();
    await rm(this.taskDir(taskId), { recursive: true, force: true });
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.sweeper !== undefined) clearInterval(this.sweeper);
    this.sweeper = undefined;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.lastUsed.clear();
    this.questionStores.clear();
    // A deploy is not a stop: leave every live plan turn for the next boot to resume.
    await Promise.all(
      sessions.map((session) =>
        session.shutdown === undefined ? session.close() : session.shutdown(),
      ),
    );
  }

  /**
   * Closes the plan sessions nobody is using: never one with a live run, and never more
   * than `IDLE_SESSION_MAX` idle ones. Returns the task ids closed, so a test can assert
   * the choice without a timer. A closed session reopens on the next request.
   */
  async evictIdle(): Promise<string[]> {
    const now = this.clock();
    const idle: Array<{ taskId: string; session: TaskAgentSession; usedAt: number }> = [];
    for (const [taskId, session] of this.sessions) {
      if (session.closed || session.running()) continue;
      idle.push({ taskId, session, usedAt: this.lastUsed.get(taskId) ?? now });
    }
    idle.sort((left, right) => left.usedAt - right.usedAt);
    const expired = idle.filter((item) => now - item.usedAt >= IDLE_SESSION_MS);
    const excess = idle.slice(0, Math.max(0, idle.length - IDLE_SESSION_MAX));
    const closing = new Map<string, TaskAgentSession>();
    for (const item of [...expired, ...excess]) closing.set(item.taskId, item.session);
    for (const taskId of closing.keys()) {
      this.sessions.delete(taskId);
      this.lastUsed.delete(taskId);
    }
    await Promise.all(
      [...closing].map(async ([taskId, session]) => {
        try {
          await session.close();
        } catch (error) {
          console.error(`[task-agent] could not close the idle session for ${taskId}`, error);
        }
      }),
    );
    return [...closing.keys()];
  }

  /** Open plan sessions right now, for the periodic memory line. */
  poolSize(): number {
    return this.sessions.size;
  }

  /**
   * Open every plan turn the previous process left live. The marker only selects
   * candidates; pi-durable decides whether there is work left to resume. Idle plans
   * and tasks deleted or finished while the process was down stay closed.
   */
  async restore(): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.root, { withFileTypes: true });
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return [];
      throw error;
    }
    const resumed: string[] = [];
    for (const entry of entries) {
      if (this.closed) break;
      if (!entry.isDirectory()) continue;
      const taskId = entry.name;
      try {
        // A pending set must badge after a restart even when no run needs resuming.
        await this.ensureQuestionStore(taskId);
      } catch (error) {
        console.error(`[task-agent] could not read questions for ${taskId}`, error);
      }
      const markerStore = new RunMarkerStore(this.taskDir(taskId), "run.json");
      let marker: RunMarker | undefined;
      try {
        marker = await markerStore.read();
      } catch (error) {
        console.error(`[task-agent] could not read the run marker for ${taskId}`, error);
        continue;
      }
      if (marker === undefined) continue;
      const task = this.options.store.ledger().tasks.find((item) => item.id === taskId);
      if (task === undefined || task.status === "done" || marker.stopRequested) {
        try {
          await markerStore.clear();
        } catch (error) {
          console.error(`[task-agent] could not clear the stale run marker for ${taskId}`, error);
        }
        continue;
      }
      try {
        await this.ensure(taskId);
        resumed.push(taskId);
        console.log(`[task-agent] resuming plan turn for ${taskId}`);
      } catch (error) {
        console.error(`[task-agent] could not resume plan for ${taskId}`, error);
      }
    }
    return resumed;
  }

  /** Kept for callers from before the marker-based restore. */
  resumeInterrupted(): Promise<string[]> {
    return this.restore();
  }

  private clock(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** The pending question set on the tasks payload, without opening or awaiting a session. */
  pendingQuestions(taskId: string): TaskQuestionSet | null {
    return this.questionStores.get(taskId)?.pendingSync() ?? null;
  }

  /** Task ids with an unanswered question set, so the tasks payload can badge them. */
  questionTaskIds(): string[] {
    const ids: string[] = [];
    for (const [taskId, store] of this.questionStores) {
      if (store.pendingSync() !== null) ids.push(taskId);
    }
    return ids;
  }

  /** Task ids whose plan agent has a live run, filtered to work the UI may badge. */
  planningTaskIds(): string[] {
    const running: string[] = [];
    for (const [taskId, session] of this.sessions) {
      if (!session.closed && session.running()) running.push(taskId);
    }
    return derivePlanningTaskIds(this.options.store.ledger().tasks, running);
  }

  private async ensureQuestionStore(taskId: string): Promise<TaskQuestionsStore> {
    const existing = this.questionStores.get(taskId);
    if (existing !== undefined) return existing;
    const dir = this.taskDir(taskId);
    await mkdir(dir, { recursive: true });
    const store = new TaskQuestionsStore(join(dir, "questions.json"), () =>
      this.options.onQuestions?.(taskId),
    );
    await store.load();
    this.questionStores.set(taskId, store);
    return store;
  }

  private async open(taskId: string): Promise<TaskAgentSession> {
    if (this.options.openSession !== undefined) {
      await this.ensureQuestionStore(taskId);
      const session = await this.options.openSession(taskId, this);
      this.sessions.set(taskId, session);
      this.lastUsed.set(taskId, this.clock());
      if (session.running()) this.options.onRunState?.(taskId);
      return session;
    }
    const session = await this.openDurable(taskId);
    this.sessions.set(taskId, session);
    this.lastUsed.set(taskId, this.clock());
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
    const markerStore = new RunMarkerStore(dir, "run.json");
    const questions = await this.ensureQuestionStore(taskId);
    const storage = await openNodeSqliteStorage(databasePath);
    const registry = createRegistry<ToolRegistration>();
    const coding =
      this.options.jobs === undefined
        ? (createCodingTools().tools ?? []).filter(
            (tool) => tool.name === "read" || tool.name === "bash",
          )
        : [
            createReadTool(),
            createTimedBashTool(this.options.jobs, {
              owner: { kind: "plan", taskId },
            }),
          ];
    registry.install(defineExtension({ name: "task-agent-coding-tools", tools: coding }));
    if (this.options.jobs !== undefined) {
      const jobTools = selectTaskAgentTools(createJobTools(this.options.jobs));
      if (jobTools.length > 0) {
        registry.install(defineExtension({ name: "task-agent-job-tools", tools: jobTools }));
      }
    }
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
        name: "task-agent-task-tools",
        tools: createTaskTools(
          {
            store: this.options.store,
            ...(this.options.media === undefined ? {} : { media: this.options.media }),
            plan: async (id, body) => {
              await this.submit(id, body);
            },
            publish: this.options.publish,
          },
          { scope: { taskId } },
        ),
      }),
    );
    registry.install(
      defineExtension({
        name: "task-agent-question-tools",
        tools: createTaskQuestionTools({ taskId, questions }),
      }),
    );
    const memoryTools = this.planMemoryTools(taskId);
    if (memoryTools.length > 0) {
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
    const imagesInContext = this.planAcceptsImages();
    const instructions = taskAgentInstructions(await this.resolveMemoryBase(true), task, {
      memoryEnabled: this.planMemory() !== undefined,
      attachmentCount: task.attachments?.length ?? 0,
      imagesInContext,
    });
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
    if (this.options.media !== undefined) {
      try {
        await syncTaskAttachments(conversation, task, this.options.media, imagesInContext);
      } catch (error) {
        console.error(`[task-agent] could not seed attachments for ${taskId}`, error);
      }
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
      markerStore,
      imagesInContext,
    );
    await session.start();
    return session;
  }

  /** The plan agent's propose_task, with this manager as the submitter of the new draft's run. */
  proposeTool(): ToolRegistration {
    return createProposeTaskTool({
      store: this.options.store,
      media: this.options.media,
      plan: async (id, body) => {
        await this.submit(id, body);
      },
      publish: this.options.publish,
    });
  }

  /** The plan keeps its own snapshot cache for instructions while tools share the chat's cache. */
  private readonly planSnapshot = new SnapshotCache();

  /** The memory tools use the shared cache, so a long-term write invalidates the chat's block. */
  private planMemory(): TaskAgentMemory | undefined {
    if (process.env.PI_PLAN_MEMORY === "0") return undefined;
    if (this.options.memory === undefined) return undefined;
    return {
      store: this.options.memory.store,
      snapshot: this.options.memory.snapshot ?? this.planSnapshot,
    };
  }

  /** Plan instructions keep their own cache so reading/writing them never disturbs the chat. */
  private planResolutionMemory(): TaskAgentMemory | undefined {
    if (process.env.PI_PLAN_MEMORY === "0") return undefined;
    if (this.options.memory === undefined) return undefined;
    return { store: this.options.memory.store, snapshot: this.planSnapshot };
  }

  /**
   * The plan registry's memory tools, with the same write path as chat. A long-term
   * write invalidates the shared cache and is carried into the main chat's next
   * instructions; the plan session itself is refreshed from the files immediately.
   */
  planMemoryTools(taskId: string): ToolRegistration[] {
    const memory = this.planMemory();
    if (memory === undefined) return [];
    return selectTaskAgentMemoryTools(
      createMemoryTools(memory.store, memory.snapshot, {
        onWrite: (record) => {
          this.options.memory?.snapshot?.notePlanWrite(record);
          this.planSnapshot.invalidate();
          return this.refreshInstructions(taskId);
        },
      }),
    );
  }

  private async resolveMemoryBase(fresh: boolean): Promise<string> {
    if (typeof this.options.baseInstructions === "function") {
      return this.options.baseInstructions();
    }
    if (fresh) this.planSnapshot.invalidate();
    return taskAgentMemoryBase(this.options.baseInstructions, this.planResolutionMemory(), {
      cwd: this.options.cwd,
      fresh,
    });
  }

  /** Whether the plan model can take image blocks; a text-only model gets a text note. */
  private planAcceptsImages(): boolean {
    const input = this.options.model?.input;
    return Array.isArray(input) && input.includes("image");
  }

  /** Rebuild a live plan session's instructions from the current task and files. */
  async refreshInstructions(taskId: string, fresh = false): Promise<void> {
    const session = this.sessions.get(taskId);
    if (session === undefined || session.closed || session.applyInstructions === undefined) return;
    const task = this.options.store.ledger().tasks.find((item) => item.id === taskId);
    if (task === undefined) return;
    try {
      const base = await this.resolveMemoryBase(fresh);
      await session.applyInstructions(
        taskAgentInstructions(base, task, {
          memoryEnabled: this.planMemory() !== undefined,
          attachmentCount: task.attachments?.length ?? 0,
          imagesInContext: this.planAcceptsImages(),
        }),
      );
    } catch (error) {
      console.error(`[task-agent] could not refresh instructions for ${taskId}`, error);
    }
  }
}
