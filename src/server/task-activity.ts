import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { liveBlockerIds } from "../shared/tasks.js";
import type {
  Task,
  TaskActivity,
  TaskHistoryEvent,
  TaskHistoryKind,
  TaskMeasured,
  TaskRunOutcome,
  TaskTrace,
} from "../shared/types.js";
import { taggedTaskId } from "./task-attribution.js";

const HISTORY_LIMIT = 50;
/** Traces are kept for this many tasks; the oldest activity goes first. */
const TRACE_LIMIT = 500;
const SAVE_DELAY_MS = 1_000;

/** A model reply as far as attribution needs it. */
export interface ModelCall {
  toolCalls: { arguments: unknown }[];
  tokens: number;
  cost: number;
}

/** Per-run bookkeeping for one task, so active time is first-to-last call within each run. */
interface RunSpan {
  firstAt: number;
  lastAt: number;
  /** Tagged calls still running; a long build is active time, not silence. */
  open: number;
}

interface Persisted {
  version: 1;
  traces: Record<string, TaskTrace>;
  /** What each task looked like last time, so ledger diffs survive a restart. */
  seen: Record<string, LedgerFacts>;
}

interface LedgerFacts {
  status: Task["status"];
  blocked: boolean;
}

function emptyMeasured(): TaskMeasured {
  return { runs: 0, calls: 0, activeMs: 0, tokens: 0, cost: 0 };
}

function emptyTrace(): TaskTrace {
  return { lastActivityAt: null, lastRun: null, measured: emptyMeasured(), history: [] };
}

function finite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function readTrace(value: unknown): TaskTrace | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Partial<TaskTrace>;
  const measured = (raw.measured ?? {}) as Partial<TaskMeasured>;
  const lastRun = raw.lastRun;
  return {
    lastActivityAt: typeof raw.lastActivityAt === "string" ? raw.lastActivityAt : null,
    lastRun:
      typeof lastRun === "object" && lastRun !== null && typeof lastRun.id === "string"
        ? { ...lastRun }
        : null,
    measured: {
      runs: finite(measured.runs),
      calls: finite(measured.calls),
      activeMs: finite(measured.activeMs),
      tokens: finite(measured.tokens),
      cost: finite(measured.cost),
    },
    history: Array.isArray(raw.history)
      ? raw.history.filter(
          (event): event is TaskHistoryEvent =>
            typeof event === "object" &&
            event !== null &&
            typeof event.at === "string" &&
            typeof event.kind === "string" &&
            typeof event.text === "string",
        )
      : [],
  };
}

/**
 * What the agent's runs did per task, measured from tool calls tagged with `piuiTaskId`.
 * It never trusts the agent to report progress: a task is working because a live run is
 * calling tools for it, failed because that run errored, and its time, tokens and cost are
 * the sums of those runs. Calls without a tag are not attributed.
 */
