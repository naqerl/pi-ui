import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  AssistantEntry,
  type Conversation,
  type ConversationId,
  createRegistry,
  defineExtension,
  type EntryRecord,
  type Harness,
  Harness as HarnessImpl,
  type ToolRegistration,
  type UsageState,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import type { DelegateRunStatus, DelegateRunView, DelegateTokenUsage } from "../shared/types.js";
import { withConversationIdentity } from "./billion-context.js";
import { buildPiSystemPrompt } from "./pi.js";
import { retrySettings } from "./retry.js";

const DELEGATE_TOOLS = ["read", "bash", "edit", "write"] as const;

const DELEGATE_PROMPT = `You are a pi-ui sub-agent doing local work the parent chat handed you: config, files, and host commands.
You do not see the parent conversation. Everything you need is in the user message.
Use read, bash, edit, and write. Do not ask the operator a question.
When you are done, write a short report as your final message: what you changed, what you ran, and anything still blocked.`;

/** Told to the chat when a turn was in flight and the process restarted. */
export const DELEGATE_RESTART_ERROR = "pi-ui restarted before this turn finished.";

/** Most sub-agents running at once. Extra prompts stay queued in launch order. */
export const MAX_CONCURRENT_DELEGATES = positiveIntegerEnv("PI_ACP_DELEGATE_MAX_CONCURRENT", 4);
/** Idle sessions kept open so acp_delegate_continue can resume them. Oldest past this are closed. */
export const MAX_IDLE_DELEGATES = 8;
const DEFAULT_TIMEOUT_MINUTES = positiveNumberEnv("PI_ACP_DELEGATE_ASYNC_TIMEOUT_MINUTES", 30);
const EXCERPT_CHARS = 1_500;

export class DelegateError extends Error {}

/** One turn of a sub-agent. The manager does not wait on it inside the chat tool. */
export interface DelegateTurnResult {
  readonly text: string;
  readonly usage?: DelegateTokenUsage;
  readonly error?: string;
  readonly cancelled?: boolean;
}

/** A kept sub-agent session. submit starts one turn and resolves when that turn ends. */
export interface DelegateSession {
  submit(prompt: string): Promise<DelegateTurnResult>;
  abort(): void;
  close(): Promise<void>;
}

export interface DelegateManagerOptions {
  readonly dataDir: string;
  readonly cwd: string;
  readonly models: ModelRuntime;
  readonly model: Model<Api> | undefined;
  /** Tests inject this. Production opens a sqlite harness per sub-agent. */
  readonly openSession?: (run: { id: string; cwd: string }) => Promise<DelegateSession>;
}

export interface DelegateStartOptions {
  readonly prompt: string;
  readonly cwd?: string;
}

type TurnOutcome = "completed" | "failed" | "cancelled";

interface SerializedDelegateRun {
  id: string;
  task: string;
  cwd: string;
  status: DelegateRunStatus;
  queuedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  timeoutMinutes: number;
  closed?: boolean;
  pendingNotice?: boolean;
  lastOutcome?: TurnOutcome;
  usage?: DelegateTokenUsage;
  error?: string;
}

interface TurnGate {
  readonly done: Promise<void>;
  finish: () => void;
}

interface DelegateRun extends SerializedDelegateRun {
  result?: string;
  cancelRequested: boolean;
  timedOut?: string;
  /** True while a prompt has been accepted and not yet finished. */
  turnOpen: boolean;
  gate: TurnGate;
}

/** Distinguishes temporary files written by concurrent managers in this process. */
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

function excerpt(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length <= EXCERPT_CHARS) return trimmed;
  return `${trimmed.slice(0, EXCERPT_CHARS - 1)}…`;
}

