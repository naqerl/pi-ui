/**
 * Delivery policy for MCP event notices.
 *
 * Subscription events are news for the activity page and every widget, but not
 * every event deserves its own chat notice and turn. This module decides which
 * events start a notice, which ones fold into the notice already open for the
 * same subject, and which ones say nothing new at all.
 */

export type NoticeMode = "immediate" | "coalesce" | "drop";
export type NoticeAction = "deliver" | "update" | "drop";

export interface ClassifiedNotice {
  /** `${server}/${event name}/${subjectId}`, or the event id when there is no subject. */
  readonly key: string;
  readonly mode: NoticeMode;
  readonly reason: string;
  readonly server: string;
  readonly kind: string;
  readonly eventName: string;
  readonly eventId: string;
  readonly subjectId: string | null;
  readonly subjectField: string | null;
  /** Epoch milliseconds, from the event timestamp when it has one. */
  readonly at: number;
}

export interface NoticeDecision extends ClassifiedNotice {
  readonly action: NoticeAction;
  /** True for the first notice of a key/window (or any immediate notice). */
  readonly first: boolean;
  /** A dropped event that still belongs in the open notice's text. */
  readonly fold: boolean;
  /** Stable per-window transcript id, so two windows of one key stay separate. */
  readonly noticeId: string | null;
}

export interface NoticeCoalescerOptions {
  /** How long one key's notice stays open. Zero disables coalescing entirely. */
  readonly windowMs?: number;
  /** Current time, injectable for tests. */
  readonly now?: () => number;
  /** Two starts closer than this are the same transition, not two of them. */
  readonly sameFrameMs?: number;
  /** The boundary and job/run pairs are immediate repeats only within this gap. */
  readonly sameMomentMs?: number;
}

export const DEFAULT_MCP_EVENT_WINDOW_MS = 600_000;
/** The environment variable that overrides the window, in milliseconds. */
export const MCP_EVENT_WINDOW_MS = DEFAULT_MCP_EVENT_WINDOW_MS;
const DEFAULT_SAME_FRAME_MS = 1_000;
const DEFAULT_SAME_MOMENT_MS = 10_000;

/** `MCP_EVENT_WINDOW_MS`, where zero disables coalescing and junk keeps the default. */
export function mcpEventWindowMs(): number {
  const raw = process.env.MCP_EVENT_WINDOW_MS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_MCP_EVENT_WINDOW_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MCP_EVENT_WINDOW_MS;
}

const TERMINAL_WORDS = new Set([
  "cancelled",
  "canceled",
  "complete",
  "completed",
  "done",
  "ended",
  "error",
  "errored",
  "exited",
  "failed",
  "failure",
  "finished",
  "killed",
  "lost",
  "stopped",
  "succeeded",
  "success",
  "terminal",
  "timed_out",
  "timeout",
]);

const START_WORDS = new Set([
  "accepted",
  "accepting",
  "active",
  "created",
  "opening",
  "pending",
  "queued",
  "running",
  "started",
  "starting",
]);

const WARNING_RE = /has been running for\s+\d+\s*m(?:in(?:ute)?s?)?\b/i;

interface Facts {
  readonly server: string;
  readonly kind: string;
  readonly eventName: string;
  readonly hasEventName: boolean;
  readonly eventId: string;
  readonly subjectId: string | null;
  readonly subjectField: string | null;
  readonly runId: string | null;
  readonly at: number;
  readonly replayed: boolean;
  readonly terminal: boolean;
  readonly node: string | null;
  readonly phase: string | null;
  readonly action: string | null;
  readonly runCursor: string | null;
  readonly warning: string | null;
}

