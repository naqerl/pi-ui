import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  IDLE_IGNORED_NUDGES,
  IDLE_NUDGE_FILE,
  IDLE_NUDGE_TASK_LIMIT,
  IDLE_STATUS_INTERVAL_MS,
  type IdleTask,
  type IdleTaskStatus,
  idleDecisionNudgeText,
  openTaskIds,
  workingTaskIds,
} from "../shared/idle-nudge.js";

export * from "../shared/idle-nudge.js";

/** A stable hash over the sorted unblocked open-task ids. */
export function taskSetHash(taskIds: readonly string[]): string {
  const hash = createHash("sha256");
  for (const id of [...taskIds].sort()) hash.update(id).update("\0");
  return hash.digest("hex");
}

/** What the nudge remembers about one task: naming history and how long it was ignored. */
export interface IdleNudgeTaskRecord {
  /** How many times this task has been named by a nudge. */
  named: number;
  /** When it was last named, as an ISO timestamp. */
  lastNamedAt: string;
  /** Whether it was named as work to pick or as a working task needing a status. */
  state: "open" | "working";
  /** Consecutive nudges that left this ignored task out; zero while it is active. */
  silent: number;
  /** Aliases written for readers that describe the count or time differently. */
  count?: number;
  times?: number;
  lastAt?: string;
}

export interface IdleNudgeRecord {
  hash: string;
  nudgedAt: string;
  /** Per-task memory. Absent on records written before this protocol. */
  tasks?: Record<string, IdleNudgeTaskRecord>;
}

export interface IdleNudgeStorageOptions {
  dataDir?: string;
  file?: string;
}

type IdleNudgeStorage = string | IdleNudgeStorageOptions;

/** The `idle-nudge.json` path for a data directory. */
export function idleNudgeFile(dataDir: string): string {
  return join(dataDir, IDLE_NUDGE_FILE);
}

function storageFile(input?: IdleNudgeStorage): string | undefined {
  if (input === undefined) {
    const env = process.env.DATA_DIR?.trim();
    return env === undefined || env.length === 0 ? undefined : idleNudgeFile(resolve(env));
  }
  if (typeof input === "string") {
    const path = input.trim();
    if (path.length === 0) return undefined;
    return path.endsWith(".json") ? resolve(path) : idleNudgeFile(resolve(path));
  }
  if (input.file !== undefined) return resolve(input.file);
  if (input.dataDir !== undefined) return idleNudgeFile(resolve(input.dataDir));
  return undefined;
}

function iso(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return value;
  } else if (typeof value === "number" && Number.isFinite(value)) {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date.toISOString();
  }
  return undefined;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function readTaskRecord(value: unknown, fallbackAt: string): IdleNudgeTaskRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const named = Math.max(count(raw.named), count(raw.count), count(raw.times), count(raw.names));
  const lastNamedAt =
    iso(raw.lastNamedAt) ?? iso(raw.lastAt) ?? iso(raw.namedAt) ?? iso(raw.last) ?? fallbackAt;
  const state =
    raw.state === "working" || raw.status === "working" || raw.lastState === "working"
      ? "working"
      : "open";
  const silent = Math.max(
    count(raw.silent),
    count(raw.missed),
    count(raw.skips),
    count(raw.cooldown),
  );
  return { named, lastNamedAt, state, silent };
}

function readTaskRecords(
  raw: Record<string, unknown>,
  fallbackAt: string,
): Record<string, IdleNudgeTaskRecord> | undefined {
  const value = raw.tasks ?? raw.taskRecords ?? raw.namedTasks;
  if (value === undefined) return undefined;
  const out: Record<string, IdleNudgeTaskRecord> = {};
  const add = (id: unknown, record: unknown) => {
    if (typeof id !== "string" || id.length === 0) return;
    const parsed = readTaskRecord(record, fallbackAt);
    if (parsed !== undefined) out[id] = parsed;
  };
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as Record<string, unknown>;
      add(record.id ?? record.taskId, record);
    }
  } else if (typeof value === "object" && value !== null) {
    for (const [id, record] of Object.entries(value)) add(id, record);
  }
  return out;
}

/** Read the last nudge record; a missing or malformed file simply yields undefined. */
export function readIdleNudgeRecord(fileOrDataDir: string): IdleNudgeRecord | undefined {
  const file = storageFile(fileOrDataDir);
  if (file === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.hash !== "string" || record.hash.length === 0) return undefined;
  const nudgedAt = iso(record.nudgedAt);
  // A valid hash with an unusable timestamp is still a corrupt record.
  if (nudgedAt === undefined) return undefined;
  const tasks = readTaskRecords(record, nudgedAt);
  return {
    hash: record.hash,
    nudgedAt,
    ...(tasks === undefined ? {} : { tasks }),
  };
}