function createGate(): TurnGate {
  let settled = false;
  let finish = () => undefined;
  const done = new Promise<void>((resolve) => {
    finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
  });
  return { done, finish };
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

function isOutcome(value: unknown): value is TurnOutcome {
  return value === "completed" || value === "failed" || value === "cancelled";
}

/**
 * Sub-agents for local work the chat should not sit inside. Each one is its own durable
 * conversation. acp_delegate and acp_delegate_continue return as soon as the prompt is accepted.
 * The chat hears about the turn from one chip, then can continue the same session.
 */
export class DelegateManager {
  private readonly dir: string;
  private readonly indexPath: string;
  private readonly runs = new Map<string, DelegateRun>();
  private readonly sessions = new Map<string, DelegateSession>();
  private readonly queue: string[] = [];
  private readonly promptCache = new Map<string, string>();
  private readonly writes = new Map<string, Promise<void>>();
  private indexWrite: Promise<void> = Promise.resolve();
  private notifier: ((text: string) => void | Promise<void>) | undefined;
  private changeListener: (() => void) | undefined;
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
      const loaded = this.loadRun(raw);
      if (loaded.changed) changed = true;
      this.runs.set(loaded.run.id, loaded.run);
    }
    if (changed) this.save();
  }

  setNotifier(notifier: ((text: string) => void | Promise<void>) | undefined): void {
    this.notifier = notifier;
  }

  /** Called whenever a run is queued, starts, or finishes. The dock and activity page render this. */
  onChange(listener: (() => void) | undefined): void {
    this.changeListener = listener;
  }

  /**
   * One chip for every turn that was in flight when the process stopped.
   * Call this after setNotifier. A session with a saved database stays continuable.
   */
  async flushBootNotices(): Promise<void> {
    const pending = [...this.runs.values()].filter((run) => run.pendingNotice === true);
    for (const run of pending) {
      try {
        await this.notifier?.(this.noticeText(run));
        run.pendingNotice = false;
      } catch (error) {
        console.error(`[delegate] ${run.id} restart notice failed`, error);
      }
    }
    if (pending.length > 0) this.save();
  }

  list(): DelegateRunView[] {
    return [...this.runs.values()]
      .sort((left, right) => right.queuedAt.localeCompare(left.queuedAt))
      .map((run) => this.viewOf(run));
  }

  get(id: string): DelegateRunView {
    return this.viewOf(this.run(id));
  }

  /** Accept a prompt and return. The turn runs after this resolves. */
  async start(options: DelegateStartOptions): Promise<DelegateRunView> {
    if (this.shuttingDown)
      throw new DelegateError("pi-ui is shutting down; no sub-agent can start.");
    const task = typeof options.prompt === "string" ? options.prompt.trim() : "";
    if (task.length === 0) {
      throw new DelegateError("The sub-agent prompt is empty.");
    }
    const cwd = this.resolveCwd(options.cwd);
    const now = new Date().toISOString();
    const id = `del_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
    const run = this.hydrate({
      id,
      task,
      cwd,
      status: "queued",
      queuedAt: now,
      startedAt: null,
      endedAt: null,
      timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
    });
    run.turnOpen = true;
    this.runs.set(id, run);
    this.queue.push(id);
    this.save();
    this.pump();
    return this.viewOf(run);
  }

  /**
   * Send another prompt to an idle sub-agent and return. Refuses a run that is already
   * working, and one whose session was closed.
   */
  async continue(id: string, prompt: string): Promise<DelegateRunView> {
    if (this.shuttingDown)
      throw new DelegateError("pi-ui is shutting down; no sub-agent can continue.");
    const run = this.run(id);
    if (run.closed === true) {
      throw new DelegateError(`Sub-agent ${run.id} was closed. Start a new one with acp_delegate.`);
    }
    if (run.status === "queued" || run.status === "running") {
      throw new DelegateError(
        `Sub-agent ${run.id} is still ${run.status}. Wait for its chip, then continue.`,
      );
    }
    const task = prompt.trim();
    if (task.length === 0) throw new DelegateError("The sub-agent prompt is empty.");
    run.task = task;
    run.status = "queued";
    run.startedAt = null;
    run.endedAt = null;
    run.error = undefined;
    run.result = undefined;
    run.lastOutcome = undefined;
    run.timedOut = undefined;
    run.cancelRequested = false;
    run.pendingNotice = false;
    run.turnOpen = true;
    run.gate = createGate();
    this.queue.push(run.id);
    this.save();
    this.pump();
    return this.viewOf(run);
  }

  /** Stop the current turn. The session stays, so a later continue still works. */
  cancel(id: string): DelegateRunView {
    const run = this.run(id);
    if (run.status === "queued") {
      const index = this.queue.indexOf(run.id);
      if (index >= 0) this.queue.splice(index, 1);
      run.cancelRequested = true;
      run.lastOutcome = "cancelled";
      run.error = "Cancelled before it started.";
      run.result = run.error;
      run.status = "idle";
      run.endedAt = new Date().toISOString();
      void this.finishTurn(run);
      return this.viewOf(run);
    }
    if (run.status === "running") {
      run.cancelRequested = true;
      run.error = "Cancelled by the parent.";
      this.sessions.get(run.id)?.abort();
    }
    return this.viewOf(run);
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const waiting: Promise<void>[] = [];
    for (const run of this.runs.values()) {
      // A turn that already flipped to idle can still be writing its chip files.
      // Its gate settles at the end of that write, so wait for every gate.
      if (run.status === "queued" || run.status === "running") this.cancel(run.id);
      waiting.push(run.gate.done);
    }
    await Promise.race([
      Promise.all(waiting),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        timer.unref?.();
      }),
    ]);
    await Promise.all([...this.sessions.values()].map((session) => session.close()));
    this.sessions.clear();
    await Promise.all([...this.writes.values()]).catch(() => undefined);
    await this.indexWrite.catch(() => undefined);
  }

  async read(id: string, kind: "result" | "activity"): Promise<string | undefined> {
    const run = this.runs.get(id.trim());
    if (run === undefined) return undefined;
    try {
      return await readFile(this.pathOf(run, kind), "utf8");
    } catch {
      return undefined;
    }
  }

  private loadRun(raw: SerializedDelegateRun): { run: DelegateRun; changed: boolean } {
    const wasLive = raw.status === "running" || raw.status === "queued";
    let status: DelegateRunStatus = "idle";
    let lastOutcome = isOutcome(raw.lastOutcome) ? raw.lastOutcome : undefined;
    let pendingNotice = raw.pendingNotice === true;
    let error = raw.error;
    let changed = false;
    if (wasLive) {
      status = "idle";
      lastOutcome = "failed";
      pendingNotice = true;
      error = error ?? DELEGATE_RESTART_ERROR;
      changed = true;
    } else if (
      raw.status === "completed" ||
      raw.status === "failed" ||
      raw.status === "cancelled"
    ) {
      status = "idle";
      lastOutcome = raw.status;
      changed = true;
    } else if (raw.status !== "idle") {
      status = "idle";
      changed = true;
    }
    const hasDb = this.hasDatabase(raw.id);
    const closed = raw.closed === true || !hasDb;
    if (closed !== (raw.closed === true)) changed = true;
    const run = this.hydrate({
      ...raw,
      status,
      endedAt: wasLive && raw.endedAt === null ? new Date().toISOString() : raw.endedAt,
      ...(error === undefined ? {} : { error }),
      ...(lastOutcome === undefined ? {} : { lastOutcome }),
      ...(pendingNotice ? { pendingNotice } : {}),
      ...(closed ? { closed } : {}),
    });
    return { run, changed };
  }

  private hasDatabase(id: string): boolean {
    try {
      return statSync(join(this.dir, id, "pi.sqlite3")).isFile();
    } catch {
      return false;
    }
  }

  private run(id: string): DelegateRun {
    const run = this.runs.get(id.trim());
    if (run === undefined) {
      throw new DelegateError(`Unknown sub-agent ${id}. Start one with acp_delegate.`);
    }
    return run;
  }

  private resolveCwd(requested: string | undefined): string {
    const cwd = resolve(requested?.trim() || this.options.cwd);
    let info: ReturnType<typeof statSync>;
    try {
      info = statSync(cwd);
    } catch {
      throw new DelegateError(`The sub-agent working directory does not exist: ${cwd}`);
    }
    if (!info.isDirectory()) {
      throw new DelegateError(`The sub-agent working directory is not a directory: ${cwd}`);
    }
    return cwd;
  }

  private hydrate(raw: SerializedDelegateRun): DelegateRun {
    const gate = createGate();
    const terminal = raw.status !== "queued" && raw.status !== "running";
    if (terminal) gate.finish();
    return {
      ...raw,
      cancelRequested: false,
      turnOpen: false,
      gate,
    };
  }

  private pump(): void {
    if (this.shuttingDown) return;
    while (this.activeCount < MAX_CONCURRENT_DELEGATES && this.queue.length > 0) {
      const id = this.queue.shift();
      if (id === undefined) return;
      const run = this.runs.get(id);
      if (run === undefined || run.status !== "queued" || !run.turnOpen) continue;
      this.activeCount += 1;
      void this.execute(run).finally(() => {
        this.activeCount = Math.max(0, this.activeCount - 1);
        this.pump();
      });
    }
  }

  private async execute(run: DelegateRun): Promise<void> {
    try {
      if (!run.turnOpen || run.status !== "queued") return;
      run.status = "running";
      run.startedAt = new Date().toISOString();
      run.endedAt = null;
      this.save();
      await this.appendActivity(
        run,
        `[subagent] started at ${run.startedAt}\nPrompt: ${firstLine(run.task)}\n`,
      );
      let session = this.sessions.get(run.id);
      if (session === undefined) {
        session = await this.openFor(run);
        this.sessions.set(run.id, session);
      }
      // Cancel during open has no session to abort yet. Do not submit after that.
      if (run.cancelRequested || this.shuttingDown || !run.turnOpen) return;
      const active = session;
      const timer = setTimeout(() => {
        run.timedOut = `after ${run.timeoutMinutes}m`;
        active.abort();
      }, run.timeoutMinutes * 60_000);
      timer.unref?.();
      try {
        const result = await active.submit(run.task);
        this.applyResult(run, result);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      if (run.lastOutcome === undefined && !run.cancelRequested) {
        run.lastOutcome = "failed";
        run.error = errorMessage(error);
      }
    } finally {
      if (run.turnOpen) await this.finishTurn(run);
    }
  }

  private applyResult(run: DelegateRun, result: DelegateTurnResult): void {
    if (result.usage !== undefined) run.usage = result.usage;
    const text = result.text.trim();
    if (run.timedOut !== undefined && !run.cancelRequested) {
      run.lastOutcome = "failed";
      run.error = `Timed out ${run.timedOut}.`;
      run.result = text.length > 0 ? `${run.error}\n\nPartial output:\n${text}` : run.error;
      return;
    }
    if (run.cancelRequested || result.cancelled === true) {
      run.lastOutcome = "cancelled";
      run.error = run.error ?? result.error ?? "Cancelled by the parent.";
      run.result = text.length > 0 ? `${run.error}\n\nPartial output:\n${text}` : run.error;
      return;
    }
    if (result.error !== undefined) {
      run.lastOutcome = "failed";
      run.error = result.error;
      run.result = text.length > 0 ? `${result.error}\n\nPartial output:\n${text}` : result.error;
      return;
    }
    run.lastOutcome = "completed";
    run.error = undefined;
    run.result = result.text;
  }

  private async finishTurn(run: DelegateRun): Promise<void> {
    if (!run.turnOpen) {
      run.gate.finish();
      return;
    }
    run.turnOpen = false;
    run.status = "idle";
    run.endedAt ??= new Date().toISOString();
    if (run.lastOutcome === undefined) {
      run.lastOutcome = run.cancelRequested ? "cancelled" : "failed";
      run.error ??= run.cancelRequested
        ? "Cancelled by the parent."
        : "The sub-agent stopped unexpectedly.";
    }
    if (run.result === undefined) run.result = run.error ?? "(no output)";
    await this.appendActivity(
      run,
      `[subagent] ${run.lastOutcome}${run.error === undefined ? "" : `: ${run.error}`}\n`,
    );
    await this.writeResult(run);
    this.evictIdle();
    this.save();
    if (!this.shuttingDown) {
      try {
        await this.notifier?.(this.noticeText(run));
      } catch (error) {
        console.error(`[delegate] ${run.id} notice failed`, error);
      }
    }
    run.gate.finish();
  }

  private evictIdle(): void {
    const idle = [...this.runs.values()]
      .filter((run) => run.status === "idle" && run.closed !== true)
      .sort((left, right) => (left.endedAt ?? "").localeCompare(right.endedAt ?? ""));
    const extra = idle.length - MAX_IDLE_DELEGATES;
    for (let index = 0; index < extra; index++) {
      const run = idle[index];
      if (run === undefined) continue;
      run.closed = true;
      const session = this.sessions.get(run.id);
      this.sessions.delete(run.id);
      if (session !== undefined) void session.close();
    }
  }

  private openFor(run: DelegateRun): Promise<DelegateSession> {
    if (this.options.openSession !== undefined) {
      return this.options.openSession({ id: run.id, cwd: run.cwd });
    }
    return this.openDurable(run);
  }

  private async openDurable(run: DelegateRun): Promise<DelegateSession> {
    const dir = join(this.dir, run.id);
    await mkdir(dir, { recursive: true });
    const databasePath = join(dir, "pi.sqlite3");
    const currentPath = join(dir, "current.json");
    const storage = await openNodeSqliteStorage(databasePath);
    const registry = createRegistry<ToolRegistration>();
    const enabled = new Set<string>(DELEGATE_TOOLS);
    const coding = (createCodingTools().tools ?? []).filter((tool) => enabled.has(tool.name));
    registry.install(defineExtension({ name: "delegate-coding-tools", tools: coding }));
    const harness = await HarnessImpl.open(
      storage,
      {
        models: this.options.models as unknown as Parameters<typeof HarnessImpl.open>[1]["models"],
        registry,
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? run.cwd }),
        settings: {
          compaction: {
            enabled: true,
            reserveTokens: 16_384,
            keepRecentTokens: 20_000,
            backgroundTokens: 0,
          },
          retry: retrySettings(),
          steeringMode: "all",
        },
      },
      BACKGROUND_CONTEXT,
    );
    const instructions = await this.instructions(run.cwd);
    const tools = registry
      .snapshot()
      .tools()
      .map(({ tool }) => tool)
      .filter((tool) => enabled.has(tool.name));
    const model =
      this.options.model === undefined
        ? undefined
        : { provider: this.options.model.provider, modelId: this.options.model.id };
    const savedId = await readConversationId(currentPath);
    let conversation =
      savedId === undefined
        ? undefined
        : ((await harness.conversation(savedId, BACKGROUND_CONTEXT)) ?? undefined);
    if (conversation === undefined) {
      conversation = await harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: {
            cwd: run.cwd,
            instructions,
            ...(model === undefined ? {} : { model }),
            tools,
          },
        },
        BACKGROUND_CONTEXT,
      );
      await writeConversationId(currentPath, conversation.id);
    } else {
      await conversation.configure(
        {
          cwd: run.cwd,
          instructions,
          ...(model === undefined ? {} : { model }),
          tools,
        },
        BACKGROUND_CONTEXT,
      );
    }
    return new DurableDelegateSession(harness, conversation);
  }

  private async instructions(cwd: string): Promise<string> {
    let base = this.promptCache.get(cwd);
    if (base === undefined) {
      base = await buildPiSystemPrompt(cwd, this.options.models, DELEGATE_TOOLS);
      this.promptCache.set(cwd, base);
    }
    return `${base}\n\n${DELEGATE_PROMPT}`;
  }

  private viewOf(run: DelegateRun): DelegateRunView {
    return {
      id: run.id,
      agent: "subagent",
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
      ...(run.lastOutcome === undefined ? {} : { lastOutcome: run.lastOutcome }),
      resultPath: this.pathOf(run, "result"),
      activityPath: this.pathOf(run, "activity"),
      resultUrl: `/api/delegates/${encodeURIComponent(run.id)}/result`,
      activityUrl: `/api/delegates/${encodeURIComponent(run.id)}/activity`,
    };
  }

  private pathOf(run: Pick<DelegateRun, "id">, kind: "result" | "activity"): string {
    return join(this.dir, `${run.id}.${kind === "result" ? "out" : "activity"}`);
  }

  private noticeText(run: DelegateRun): string {
    const outcome = run.lastOutcome ?? "failed";
    const marker =
      outcome === "completed" ? "completed" : outcome === "cancelled" ? "cancelled" : "FAILED";
    const verb =
      outcome === "completed" ? "finished" : outcome === "cancelled" ? "cancelled" : "failed";
    const body = excerpt(run.result ?? "");
    const followUp =
      run.closed === true
        ? "This sub-agent did not keep a session. Start a new one with acp_delegate."
        : `Continue this sub-agent with acp_delegate_continue runId "${run.id}". Do not poll or wait.`;
    return [
      `[acp_delegate ${marker}] run \`${run.id}\` ${verb} after ${formatDuration(run.startedAt, run.endedAt)}.`,
      `Prompt: ${firstLine(run.task)}`,
      `Result: ${this.pathOf(run, "result")}`,
      `Activity: ${this.pathOf(run, "activity")}`,
      ...(run.usage === undefined
        ? []
        : [
            `Tokens: ${run.usage.input.toLocaleString()} in, ${run.usage.output.toLocaleString()} out.`,
          ]),
      ...(run.error === undefined ? [] : [`Error: ${firstLine(run.error, 500)}`]),
      ...(body.length === 0 ? [] : ["Excerpt:", body]),
      followUp,
    ].join("\n");
  }

  private queueFileWrite(path: string, body: string, append: boolean): Promise<void> {
    const previous = this.writes.get(path) ?? Promise.resolve();
    const next = previous
      .then(async () => {
        await mkdir(this.dir, { recursive: true });
        if (append) {
          await writeFile(path, body, { flag: "a" });
          return;
        }
        const temporary = `${path}.${process.pid}.${++writeSequence}.tmp`;
        try {
          await writeFile(temporary, body);
          await rename(temporary, path);
        } catch (error) {
          await unlink(temporary).catch(() => undefined);
          throw error;
        }
      })
      .catch((error: unknown) => {
        console.error(`[delegate] file write failed for ${path}`, error);
      });
    this.writes.set(path, next);
    void next.finally(() => {
      if (this.writes.get(path) === next) this.writes.delete(path);
    });
    return next;
  }

  private async appendActivity(run: DelegateRun, text: string): Promise<void> {
    await this.queueFileWrite(this.pathOf(run, "activity"), text, true);
  }

  private async writeResult(run: DelegateRun): Promise<void> {
    const body = `${run.result ?? run.error ?? "(no output)"}\n`;
    await this.queueFileWrite(this.pathOf(run, "result"), body, false);
  }

  private save(): void {
    try {
      this.changeListener?.();
    } catch (error) {
      console.error("[delegate] change listener failed", error);
    }
    const runs: SerializedDelegateRun[] = [...this.runs.values()].map((run) => ({
      id: run.id,
      task: run.task,
      cwd: run.cwd,
      status: run.status,
      queuedAt: run.queuedAt,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      timeoutMinutes: run.timeoutMinutes,
      ...(run.closed === true ? { closed: true } : {}),
      ...(run.pendingNotice === true ? { pendingNotice: true } : {}),
      ...(run.lastOutcome === undefined ? {} : { lastOutcome: run.lastOutcome }),
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
          console.error("[delegate] could not save the sub-agent list", error);
        }
      })
      .catch((error: unknown) => {
        console.error("[delegate] could not save the sub-agent list", error);
      });
  }
}