interface OpenNotice {
  readonly id: string;
  readonly key: string;
  readonly openedAt: number;
  updatedAt: number;
  facts: Facts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const text = stringValue(value);
    if (text !== null) return text;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function normalizedWord(value: string | null): string | null {
  if (value === null) return null;
  return value.trim().toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");
}

function isStart(action: string | null): boolean {
  if (action === null) return false;
  return [...START_WORDS].some((word) => action === word || action.startsWith(`${word}_`));
}

function isWarning(facts: Facts): boolean {
  if (facts.warning !== null && WARNING_RE.test(facts.warning)) return true;
  return (
    facts.kind.toLowerCase().includes("warning") || facts.kind.toLowerCase().includes("heartbeat")
  );
}

function warningStatement(facts: Facts): string | null {
  if (facts.warning === null) return null;
  return facts.warning
    .replace(/\d+(?:\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

function progressSignature(facts: Facts): string {
  return JSON.stringify([facts.kind, facts.node, facts.phase, facts.action, facts.warning]);
}

function factsFrom(input: unknown): Facts {
  const outer = asRecord(input) ?? {};
  const nested = asRecord(outer.event);
  const event = nested ?? outer;
  const data = event.data !== undefined ? event.data : outer.data;
  const payload =
    asRecord(data) ??
    asRecord(outer.payload) ??
    (nested === undefined ? asRecord(event) : undefined) ??
    {};

  const server = firstString(outer.server, event.server) ?? "unknown";
  const explicitName = firstString(event.name, outer.name, outer.eventName);
  const eventName = explicitName ?? "event";
  const kind = firstString(payload.kind, event.kind, outer.kind) ?? eventName;
  const eventId =
    firstString(event.eventId, event.eventID, event.id, outer.eventId) ??
    `${server}:${kind}:${firstString(event.timestamp, outer.timestamp) ?? "unknown"}`;

  const subjectFields = ["jobId", "runId", "leaseId", "subscriptionId", "id"] as const;
  const runId = stringValue(payload.runId) ?? stringValue(payload.run_id);
  let subjectId: string | null = null;
  let subjectField: string | null = null;
  for (const field of subjectFields) {
    const value = stringValue(payload[field]);
    if (value !== null) {
      subjectId = value;
      subjectField = field;
      break;
    }
  }

  const timestamp = firstString(event.timestamp, outer.timestamp, payload.timestamp);
  const parsedTimestamp = timestamp === null ? Number.NaN : Date.parse(timestamp);
  const numericTimestamp =
    typeof event.timestamp === "number"
      ? event.timestamp
      : typeof outer.timestamp === "number"
        ? outer.timestamp
        : Number.NaN;
  const at = Number.isFinite(parsedTimestamp)
    ? parsedTimestamp
    : Number.isFinite(numericTimestamp)
      ? numericTimestamp
      : Date.now();

  const summary = asRecord(payload.summary);
  const node = firstString(summary?.node, payload.node);
  const phase = firstString(payload.phase, payload.stage, summary?.phase);
  const action =
    firstString(payload.action, payload.state, payload.status, payload.phase, summary?.action) ??
    null;
  const runCursor = firstString(payload.runCursor, payload.cursor, event.cursor);
  const warning = firstString(
    payload.warning,
    payload.message,
    payload.text,
    summary?.message,
    summary?.text,
    typeof payload.summary === "string" ? payload.summary : null,
  );

  const replayFlag =
    outer.replayed === true ||
    event.replayed === true ||
    payload.replayed === true ||
    outer.replay_truncated === true ||
    outer.replayTruncated === true;
  const terminalFlag =
    payload.terminal === true ||
    payload.isTerminal === true ||
    payload.terminalState === true ||
    (typeof payload.terminal === "string" &&
      payload.terminal.length > 0 &&
      payload.terminal !== "false") ||
    payload.failed === true ||
    payload.failure === true ||
    payload.error === true ||
    (typeof payload.error === "string" && payload.error.trim().length > 0);
  const terminalWord = [
    payload.action,
    payload.status,
    payload.state,
    payload.phase,
    payload.result,
    payload.outcome,
  ]
    .map((value) => normalizedWord(stringValue(value)))
    .find((value) => value !== null && TERMINAL_WORDS.has(value));

  return {
    server,
    kind,
    eventName,
    hasEventName: explicitName !== null,
    eventId,
    subjectId,
    subjectField,
    runId,
    at,
    replayed: replayFlag,
    terminal: terminalFlag || terminalWord !== undefined,
    node,
    phase,
    action,
    runCursor,
    warning,
  };
}

function keyFor(facts: Facts): string {
  const name = facts.hasEventName ? facts.eventName : facts.kind;
  return `${facts.server}/${name}/${facts.subjectId ?? facts.eventId}`;
}

function runKeyFor(facts: Facts): string | null {
  return facts.runId === null ? null : `${facts.server}/${facts.runId}`;
}

function classification(facts: Facts, mode: NoticeMode, reason: string): ClassifiedNotice {
  return {
    key: keyFor(facts),
    mode,
    reason,
    server: facts.server,
    kind: facts.kind,
    eventName: facts.eventName,
    eventId: facts.eventId,
    subjectId: facts.subjectId,
    subjectField: facts.subjectField,
    at: facts.at,
  };
}

function sameSubject(first: Facts, second: Facts): boolean {
  return (
    first.server === second.server &&
    first.subjectId !== null &&
    second.subjectId !== null &&
    first.subjectId === second.subjectId
  );
}

function jobRunPair(first: Facts, second: Facts): boolean {
  const firstKind = first.kind.toLowerCase();
  const secondKind = second.kind.toLowerCase();
  return (
    (firstKind.endsWith(".job") || firstKind.endsWith("_job") || firstKind === "job") &&
    (secondKind.endsWith(".run") || secondKind.endsWith("_run") || secondKind === "run")
  );
}

function samePhase(first: Facts, second: Facts): boolean {
  return first.phase !== null && second.phase !== null && first.phase === second.phase;
}

function isRunning(facts: Facts): boolean {
  return normalizedWord(facts.action) === "running" || normalizedWord(facts.phase) === "running";
}

/**
 * The stateful drop rules. `previous` is the last event observed, while `open`
 * is the notice the event would otherwise update.
 */
function redundancyReason(
  current: Facts,
  previous: Facts | undefined,
  previousRun: Facts | undefined,
  open: OpenNotice | undefined,
  sameFrameMs: number,
  sameMomentMs: number,
  trackSequenceRules: boolean,
): { reason: string; fold: boolean } | null {
  if (previous !== undefined) {
    const elapsed = Math.abs(current.at - previous.at);
    // A boundary frame announces the transition with no node; the frame that
    // immediately names the node is the same moment.
    if (
      elapsed <= sameMomentMs &&
      sameSubject(previous, current) &&
      previous.kind === current.kind &&
      previous.node === null &&
      current.node !== null
    ) {
      return { reason: "boundary-node", fold: false };
    }

    // Two executions opening in the same frame are one transition. Keep the
    // first notice and fold the second event into it.
    if (
      elapsed <= sameFrameMs &&
      sameSubject(previous, current) &&
      previous.kind === current.kind &&
      previous.node !== null &&
      current.node !== null &&
      isStart(previous.action) &&
      isStart(current.action) &&
      (previous.node !== current.node || previous.phase !== current.phase)
    ) {
      return { reason: "duplicate-transition", fold: open !== undefined };
    }

    // A repeated (node, phase) whose only change is the run cursor is the same
    // statement again, such as v2:3 -> v2:6 -> v2:7 on an unchanged node.
    if (
      trackSequenceRules &&
      sameSubject(previous, current) &&
      previous.kind === current.kind &&
      previous.node !== null &&
      current.node !== null &&
      previous.node === current.node &&
      previous.phase !== null &&
      previous.phase === current.phase &&
      progressSignature(previous) === progressSignature(current) &&
      previous.runCursor !== current.runCursor
    ) {
      return { reason: "cursor-only", fold: false };
    }

    // Periodic "has been running for Nm" warnings repeat one statement.
    if (
      trackSequenceRules &&
      sameSubject(previous, current) &&
      isWarning(previous) &&
      isWarning(current) &&
      warningStatement(previous) !== null &&
      warningStatement(previous) === warningStatement(current)
    ) {
      return { reason: "repeated-warning", fold: false };
    }
  }

  if (previousRun !== undefined) {
    const elapsed = Math.abs(current.at - previousRun.at);
    // The job frame already said the run is running. The run frame with the
    // same run id and phase adds nothing.
    if (
      elapsed <= sameMomentMs &&
      previousRun.server === current.server &&
      jobRunPair(previousRun, current) &&
      isRunning(previousRun) &&
      isRunning(current) &&
      samePhase(previousRun, current)
    ) {
      return { reason: "job-run-running", fold: false };
    }
  }
  return null;
}

/** Decide what to do with one event, optionally in the context of the previous one. */
export function classifyNotice(input: unknown, previousInput?: unknown): ClassifiedNotice {
  const facts = factsFrom(input);
  if (facts.replayed) return classification(facts, "drop", "replayed");
  if (facts.terminal) return classification(facts, "immediate", "terminal-state");

  const previous = previousInput === undefined ? undefined : factsFrom(previousInput);
  if (previous !== undefined) {
    const redundant = redundancyReason(
      facts,
      previous,
      previous,
      undefined,
      DEFAULT_SAME_FRAME_MS,
      DEFAULT_SAME_MOMENT_MS,
      true,
    );
    if (redundant !== null) return classification(facts, "drop", redundant.reason);
  }

  if (facts.subjectId === null) return classification(facts, "immediate", "no-subject-id");
  return classification(facts, "coalesce", "coalescible");
}

/**
 * Small per-key window. The first event of a key opens a notice; later
 * coalescible events update it until the window closes. Immediate events never
 * wait, and the drop rules keep the notice text from repeating itself.
 */
export class NoticeCoalescer {
  private readonly windowMs: number;
  private readonly clock: () => number;
  private readonly sameFrameMs: number;
  private readonly sameMomentMs: number;
  private readonly open = new Map<string, OpenNotice>();
  private readonly previousByKey = new Map<string, Facts>();
  private readonly previousByRun = new Map<string, Facts>();
  private nextWindow = 0;

  constructor(options: NoticeCoalescerOptions | number = {}) {
    const settings = typeof options === "number" ? { windowMs: options } : options;
    this.windowMs = settings.windowMs ?? mcpEventWindowMs();
    this.clock = settings.now ?? (() => Date.now());
    this.sameFrameMs = settings.sameFrameMs ?? DEFAULT_SAME_FRAME_MS;
    this.sameMomentMs = settings.sameMomentMs ?? DEFAULT_SAME_MOMENT_MS;
  }

  get window(): number {
    return this.windowMs;
  }

  /** Classify and advance the window state. */
  observe(input: unknown): NoticeDecision {
    const now = this.clock();
    const facts = factsFrom(input);
    const key = keyFor(facts);
    const runKey = runKeyFor(facts);

    if (facts.replayed) {
      return {
        ...classification(facts, "drop", "replayed"),
        action: "drop",
        first: false,
        fold: false,
        noticeId: null,
      };
    }

    if (facts.terminal) {
      this.open.delete(key);
      this.remember(key, runKey, facts);
      return {
        ...classification(facts, "immediate", "terminal-state"),
        action: "deliver",
        first: true,
        fold: false,
        noticeId: null,
      };
    }

    const storedOpen = this.open.get(key);
    const open =
      storedOpen !== undefined && now - storedOpen.openedAt <= this.windowMs
        ? storedOpen
        : undefined;
    if (this.windowMs > 0) {
      const redundant = redundancyReason(
        facts,
        this.previousByKey.get(key),
        runKey === null ? undefined : this.previousByRun.get(runKey),
        open,
        this.sameFrameMs,
        this.sameMomentMs,
        open !== undefined,
      );
      if (redundant !== null) {
        const folded = redundant.fold && open !== undefined;
        if (folded && open !== undefined) {
          open.updatedAt = now;
          open.facts = facts;
        }
        this.remember(key, runKey, facts);
        return {
          ...classification(facts, "drop", redundant.reason),
          action: "drop",
          first: false,
          fold: folded,
          noticeId: open?.id ?? null,
        };
      }
    }

    if (this.windowMs <= 0) {
      this.remember(key, runKey, facts);
      return {
        ...classification(facts, "immediate", "coalescing-disabled"),
        action: "deliver",
        first: true,
        fold: false,
        noticeId: null,
      };
    }

    if (facts.subjectId === null) {
      this.remember(key, runKey, facts);
      return {
        ...classification(facts, "immediate", "no-subject-id"),
        action: "deliver",
        first: true,
        fold: false,
        noticeId: null,
      };
    }

    this.remember(key, runKey, facts);
    if (open !== undefined) {
      open.updatedAt = now;
      open.facts = facts;
      return {
        ...classification(facts, "coalesce", "within-window"),
        action: "update",
        first: false,
        fold: false,
        noticeId: open.id,
      };
    }

    this.nextWindow += 1;
    const noticeId = `${key}#${now.toString(36)}-${this.nextWindow.toString(36)}`;
    this.open.set(key, { id: noticeId, key, openedAt: now, updatedAt: now, facts });
    return {
      ...classification(facts, "coalesce", "first-in-window"),
      action: "deliver",
      first: true,
      fold: false,
      noticeId,
    };
  }

  private remember(key: string, runKey: string | null, facts: Facts): void {
    this.previousByKey.set(key, facts);
    if (runKey !== null) this.previousByRun.set(runKey, facts);
  }

  /** Aliases with verbs that read naturally at different call sites. */
  decide(input: unknown): NoticeDecision {
    return this.observe(input);
  }

  classify(input: unknown): NoticeDecision {
    return this.observe(input);
  }

  push(input: unknown): NoticeDecision {
    return this.observe(input);
  }

  /** The open notice for a key, when its window is still active. */
  openNotice(key: string): OpenNotice | undefined {
    const open = this.open.get(key);
    if (open === undefined || !this.active(open)) return undefined;
    return open;
  }

  /** Every open notice, oldest first. */
  notices(): readonly OpenNotice[] {
    return [...this.open.values()]
      .filter((open) => this.active(open))
      .sort((first, second) => first.openedAt - second.openedAt);
  }

  private active(open: OpenNotice): boolean {
    return this.windowMs > 0 && this.clock() - open.openedAt <= this.windowMs;
  }

  reset(): void {
    this.open.clear();
    this.previousByKey.clear();
    this.previousByRun.clear();
    this.nextWindow = 0;
  }
}
