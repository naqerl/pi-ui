import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  AssistantEntry,
  type Conversation,
  createRegistry,
  defineExtension,
  type EntryRecord,
  type Harness,
  Harness as HarnessImpl,
  LiveDoc,
  MemoryStorage,
  type ModelRef,
  type ToolRegistration,
  ToolResultEntry,
  type UsageState,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import type { DelegateRunStatus, DelegateRunView, DelegateTokenUsage } from "../shared/types.js";
import { withConversationIdentity } from "./billion-context.js";
import { createAcpDelegateTools } from "./delegate-tools.js";
import { buildPiSystemPrompt } from "./pi.js";

/** The role table is the one place a delegate's tool subset is composed. */
export const DELEGATE_ROLES = {
  reviewer: {
    readOnly: true,
    tools: ["read", "bash"],
    prompt: `You are a senior code reviewer with read-only access.
Read the given code and report: bugs, security/safety risks, correctness issues, and concrete improvement suggestions.
Be specific — cite file:line for every finding. Do NOT modify any files; only read and report.`,
  },
  researcher: {
    readOnly: true,
    tools: ["read", "bash"],
    prompt: `You are a code researcher with read-only access.
Investigate the codebase to answer the question thoroughly. Report findings with exact file:line references, function/type signatures, and relevant code snippets.
Do NOT modify any files; only read and report.`,
  },
  worker: {
    readOnly: false,
    tools: ["read", "bash", "edit", "write"],
    prompt: `You are a precise implementer.
Make exactly the requested code changes — minimal, focused, following existing project conventions (check AGENTS.md first if present).
After editing, briefly summarize what you changed and why. Do not expand scope.`,
  },
  planner: {
    readOnly: true,
    tools: ["read", "bash"],
    prompt: `You are a technical planner with read-only access.
Analyze the task and produce a concrete, ordered step-by-step implementation plan with rationale for each step.
Cite file:line for code you reference. Do NOT modify any files; only read and propose.`,
  },
  oracle: {
    readOnly: true,
    tools: ["read", "bash"],
    prompt: `You are an expert advisor with read-only access.
Answer the question concisely with clear reasoning. Cite file:line when referencing code. Do NOT modify any files.`,
  },
} as const satisfies Record<
  string,
  { readonly readOnly: boolean; readonly tools: readonly string[]; readonly prompt: string }
>;

export type DelegateRole = keyof typeof DELEGATE_ROLES;
export const DELEGATE_ROLE_NAMES = Object.keys(DELEGATE_ROLES) as DelegateRole[];

const DELEGATE_PROMPT = `You are a pi-ui sub-agent running in a clean, independent durable conversation.
You do not see the parent conversation, its transcript, or its tools. Everything you need is in the task below.
When you are done, write the complete answer as your final assistant message. That answer becomes your result file.
Do not ask the user a question unless the task explicitly requires one; the parent is waiting for a result.`;

const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const MAX_PER_CALL_TIMEOUT_MINUTES = 1_440;

/** Most delegates running at once. Extra runs stay queued in launch order. */
export const MAX_CONCURRENT_DELEGATES = positiveIntegerEnv("PI_ACP_DELEGATE_MAX_CONCURRENT", 4);
/** Root runs have depth 0; the default lets a root delegate run, but not a delegate of a delegate. */
export const MAX_DELEGATE_DEPTH = positiveIntegerEnv("PI_ACP_DELEGATE_MAX_DEPTH", 1);
const DEFAULT_TIMEOUT_MINUTES = positiveNumberEnv("PI_ACP_DELEGATE_ASYNC_TIMEOUT_MINUTES", 30);

export class DelegateError extends Error {}

export interface DelegateManagerOptions {
  readonly dataDir: string;
  readonly cwd: string;
  readonly models: ModelRuntime;
  readonly model: Model<Api> | undefined;
}

export interface DelegateStartOptions {
  readonly agent: DelegateRole;
  readonly task: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
  readonly async?: boolean;
  readonly timeoutMinutes?: number;
  /** Depth of the new run. Root tools pass 0; tools inside a delegate pass the delegate's depth. */
  readonly depth?: number;
  /** Whether completion/failure injects a notice. Sync runs and explicit cancels stay quiet. */
  readonly notify?: boolean;
  /** Where a completion notice goes. Defaults to the manager's chat notifier. */
  readonly onFinish?: (text: string) => void | Promise<void>;
}