class DurableDelegateSession implements DelegateSession {
  constructor(
    private readonly harness: Harness,
    private readonly conversation: Conversation,
  ) {}

  async submit(prompt: string): Promise<DelegateTurnResult> {
    try {
      const outcome = await withConversationIdentity(String(this.conversation.id), async () => {
        const submission = await this.conversation.submit(
          { type: "input", content: prompt },
          BACKGROUND_CONTEXT,
        );
        return submission.wait(BACKGROUND_CONTEXT);
      });
      const usage = usageTotals(
        await this.harness.usage(BACKGROUND_CONTEXT).catch(() => undefined),
      );
      const entries = (await this.conversation.context(BACKGROUND_CONTEXT)).entries;
      const reason =
        "reason" in outcome && typeof outcome.reason === "string" ? outcome.reason : undefined;
      const detailValue = "detail" in outcome ? outcome.detail : undefined;
      if (outcome.status === "done") {
        const answer = entryText(entries.find((entry) => entry.id === outcome.answer));
        const text = answer.trim().length > 0 ? answer : latestAssistantText(entries);
        if (text.trim().length === 0) {
          return {
            text: "",
            ...(usage === undefined ? {} : { usage }),
            error: "The sub-agent finished without a final answer.",
          };
        }
        return { text, ...(usage === undefined ? {} : { usage }) };
      }
      const detail = typeof detailValue === "string" ? `: ${detailValue}` : "";
      return {
        text: latestAssistantText(entries),
        ...(usage === undefined ? {} : { usage }),
        error: `The turn ended without an answer (${reason ?? outcome.status}${detail}).`,
      };
    } catch (error) {
      return { text: "", error: errorMessage(error) };
    }
  }

  abort(): void {
    void this.conversation.abort(BACKGROUND_CONTEXT, { background: true }).catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
  }
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
    // A malformed pointer is replaced the next time the session is created.
  }
  return undefined;
}

async function writeConversationId(path: string, conversationId: ConversationId): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, `${JSON.stringify({ conversationId })}\n`, "utf8");
  await rename(temporary, path);
}