/** Write the nudge record through a temporary file, then rename it into place. */
export function writeIdleNudgeRecord(
  fileOrDataDir: string,
  record: IdleNudgeRecord,
): string | undefined {
  const file = storageFile(fileOrDataDir);
  if (file === undefined) return undefined;
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify(record)}\n`, "utf8");
  renameSync(temporary, file);
  return file;
}

/** Remove the nudge record after its submission failed, so the same set can retry. */
export function clearIdleNudgeRecord(fileOrDataDir: string): void {
  const file = storageFile(fileOrDataDir);
  if (file === undefined) return;
  try {
    unlinkSync(file);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export interface IdleNudgeState {
  /** A turn is running, or a submission has not reached durable yet. */
  active: boolean;
  /** Messages and steers waiting for the current turn. */
  queued: number;
  /** Open tasks ready to pick. */
  openTaskIds?: readonly string[];
  /** Tasks the agent has already started and not finished. */
  workingTaskIds?: readonly string[];
  /** A richer task list; its statuses may include the derived working state. */
  tasks?: readonly IdleTask[];
  /** Explicit task states, for callers that keep them separately from the ids. */
  taskStatuses?: Readonly<Record<string, IdleTaskStatus>>;
  statuses?: Readonly<Record<string, IdleTaskStatus>>;
}

export type IdleNudgeStart = number | IdleNudgeStorage;

/** The open and working ids after all the accepted state shapes are folded together. */
function selectableTasks(state: IdleNudgeState): { open: string[]; working: string[] } {
  const open: string[] = [];
  const working: string[] = [];
  if (state.tasks !== undefined) {
    open.push(...openTaskIds(state.tasks));
    working.push(...workingTaskIds(state.tasks));
  }
  open.push(...(state.openTaskIds ?? []));
  working.push(...(state.workingTaskIds ?? []));
  for (const statuses of [state.taskStatuses, state.statuses]) {
    for (const [id, status] of Object.entries(statuses ?? {})) {
      if (status === "working") working.push(id);
      else if (status === "open") open.push(id);
    }
  }
  const workingSet = new Set(working);
  return {
    open: [...new Set(open)].filter((id) => !workingSet.has(id)),
    working: [...workingSet],
  };
}

function taskRecord(
  previous: IdleNudgeTaskRecord | undefined,
  state: "open" | "working",
  at: string,
): IdleNudgeTaskRecord {
  const named = (previous?.named ?? 0) + 1;
  return {
    named,
    count: named,
    times: named,
    lastNamedAt: at,
    lastAt: at,
    state,
    silent: 0,
  };
}

/**
 * Tracks one idle period. `noteActivity` re-arms it after any user message,
 * steer, run start or run end; `maybeNudge` remembers each task it named.
 */
export class IdleNudge {
  private readonly storage: string | undefined;
  private lastActivityAt: number;
  private fired = false;
  private record: IdleNudgeRecord | undefined;
  /** The last idle window that advanced the per-task counters, prompt or not. */
  private lastOpportunityAt: number | undefined;
  /** True for an old hash-only record, which cannot be expanded until its next write. */
  private legacy = false;

  constructor(
    readonly intervalMs: number,
    startAtOrStorage: IdleNudgeStart = Date.now(),
    storage?: IdleNudgeStorage | number,
  ) {
    let storageInput: IdleNudgeStorage | undefined;
    if (typeof startAtOrStorage === "number") {
      this.lastActivityAt = startAtOrStorage;
      if (typeof storage !== "number") storageInput = storage;
    } else {
      storageInput = startAtOrStorage;
      this.lastActivityAt = typeof storage === "number" ? storage : Date.now();
    }
    this.storage = storageFile(storageInput);
    this.load();
  }

  get enabled(): boolean {
    return this.intervalMs > 0;
  }

  get armed(): boolean {
    return this.enabled && !this.fired;
  }

  /** The task set that last produced a nudge, loaded from disk at startup. */
  get nudgedHash(): string | undefined {
    return this.record?.hash;
  }

  /** The per-task naming memory, loaded from disk at startup. */
  get nudgedTasks(): Readonly<Record<string, IdleNudgeTaskRecord>> {
    return this.record?.tasks ?? {};
  }

  /** Reload the persisted task set, tolerant of a missing or corrupt record. */
  load(): void {
    if (this.storage === undefined) return;
    this.record = readIdleNudgeRecord(this.storage);
    this.legacy = this.record !== undefined && this.record.tasks === undefined;
  }

  /**
   * Forget the last nudge after its submission failed. Clearing both copies lets
   * the same task set try again instead of staying silenced until the set changes.
   */
  forgetNudge(): void {
    this.record = undefined;
    this.legacy = false;
    if (this.storage === undefined) return;
    try {
      clearIdleNudgeRecord(this.storage);
    } catch (error) {
      console.error("[pi] could not clear the idle nudge record", error);
    }
  }

  /** Any user message, steer, run start or run end starts a fresh idle period. */
  noteActivity(at: number = Date.now()): void {
    this.lastActivityAt = at;
    this.fired = false;
    // A fresh activity window is a new opportunity; only the quiet timer is spaced out.
    this.lastOpportunityAt = undefined;
  }

  /** The prompt to submit now, or null while disabled, busy, waiting, blocked or already nudged. */
  maybeNudge(state: IdleNudgeState, at: number = Date.now()): string | null {
    if (!this.armed) return null;
    if (state.active || state.queued > 0) return null;
    const { open, working } = selectableTasks(state);
    if (open.length === 0 && working.length === 0) return null;
    if (at - this.lastActivityAt < this.intervalMs) return null;

    const hash = taskSetHash([...new Set([...open, ...working])]);
    // The 10s timer may poll many times inside one idle window. Only one check per
    // window may advance the cooldown, or three silent opportunities become 30s. A
    // genuinely new task set is new information and is not held back.
    if (
      hash === this.record?.hash &&
      this.lastOpportunityAt !== undefined &&
      at - this.lastOpportunityAt < this.intervalMs
    ) {
      return null;
    }
    // A legacy record only knows a hash. Keep its old silence until the set changes,
    // then the write below upgrades it to the per-task form.
    if (this.legacy && hash === this.record?.hash) return null;

    const atIso = new Date(at).toISOString();
    const tasks: Record<string, IdleNudgeTaskRecord> = {};
    for (const [id, record] of Object.entries(this.record?.tasks ?? {})) {
      tasks[id] = { ...record };
    }
    const current = new Set([...open, ...working]);
    for (const id of Object.keys(tasks)) {
      if (!current.has(id)) delete tasks[id];
    }
    const workingSet = new Set(working);
    const pickedOpen: string[] = [];
    const pickedWorking: string[] = [];

    for (const id of [...open, ...working]) {
      const currentState = workingSet.has(id) ? "working" : "open";
      const previous = tasks[id];
      if (previous === undefined) {
        (currentState === "working" ? pickedWorking : pickedOpen).push(id);
        continue;
      }
      if (currentState === "working") {
        // A task that just started working is answered, so ask at once. A task that
        // was already working is asked again only after the hourly interval.
        if (previous.state === "working") {
          const last = Date.parse(previous.lastNamedAt);
          if (Number.isFinite(last) && at - last < IDLE_STATUS_INTERVAL_MS) continue;
        } else {
          previous.silent = 0;
        }
        pickedWorking.push(id);
        continue;
      }
      if (previous.state === "working") {
        // It left the working state without being closed, so it is work to pick again.
        previous.silent = 0;
        pickedOpen.push(id);
        continue;
      }
      if (previous.silent >= IDLE_IGNORED_NUDGES) {
        previous.silent = 0;
        pickedOpen.push(id);
      } else if (previous.silent > 0) {
        previous.silent += 1;
      } else {
        // It was named as work and is still untouched: this is the first silent nudge.
        previous.silent = 1;
      }
    }

    // The text names at most twenty ids, so only those tasks may be remembered as
    // named. Recording the rest would silence tasks the agent never saw.
    const visibleOpen = pickedOpen.slice(0, IDLE_NUDGE_TASK_LIMIT);
    const visibleWorking = pickedWorking.slice(
      0,
      Math.max(0, IDLE_NUDGE_TASK_LIMIT - visibleOpen.length),
    );

    if (visibleOpen.length === 0 && visibleWorking.length === 0) {
      // Nothing to submit, but the silent counters still move. Persist them so the
      // next idle window resumes from here instead of starting over at zero.
      this.lastOpportunityAt = at;
      this.record = {
        hash,
        nudgedAt: this.record?.nudgedAt ?? atIso,
        tasks,
      };
      if (this.storage !== undefined) {
        try {
          writeIdleNudgeRecord(this.storage, this.record);
        } catch (error) {
          console.error("[pi] could not record the idle nudge", error);
        }
      }
      return null;
    }

    for (const id of visibleOpen) tasks[id] = taskRecord(tasks[id], "open", atIso);
    for (const id of visibleWorking) tasks[id] = taskRecord(tasks[id], "working", atIso);
    const text = idleDecisionNudgeText(visibleOpen, visibleWorking, open.length);
    this.record = { hash, nudgedAt: atIso, tasks };
    this.legacy = false;
    this.fired = true;
    this.lastOpportunityAt = at;
    if (this.storage !== undefined) {
      try {
        writeIdleNudgeRecord(this.storage, this.record);
      } catch (error) {
        console.error("[pi] could not record the idle nudge", error);
      }
    }
    return text;
  }
}