export interface DelegateWaitResult {
  readonly run: DelegateRunView;
  readonly timedOut: boolean;
  readonly result: string;
}

interface SerializedDelegateRun {
  id: string;
  agent: DelegateRole;
  task: string;
  cwd: string;
  status: DelegateRunStatus;
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  depth: number;
  timeoutMinutes: number;
  notify: boolean;
  model?: ModelRef;
  thinkingLevel?: ModelThinkingLevel;
  usage?: DelegateTokenUsage;
  error?: string;
}

interface DelegateRun extends SerializedDelegateRun {
  result?: string;
  cancelRequested: boolean;
  timedOut?: string;
  controller: AbortController;
  done: Promise<void>;
  finish: () => void;
  onFinish?: (text: string) => void | Promise<void>;
  submissionId?: string;
}

interface ActiveDelegate {
  readonly harness: Harness;
  readonly conversation: Conversation;
}

/** Distinguishes temporary index files written by concurrent managers in this process. */
let writeSequence = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function positiveNumberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function firstLine(text: string, limit = 160): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`;
}

function formatDuration(
  startedAt: string | null,
  endedAt: string | null,
  now = Date.now(),
): string {
  if (startedAt === null) return "queued";
  const end = endedAt === null ? now : Date.parse(endedAt);
  const seconds = Math.max(0, Math.round((end - Date.parse(startedAt)) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
    if (part.type === "thinking" && typeof part.thinking === "string") parts.push(part.thinking);
  }
  return parts.join("\n");
}

function entryText(entry: EntryRecord | undefined): string {
  if (entry === undefined) return "";
  const message: unknown = entry.model?.[0];
  if (!isRecord(message)) return "";
  const text = contentText(message.content);
  const error = typeof message.errorMessage === "string" ? message.errorMessage : "";
  return [text, error].filter((part) => part.trim().length > 0).join("\n");
}

function latestAssistantText(entries: readonly EntryRecord[]): string {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry === undefined || !AssistantEntry.is(entry)) continue;
    const text = entryText(entry);
    if (text.trim().length > 0) return text;
  }
  return "";
}

function liveText(value: unknown): string {
  if (!isRecord(value)) return "";
  const generation = isRecord(value.generation) ? value.generation : undefined;
  const message = generation?.message;
  if (!isRecord(message)) return "";
  return contentText(message.content);
}

function usageTotals(state: UsageState | undefined): DelegateTokenUsage | undefined {
  if (state === undefined) return undefined;
  let input = 0;
  let output = 0;
  let total = 0;
  let cost = 0;
  let seen = false;
  for (const bucket of [state.models, state.tools]) {
    for (const usage of Object.values(bucket)) {
      if (!isRecord(usage)) continue;
      const nextInput = typeof usage.input === "number" ? usage.input : 0;
      const nextOutput = typeof usage.output === "number" ? usage.output : 0;
      const cacheRead = typeof usage.cacheRead === "number" ? usage.cacheRead : 0;
      const cacheWrite = typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0;
      const nextTotal =
        typeof usage.totalTokens === "number"
          ? usage.totalTokens
          : nextInput + nextOutput + cacheRead + cacheWrite;
      input += nextInput;
      output += nextOutput;
      total += nextTotal;
      if (isRecord(usage.cost) && typeof usage.cost.total === "number") cost += usage.cost.total;
      seen = true;
    }
  }
  return seen ? { input, output, total, cost } : undefined;
}

function activityLineFromEntry(entry: EntryRecord): string | null {
  if (AssistantEntry.is(entry)) {
    const message: unknown = entry.model?.[0];
    if (!isRecord(message) || !Array.isArray(message.content)) return null;
    const lines: string[] = [];
    for (const block of message.content) {
      if (!isRecord(block) || block.type !== "toolCall") continue;
      const name = typeof block.name === "string" ? block.name : "tool";
      let args = "";
      try {
        args = JSON.stringify(block.arguments ?? {});
      } catch {
        args = String(block.arguments);
      }
      lines.push(`[tool] ${name} ${args.length > 500 ? `${args.slice(0, 499)}…` : args}`);
    }
    return lines.length === 0 ? null : `${lines.join("\n")}\n`;
  }
  if (ToolResultEntry.is(entry)) {
    const message: unknown = entry.model?.[0];
    if (!isRecord(message)) return null;
    const name = typeof message.toolName === "string" ? message.toolName : "tool";
    const failed = message.isError === true;
    const text = contentText(message.content).trim().split("\n")[0] ?? "";
    return `[result] ${name}${failed ? " failed" : " ok"}: ${text.slice(0, 500)}\n`;
  }
  return null;
}

/**
 * In-process delegates. Each run gets an independent durable Harness over memory storage, so its
 * context and token usage never mix with the parent conversation. The parent gets a run id at once;
 * completion is written to a result file and announced once as a chat notice.
 */
export class DelegateManager {
  private readonly dir: string;
  private readonly indexPath: string;
  private readonly runs = new Map<string, DelegateRun>();
  private readonly active = new Map<string, ActiveDelegate>();
  private readonly queue: string[] = [];
  private readonly promptCache = new Map<string, string>();
  private readonly writes = new Map<string, Promise<void>>();
  private indexWrite: Promise<void> = Promise.resolve();
  private notifier: ((text: string) => void | Promise<void>) | undefined;
  private activeCount = 0;
  private shuttingDown = false;

  constructor(private readonly options: DelegateManagerOptions) {
    this.dir = join(options.dataDir, "delegates");
    this.indexPath = join(this.dir, "delegates.json");
  }

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    let saved: SerializedDelegateRun[] = [];
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, "utf8")) as {
        runs?: SerializedDelegateRun[];
      };
      saved = Array.isArray(parsed.runs) ? parsed.runs : [];
    } catch {
      saved = [];
    }
    let changed = false;
    for (const raw of saved) {
      if (typeof raw?.id !== "string" || typeof raw.task !== "string") continue;
      const status: DelegateRunStatus =
        raw.status === "running" || raw.status === "queued" ? "failed" : raw.status;
      if (status !== raw.status) changed = true;
      const run = this.hydrate({
        ...raw,
        status,
        endedAt:
          status === "failed" && raw.endedAt === null ? new Date().toISOString() : raw.endedAt,
        ...(status === "failed" && raw.error === undefined
          ? { error: "pi-ui restarted before the delegate finished." }
          : {}),
      });
      this.runs.set(run.id, run);
    }
    if (changed) this.save();
  }

  setNotifier(notifier: ((text: string) => void | Promise<void>) | undefined): void {
    this.notifier = notifier;
  }

  list(): DelegateRunView[] {
    return [...this.runs.values()]
      .sort((left, right) => right.queuedAt.localeCompare(left.queuedAt))
      .map((run) => this.viewOf(run));
  }

  get(id: string): DelegateRun {
    const run = this.runs.get(id.trim());
    if (run === undefined) {
      throw new DelegateError(`Unknown delegate run ${id}. Use /activity to see run ids.`);
    }
    return run;
  }

  async start(options: DelegateStartOptions): Promise<DelegateRunView> {
    if (this.shuttingDown)
      throw new DelegateError("pi-ui is shutting down; no delegate can start.");
    const task = typeof options.task === "string" ? options.task.trim() : "";
    if (task.length === 0) {
      throw new DelegateError("The delegate task is empty. Give it a self-contained task.");
    }
    const agent = options.agent;
    if (!Object.hasOwn(DELEGATE_ROLES, agent)) {
      throw new DelegateError(
        `Unknown delegate role "${String(agent)}". Choose one of: ${DELEGATE_ROLE_NAMES.join(", ")}.`,
      );
    }
    const depth = options.depth ?? 0;
    if (depth >= MAX_DELEGATE_DEPTH) {
      throw new DelegateError(
        `Delegate nesting limit reached (depth ${depth}, max ${MAX_DELEGATE_DEPTH}). This delegate cannot spawn further delegates.`,
      );
    }
    const cwd = resolve(options.cwd?.trim() || this.options.cwd);
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(cwd);
    } catch {
      throw new DelegateError(`The delegate working directory does not exist: ${cwd}`);
    }
    if (!info.isDirectory()) {
      throw new DelegateError(`The delegate working directory is not a directory: ${cwd}`);
    }
    const model = this.resolveModel(options.model);
    const thinkingLevel = this.resolveThinkingLevel(options.thinkingLevel);
    const timeoutMinutes = this.resolveTimeout(options.timeoutMinutes);
    const async = options.async !== false;
    const now = new Date().toISOString();
    const id = `del_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const run = this.hydrate({
      id,
      agent,
      task,
      cwd,
      status: "queued",
      queuedAt: now,
      startedAt: null,
      endedAt: null,
      depth,
      timeoutMinutes,
      notify: options.notify ?? async,
      ...(model === undefined ? {} : { model }),
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    });
    run.onFinish = options.onFinish;
    this.runs.set(id, run);
    this.queue.push(id);
    this.save();
    this.pump();
    return this.viewOf(run);
  }

  async wait(id: string, timeoutMs: number): Promise<DelegateWaitResult> {
    const run = this.get(id);
    const timedOut = await new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        resolve(value);
      };
      timer = setTimeout(() => finish(true), Math.max(0, timeoutMs));
      timer.unref?.();
      void run.done.then(() => finish(false));
    });
    if (timedOut) return { run: this.viewOf(run), timedOut: true, result: "" };
    return {
      run: this.viewOf(run),
      timedOut: false,
      result: (await this.read(run.id, "result")) ?? "",
    };
  }

  cancel(id: string): DelegateRunView {
    const run = this.get(id);
    if (run.status === "queued") {
      const index = this.queue.indexOf(run.id);
      if (index >= 0) this.queue.splice(index, 1);
      run.status = "cancelled";
      run.endedAt = new Date().toISOString();
      run.error = "Cancelled before it started.";
      run.result = run.error;
      void this.writeResult(run);
      this.save();
      run.finish();
      return this.viewOf(run);
    }
    if (run.status === "running") {
      run.cancelRequested = true;
      run.status = "cancelled";
      run.endedAt = new Date().toISOString();
      run.error = "Cancelled by the parent.";
      void this.abortRun(run);
      this.save();
    }
    return this.viewOf(run);
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const live = [...this.runs.values()].filter(
      (run) => run.status === "queued" || run.status === "running",
    );
    for (const run of live) this.cancel(run.id);
    await Promise.race([
      Promise.all(live.map((run) => run.done)),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        timer.unref?.();
      }),
    ]);
    await this.indexWrite.catch(() => undefined);
  }

  async read(id: string, kind: "result" | "activity"): Promise<string | undefined> {
    const run = this.get(id);
    try {
      return await readFile(this.pathOf(run, kind), "utf8");
    } catch {
      return undefined;
    }
  }

  private hydrate(raw: SerializedDelegateRun): DelegateRun {
    let finish: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      finish = () => resolve();
    });
    const terminal = raw.status !== "queued" && raw.status !== "running";
    if (terminal) finish();
    return {
      ...raw,
      cancelRequested: false,
      controller: new AbortController(),
      done,
      finish,
    };
  }

  private pump(): void {
    if (this.shuttingDown) return;
    while (this.activeCount < MAX_CONCURRENT_DELEGATES && this.queue.length > 0) {
      const id = this.queue.shift();
      if (id === undefined) return;
      const run = this.runs.get(id);
      if (run === undefined || run.status !== "queued") continue;
      this.activeCount += 1;
      void this.execute(run).finally(() => {
        this.activeCount = Math.max(0, this.activeCount - 1);
        this.pump();
      });
    }
  }

  private async execute(run: DelegateRun): Promise<void> {
    run.status = "running";
    run.startedAt = new Date().toISOString();
    this.save();
    await this.appendActivity(
      run,
      `[delegate] ${run.agent} started at ${run.startedAt}\nTask: ${firstLine(run.task)}\n`,
    );
    let harness: Harness | undefined;
    let conversation: Conversation | undefined;
    let watch: Awaited<ReturnType<Conversation["watch"]>> | undefined;
    try {
      const storage = new MemoryStorage();
      const registry = createRegistry<ToolRegistration>();
      registry.install(
        defineExtension({
          name: "delegate-coding-tools",
          tools: createCodingTools().tools ?? [],
        }),
      );
      const conversationRef: { current?: Conversation } = {};
      const nestedTools = createAcpDelegateTools(this, run.depth + 1, async (text) => {
        const parent = conversationRef.current;
        if (parent === undefined) return;
        await parent.submit(
          {
            type: "input",
            content: text,
            entry: {
              kind: "ui.delegate-notice",
              data: { text, createdAt: new Date().toISOString() },
            },
          },
          BACKGROUND_CONTEXT,
        );
      });
      registry.install(
        defineExtension({
          name: "delegate-delegate-tools",
          tools: nestedTools,
        }),
      );
      harness = await HarnessImpl.open(
        storage,
        {
          models: this.options.models as unknown as Parameters<
            typeof HarnessImpl.open
          >[1]["models"],
          registry,
          env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? run.cwd }),
          settings: {
            compaction: { enabled: false },
            retry: { enabled: false },
            steeringMode: "all",
          },
        },
        BACKGROUND_CONTEXT,
      );
      const role = DELEGATE_ROLES[run.agent];
      const instructions = await this.instructions(run.cwd, run.agent);
      const enabledTools = new Set([
        ...role.tools,
        "acp_delegate",
        "acp_delegate_wait",
        "acp_delegate_cancel",
      ]);
      const tools = registry
        .snapshot()
        .tools()
        .filter(({ tool }) => enabledTools.has(tool.name))
        .map(({ tool }) => tool);
      conversation = await harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: {
            cwd: run.cwd,
            instructions,
            ...(run.model === undefined ? {} : { model: run.model }),
            ...(run.thinkingLevel === undefined ? {} : { thinkingLevel: run.thinkingLevel }),
            tools,
          },
        },
        BACKGROUND_CONTEXT,
      );
      conversationRef.current = conversation;
      this.active.set(run.id, { harness, conversation });
      watch = await conversation.watch(BACKGROUND_CONTEXT, { min: 100, max: 200 });
      this.observeActivity(run, watch);
      harness.resume();

      const timer = setTimeout(() => {
        run.timedOut = `after ${run.timeoutMinutes}m`;
        void this.abortRun(run);
      }, run.timeoutMinutes * 60_000);
      timer.unref?.();

      const outcome = await withConversationIdentity(String(conversation.id), async () => {
        const submission = await conversation?.submit(
          { type: "input", content: run.task },
          BACKGROUND_CONTEXT,
        );
        if (submission === undefined) throw new DelegateError("The delegate conversation closed.");
        run.submissionId = String(submission.id);
        return submission.wait(BACKGROUND_CONTEXT);
      });
      clearTimeout(timer);

      run.usage = usageTotals(await harness.usage(BACKGROUND_CONTEXT));
      const entries = (await conversation.context(BACKGROUND_CONTEXT)).entries;
      if (run.cancelRequested) {
        run.status = "cancelled";
        run.error ??= "Cancelled by the parent.";
        run.result = this.partialResult(run, latestAssistantText(entries));
      } else if (run.timedOut !== undefined) {
        run.status = "failed";
        run.error = `Timed out ${run.timedOut}.`;
        run.result = this.partialResult(run, latestAssistantText(entries));
      } else if (outcome.status === "done") {
        const answer = entryText(entries.find((entry) => entry.id === outcome.answer));
        if (answer.trim().length === 0) {
          throw new DelegateError("The delegate finished without a final answer.");
        }
        run.status = "completed";
        run.result = answer;
      } else {
        const detail = typeof outcome.detail === "string" ? `: ${outcome.detail}` : "";
        throw new DelegateError(
          `The run ended without an answer (${outcome.reason}${detail}).${latestAssistantText(entries).trim().length > 0 ? `\n\nPartial output:\n${latestAssistantText(entries)}` : ""}`,
        );
      }
    } catch (error) {
      if (run.status !== "cancelled") {
        run.status = run.cancelRequested ? "cancelled" : "failed";
        run.error = run.cancelRequested
          ? (run.error ?? "Cancelled by the parent.")
          : run.timedOut !== undefined
            ? `Timed out ${run.timedOut}.`
            : errorMessage(error);
      }
      if (run.result === undefined) {
        const partial =
          (await this.capturePartial(harness, conversation)) ||
          (await this.captureContextText(conversation));
        run.result = this.partialResult(run, partial);
      }
    } finally {
      if (watch !== undefined) await watch.stop().catch(() => undefined);
      if (harness !== undefined && run.usage === undefined) {
        run.usage = usageTotals(await harness.usage(BACKGROUND_CONTEXT).catch(() => undefined));
      }
      if (harness !== undefined) await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
      this.active.delete(run.id);
      run.endedAt ??= new Date().toISOString();
      if (run.status === "running") {
        run.status = "failed";
        run.error ??= "The delegate stopped unexpectedly.";
      }
      if (run.result === undefined) run.result = run.error ?? "(no output)";
      await this.writeResult(run);
      await this.appendActivity(
        run,
        `[delegate] ${run.status}${run.error === undefined ? "" : `: ${run.error}`}\n`,
      );
      this.save();
      if (
        run.notify &&
        !run.cancelRequested &&
        (run.status === "completed" || run.status === "failed")
      ) {
        const text = this.noticeText(run);
        try {
          await (run.onFinish ?? this.notifier)?.(text);
        } catch (error) {
          console.error(`[delegate] ${run.id} notice failed`, error);
        }
      }
      run.finish();
    }
  }

  private observeActivity(
    run: DelegateRun,
    watch: Awaited<ReturnType<Conversation["watch"]>>,
  ): void {
    let newest = 0;
    watch.start(async (call) => {
      if (call.kind !== "value") return;
      for (const entry of call.value.entries) {
        if (entry.id <= newest) continue;
        newest = entry.id;
        const line = activityLineFromEntry(entry);
        if (line !== null) await this.appendActivity(run, line);
      }
    });
  }

  private async abortRun(run: DelegateRun): Promise<void> {
    run.controller.abort();
    const active = this.active.get(run.id);
    if (active === undefined) return;
    await active.conversation
      .abort(BACKGROUND_CONTEXT, { background: true })
      .catch(() => undefined);
  }

  private async capturePartial(
    harness: Harness | undefined,
    conversation: Conversation | undefined,
  ): Promise<string> {
    if (harness === undefined || conversation === undefined) return "";
    try {
      const live = await harness.snapshot(LiveDoc, conversation.id, BACKGROUND_CONTEXT);
      return liveText(live);
    } catch {
      return "";
    }
  }

  private async captureContextText(conversation: Conversation | undefined): Promise<string> {
    if (conversation === undefined) return "";
    try {
      return latestAssistantText((await conversation.context(BACKGROUND_CONTEXT)).entries);
    } catch {
      return "";
    }
  }

  private partialResult(run: DelegateRun, partial: string): string {
    const head =
      run.status === "cancelled"
        ? `Cancelled: ${run.error ?? "the parent stopped this run."}`
        : `Failed: ${run.error ?? "the run ended without an answer."}`;
    return partial.trim().length > 0 ? `${head}\n\nPartial output:\n${partial.trim()}` : head;
  }

  private async instructions(cwd: string, agent: DelegateRole): Promise<string> {
    let base = this.promptCache.get(cwd);
    if (base === undefined) {
      base = await buildPiSystemPrompt(cwd, this.options.models);
      this.promptCache.set(cwd, base);
    }
    return `${base}\n\n${DELEGATE_PROMPT}\n\nRole: ${agent}\n${DELEGATE_ROLES[agent].prompt}\n\nThe task is the next user message.`;
  }

  private resolveModel(requested: string | undefined): ModelRef | undefined {
    const model = requested?.trim();
    if (model === undefined || model.length === 0) {
      const current = this.options.model;
      return current === undefined
        ? undefined
        : { provider: current.provider, modelId: current.id };
    }
    const slash = model.indexOf("/");
    if (slash <= 0 || slash === model.length - 1) {
      throw new DelegateError(
        'model must be "provider/id", for example "anthropic/claude-sonnet-4-5".',
      );
    }
    const ref = { provider: model.slice(0, slash), modelId: model.slice(slash + 1) };
    if (this.options.models.getModel(ref.provider, ref.modelId) === undefined) {
      throw new DelegateError(`Unknown model ${model}.`);
    }
    return ref;
  }

  private resolveThinkingLevel(value: string | undefined): ModelThinkingLevel | undefined {
    const level = value?.trim();
    if (level === undefined || level.length === 0) return undefined;
    if (!(VALID_THINKING_LEVELS as readonly string[]).includes(level)) {
      throw new DelegateError(
        `Unknown thinkingLevel "${level}". Choose one of: ${VALID_THINKING_LEVELS.join(", ")}.`,
      );
    }
    return level as ModelThinkingLevel;
  }

  private resolveTimeout(value: number | undefined): number {
    if (value === undefined || !Number.isFinite(value) || value <= 0) {
      return DEFAULT_TIMEOUT_MINUTES;
    }
    return Math.min(value, MAX_PER_CALL_TIMEOUT_MINUTES);
  }

  private viewOf(run: DelegateRun): DelegateRunView {
    return {
      id: run.id,
      agent: run.agent,
      task: run.task,
      taskFirstLine: firstLine(run.task),
      cwd: run.cwd,
      status: run.status,
      queuedAt: run.queuedAt,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      durationMs:
        run.startedAt === null
          ? 0
          : Math.max(
              0,
              (run.endedAt === null ? Date.now() : Date.parse(run.endedAt)) -
                Date.parse(run.startedAt),
            ),
      duration: formatDuration(run.startedAt, run.endedAt),
      ...(run.usage === undefined ? {} : { usage: { ...run.usage } }),
      ...(run.error === undefined ? {} : { error: run.error }),
      resultPath: this.pathOf(run, "result"),
      activityPath: this.pathOf(run, "activity"),
      resultUrl: `/api/delegates/${encodeURIComponent(run.id)}/result`,
      activityUrl: `/api/delegates/${encodeURIComponent(run.id)}/activity`,
    };
  }

  private pathOf(run: DelegateRun, kind: "result" | "activity"): string {
    return join(this.dir, `${run.id}.${kind === "result" ? "out" : "activity"}`);
  }

  private noticeText(run: DelegateRun): string {
    const completed = run.status === "completed";
    const status = completed ? "completed" : "FAILED ⚠️";
    const outcome = completed ? "completed" : "failed";
    const lines = [
      `[acp_delegate ${status}] **${run.agent}** (runId \`${run.id}\`) ${outcome} after ${formatDuration(run.startedAt, run.endedAt)}.`,
      `Task: ${firstLine(run.task)}`,
      `Result: ${this.pathOf(run, "result")}`,
      `Activity: ${this.pathOf(run, "activity")}`,
      ...(run.usage === undefined
        ? []
        : [
            `Tokens: ${run.usage.input.toLocaleString()} in, ${run.usage.output.toLocaleString()} out.`,
          ]),
      ...(run.error === undefined ? [] : [`Error: ${firstLine(run.error, 500)}`]),
      "This is an automated system notification, not a user message. Read the result file if you need details, then continue your original task.",
    ];
    return lines.join("\n");
  }

  private async appendActivity(run: DelegateRun, text: string): Promise<void> {
    const path = this.pathOf(run, "activity");
    const previous = this.writes.get(path) ?? Promise.resolve();
    const next = previous
      .then(() => writeFile(path, text, { flag: "a" }))
      .catch((error: unknown) => {
        console.error(`[delegate] ${run.id} activity write failed`, error);
      });
    this.writes.set(path, next);
    await next;
    if (this.writes.get(path) === next) this.writes.delete(path);
  }

  private async writeResult(run: DelegateRun): Promise<void> {
    const path = this.pathOf(run, "result");
    const body = `${run.result ?? run.error ?? "(no output)"}\n`;
    try {
      await mkdir(this.dir, { recursive: true });
      const temporary = `${path}.${process.pid}.${++writeSequence}.tmp`;
      await writeFile(temporary, body);
      await rename(temporary, path);
    } catch (error) {
      console.error(`[delegate] ${run.id} result write failed`, error);
    }
  }

  private save(): void {
    const runs: SerializedDelegateRun[] = [...this.runs.values()].map((run) => ({
      id: run.id,
      agent: run.agent,
      task: run.task,
      cwd: run.cwd,
      status: run.status,
      queuedAt: run.queuedAt,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      depth: run.depth,
      timeoutMinutes: run.timeoutMinutes,
      notify: run.notify,
      ...(run.model === undefined ? {} : { model: run.model }),
      ...(run.thinkingLevel === undefined ? {} : { thinkingLevel: run.thinkingLevel }),
      ...(run.usage === undefined ? {} : { usage: run.usage }),
      ...(run.error === undefined ? {} : { error: run.error }),
    }));
    const body = `${JSON.stringify({ runs }, null, 2)}\n`;
    this.indexWrite = this.indexWrite
      .then(async () => {
        await mkdir(this.dir, { recursive: true });
        const temporary = `${this.indexPath}.${process.pid}.${++writeSequence}.tmp`;
        try {
          await writeFile(temporary, body);
          await rename(temporary, this.indexPath);
        } catch (error) {
          console.error("[delegate] could not save the delegate list", error);
        }
      })
      .catch((error: unknown) => {
        console.error("[delegate] could not save the delegate list", error);
      });
  }
}