export class TaskActivityTracker {
  private traces = new Map<string, TaskTrace>();
  private seen = new Map<string, LedgerFacts>();
  private runId: string | null = null;
  /** Tasks the live run touched, with their first and last tagged call. */
  private spans = new Map<string, RunSpan>();
  /** A failure seen during the run, reported when it ends. */
  private failure: { outcome: "error" | "interrupted"; reason: string } | null = null;
  private listeners = new Set<() => void>();
  private saveTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly path: string | undefined,
    private readonly clock: () => number = Date.now,
  ) {}

  async load(): Promise<void> {
    if (this.path === undefined) return;
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return;
    }
    let parsed: Partial<Persisted>;
    try {
      parsed = JSON.parse(raw) as Partial<Persisted>;
    } catch (error) {
      console.error("[pi] task activity file is unreadable; starting fresh", error);
      return;
    }
    const at = this.iso();
    for (const [id, value] of Object.entries(parsed.traces ?? {})) {
      const trace = readTrace(value);
      if (trace === null) continue;
      // A run that was live when pi-ui stopped never got to finish.
      if (trace.lastRun?.outcome === "running") {
        trace.lastRun = {
          ...trace.lastRun,
          outcome: "interrupted",
          reason: "pi-ui restarted mid-run",
          at,
        };
        this.push(trace, at, "failed", "Interrupted: pi-ui restarted mid-run");
      }
      this.traces.set(id, trace);
    }
    for (const [id, facts] of Object.entries(parsed.seen ?? {})) {
      if (typeof facts === "object" && facts !== null) this.seen.set(id, { ...facts });
    }
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  view(): TaskActivity {
    const traces: Record<string, TaskTrace> = {};
    const now = this.clock();
    for (const [id, trace] of this.traces) {
      const span = this.spans.get(id);
      const live = span === undefined ? 0 : Math.max(0, this.spanEnd(span, now) - span.firstAt);
      traces[id] = {
        ...trace,
        // A call still in flight is activity right now, however long the tool takes.
        lastActivityAt:
          span !== undefined && span.open > 0 ? new Date(now).toISOString() : trace.lastActivityAt,
        lastRun: trace.lastRun === null ? null : { ...trace.lastRun },
        // The live run's time so far counts before it ends.
        measured: { ...trace.measured, activeMs: trace.measured.activeMs + live },
        history: [...trace.history],
      };
    }
    return {
      now: this.iso(),
      running: this.runId !== null,
      runId: this.runId,
      traces,
    };
  }

  /** A run began. Calls from here on belong to it. */
  runStarted(): void {
    if (this.runId !== null) return;
    this.runId = randomUUID();
    this.spans.clear();
    this.failure = null;
    this.changed();
  }

  /** Remember that the live run failed; the outcome lands on its tasks when it ends. */
  runFailed(outcome: "error" | "interrupted", reason: string): void {
    if (this.runId === null) return;
    // An error explains more than the abort that usually follows it.
    if (this.failure?.outcome === "error") return;
    this.failure = { outcome, reason: reason.trim().slice(0, 200) || outcome };
  }

  /** The run ended. `interrupted` comes from pi-ui itself, e.g. a restart. */
  runEnded(interrupted = false): void {
    if (this.runId === null) return;
    const outcome: TaskRunOutcome = interrupted ? "interrupted" : (this.failure?.outcome ?? "ok");
    const reason = interrupted ? "run interrupted" : this.failure?.reason;
    const at = this.iso();
    for (const [id, span] of this.spans) {
      const trace = this.traces.get(id);
      if (trace === undefined || trace.lastRun?.id !== this.runId) continue;
      trace.lastRun = { id: this.runId, outcome, at, ...(reason === undefined ? {} : { reason }) };
      const spent = Math.max(0, this.spanEnd(span, this.clock()) - span.firstAt);
      trace.measured.activeMs += spent;
      if (outcome === "ok") {
        this.push(trace, at, "run-end", `Run ended · ${duration(spent)}`);
      } else {
        this.push(
          trace,
          at,
          "failed",
          `${outcome === "error" ? "Run failed" : "Run interrupted"}${reason ? `: ${reason}` : ""}`,
        );
      }
    }
    this.runId = null;
    this.spans.clear();
    this.failure = null;
    this.changed();
  }

  private spanEnd(span: RunSpan, now: number): number {
    return span.open > 0 ? Math.max(span.lastAt, now) : span.lastAt;
  }

  /** A top-level tool call started. Its `piuiTaskId`, if any, says which task it serves. */
  toolStarted(_name: string, args: unknown): void {
    // Some tool calls arrive without a run_start we saw, e.g. right after a restart.
    if (this.runId === null) this.runStarted();
    const runId = this.runId as string;
    const now = this.clock();
    const taskId = taggedTaskId(args);
    if (taskId === undefined) return;
    const trace = this.trace(taskId);
    const span = this.spans.get(taskId);
    if (span === undefined || trace.lastRun?.id !== runId) {
      this.spans.set(taskId, { firstAt: now, lastAt: now, open: 1 });
      trace.measured.runs += 1;
      trace.lastRun = { id: runId, outcome: "running", at: new Date(now).toISOString() };
      this.push(trace, new Date(now).toISOString(), "run-start", "Run started");
    } else {
      span.lastAt = now;
      span.open += 1;
    }
    trace.measured.calls += 1;
    trace.lastActivityAt = new Date(now).toISOString();
    this.changed();
  }

  /** A tagged tool call finished; it keeps the task's activity fresh. */
  toolEnded(args: unknown): void {
    const taskId = taggedTaskId(args);
    if (taskId === undefined || this.runId === null) return;
    const span = this.spans.get(taskId);
    const trace = this.traces.get(taskId);
    if (span === undefined || trace === undefined) return;
    const now = this.clock();
    span.lastAt = now;
    span.open = Math.max(0, span.open - 1);
    trace.lastActivityAt = new Date(now).toISOString();
    this.changed();
  }

  /**
   * A model reply ended. Its tokens and cost go to the tasks its tool calls were tagged with,
   * split evenly; replies without tagged calls stay unattributed.
   */
  modelCall(call: ModelCall): void {
    const ids = call.toolCalls
      .map((toolCall) => taggedTaskId(toolCall.arguments))
      .filter((id): id is string => id !== undefined);
    if (ids.length === 0) return;
    const share = 1 / ids.length;
    for (const id of ids) {
      const trace = this.trace(id);
      trace.measured.tokens += Math.round(call.tokens * share);
      trace.measured.cost += call.cost * share;
    }
    this.changed();
  }

  /** Record status changes from the ledger as history. Call with every published ledger. */
  observeLedger(tasks: readonly Task[]): void {
    const at = this.iso();
    let touched = false;
    const ids = new Set<string>();
    for (const task of tasks) {
      ids.add(task.id);
      const facts: LedgerFacts = {
        status: task.status,
        blocked: task.status === "open" && liveBlockerIds(tasks, task).length > 0,
      };
      const before = this.seen.get(task.id);
      this.seen.set(task.id, facts);
      const event = ledgerEvent(before, facts);
      if (event === null) continue;
      const trace = this.trace(task.id);
      this.push(trace, before === undefined ? task.createdAt : at, event.kind, event.text);
      touched = true;
    }
    for (const id of [...this.seen.keys()]) {
      if (ids.has(id)) continue;
      this.seen.delete(id);
      if (this.traces.delete(id)) touched = true;
    }
    if (touched) this.changed();
  }

  /** Write pending changes now, e.g. on shutdown. */
  async flush(): Promise<void> {
    if (this.saveTimer !== undefined) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    await this.save();
  }

  private trace(id: string): TaskTrace {
    let trace = this.traces.get(id);
    if (trace === undefined) {
      trace = emptyTrace();
      this.traces.set(id, trace);
      if (this.traces.size > TRACE_LIMIT) this.evict();
    }
    return trace;
  }

  private evict(): void {
    let oldest: [string, number] | null = null;
    for (const [id, trace] of this.traces) {
      const at = Date.parse(trace.lastActivityAt ?? trace.history.at(-1)?.at ?? "") || 0;
      if (oldest === null || at < oldest[1]) oldest = [id, at];
    }
    if (oldest !== null) this.traces.delete(oldest[0]);
  }

  private push(trace: TaskTrace, at: string, kind: TaskHistoryKind, text: string): void {
    trace.history.push({ at, kind, text });
    if (trace.history.length > HISTORY_LIMIT) {
      trace.history.splice(0, trace.history.length - HISTORY_LIMIT);
    }
  }

  private iso(): string {
    return new Date(this.clock()).toISOString();
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
    if (this.path === undefined || this.saveTimer !== undefined) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.save().catch((error: unknown) => {
        console.error("[pi] could not save task activity", error);
      });
    }, SAVE_DELAY_MS);
    this.saveTimer.unref?.();
  }

  private async save(): Promise<void> {
    if (this.path === undefined) return;
    const data: Persisted = {
      version: 1,
      traces: Object.fromEntries(this.traces),
      seen: Object.fromEntries(this.seen),
    };
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(data)}\n`);
    await rename(temp, this.path);
  }
}

function ledgerEvent(
  before: LedgerFacts | undefined,
  after: LedgerFacts,
): { kind: TaskHistoryKind; text: string } | null {
  if (before === undefined) {
    return after.status === "proposed"
      ? { kind: "created", text: "Proposed by the agent" }
      : { kind: "created", text: "Created" };
  }
  if (before.status === "proposed" && after.status === "open") {
    return { kind: "approved", text: "Approved" };
  }
  if (before.status !== "done" && after.status === "done")
    return { kind: "done", text: "Marked done" };
  if (before.status === "done" && after.status !== "done")
    return { kind: "reopened", text: "Reopened" };
  if (!before.blocked && after.blocked) return { kind: "blocked", text: "Blocked" };
  if (before.blocked && !after.blocked && after.status === "open") {
    return { kind: "unblocked", text: "Unblocked" };
  }
  return null;
}

function duration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
