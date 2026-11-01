import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  IDLE_NUDGE_FILE,
  type IdleTask,
  idleNudgeText,
  openTaskIds,
  STALE_RUN_NUDGE_FILE,
  staleRunNudgeMs,
  staleRunNudgeText,
  staleRunTaskIds,
  staleWorkedTasks,
} from "../shared/idle-nudge.js";
import type { TaskActivity } from "../shared/types.js";

export * from "../shared/idle-nudge.js";

/** A stable hash over the sorted unblocked open-task ids. */
export function taskSetHash(taskIds: readonly string[]): string {
  const hash = createHash("sha256");
  for (const id of [...taskIds].sort()) hash.update(id).update("\0");
  return hash.digest("hex");
}

export interface IdleNudgeRecord {
  hash: string;
  nudgedAt: string;
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

/** The `stale-nudge.json` path for a data directory. */
export function staleRunNudgeFile(dataDir: string): string {
  return join(dataDir, STALE_RUN_NUDGE_FILE);
}

function storageFile(input?: IdleNudgeStorage, fileName = IDLE_NUDGE_FILE): string | undefined {
  if (input === undefined) {
    const env = process.env.DATA_DIR?.trim();
    return env === undefined || env.length === 0 ? undefined : join(resolve(env), fileName);
  }
  if (typeof input === "string") {
    const path = input.trim();
    if (path.length === 0) return undefined;
    return path.endsWith(".json") ? resolve(path) : join(resolve(path), fileName);
  }
  if (input.file !== undefined) return resolve(input.file);
  if (input.dataDir !== undefined) return join(resolve(input.dataDir), fileName);
  return undefined;
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
  let nudgedAt: string | undefined;
  if (typeof record.nudgedAt === "string" && record.nudgedAt.length > 0) {
    const date = new Date(record.nudgedAt);
    if (Number.isFinite(date.getTime())) nudgedAt = record.nudgedAt;
  } else if (typeof record.nudgedAt === "number" && Number.isFinite(record.nudgedAt)) {
    const date = new Date(record.nudgedAt);
    if (Number.isFinite(date.getTime())) nudgedAt = date.toISOString();
  }
  // A valid hash with an unusable timestamp is still a corrupt record.
  return nudgedAt === undefined ? undefined : { hash: record.hash, nudgedAt };
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

/** The last stale-run nudge for each task, as task id to ISO timestamp. */
export type StaleRunNudgeRecord = Record<string, string>;

/** Read the per-task stale-run records; a missing or malformed file yields an empty map. */
export function readStaleRunNudgeRecord(fileOrDataDir: string): StaleRunNudgeRecord {
  const file = storageFile(fileOrDataDir, STALE_RUN_NUDGE_FILE);
  if (file === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) return {};
  const tasks = (parsed as Record<string, unknown>).tasks;
  if (typeof tasks !== "object" || tasks === null) return {};
  const out: StaleRunNudgeRecord = {};
  for (const [id, value] of Object.entries(tasks)) {
    if (id.length === 0 || typeof value !== "string") continue;
    if (!Number.isFinite(Date.parse(value))) continue;
    out[id] = value;
  }
  return out;
}

/** Write the per-task stale-run records through a temporary file, then rename. */
export function writeStaleRunNudgeRecord(
  fileOrDataDir: string,
  record: StaleRunNudgeRecord,
): string | undefined {
  const file = storageFile(fileOrDataDir, STALE_RUN_NUDGE_FILE);
  if (file === undefined) return undefined;
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, `${JSON.stringify({ version: 1, tasks: record })}\n`, "utf8");
  renameSync(temporary, file);
  return file;
}

export interface StaleRunNudgePlan {
  text: string;
  taskIds: string[];
}

/**
 * The one-hour status check for a live run that stopped calling tools on a task.
 * Each task gets at most one nudge per window, even across a restart.
 */
export class StaleRunNudge {
  private readonly storage: string | undefined;
  private readonly nudgedAt = new Map<string, number>();

  constructor(
    readonly intervalMs: number = staleRunNudgeMs(),
    storage?: IdleNudgeStorage,
    private readonly clock: () => number = Date.now,
  ) {
    this.storage = storageFile(storage, STALE_RUN_NUDGE_FILE);
    this.load();
  }

  get enabled(): boolean {
    return this.intervalMs > 0;
  }

  load(): void {
    if (this.storage === undefined) return;
    for (const [id, at] of Object.entries(readStaleRunNudgeRecord(this.storage))) {
      const parsed = Date.parse(at);
      if (Number.isFinite(parsed)) this.nudgedAt.set(id, parsed);
    }
  }

  /** Tasks due for a status check right now, after the per-task cooldown. */
  due(
    tasks: readonly IdleTask[],
    activity: TaskActivity | undefined,
    at: number = this.clock(),
  ): string[] {
    if (!this.enabled) return [];
    return staleRunTaskIds(tasks, activity, at, this.intervalMs).filter((id) => {
      const last = this.nudgedAt.get(id);
      return last === undefined || at - last >= this.intervalMs;
    });
  }

  /** Remember that these tasks were nudged, so they stay quiet for one window. */
  record(taskIds: readonly string[], at: number = this.clock()): void {
    if (taskIds.length === 0) return;
    for (const id of taskIds) this.nudgedAt.set(id, at);
    this.save();
  }

  /** Forget a failed submission, so the same tasks can try again. */
  forget(taskIds: readonly string[]): void {
    if (taskIds.length === 0) return;
    for (const id of taskIds) this.nudgedAt.delete(id);
    this.save();
  }

  /** A ready-to-submit status check, or null when nothing is due. */
  maybeNudge(
    tasks: readonly IdleTask[],
    activity: TaskActivity | undefined,
    at: number = this.clock(),
  ): StaleRunNudgePlan | null {
    const taskIds = this.due(tasks, activity, at);
    if (taskIds.length === 0) return null;
    this.record(taskIds, at);
    return { text: staleRunNudgeText(taskIds), taskIds };
  }

  private save(): void {
    if (this.storage === undefined) return;
    const record: StaleRunNudgeRecord = {};
    for (const [id, at] of this.nudgedAt) record[id] = new Date(at).toISOString();
    try {
      writeStaleRunNudgeRecord(this.storage, record);
    } catch (error) {
      console.error("[pi] could not record the stale-run nudge", error);
    }
  }
}

export interface IdleNudgeState {
  /** A turn is running, or a submission has not reached durable yet. */
  active: boolean;
  /** Messages and steers waiting for the current turn. */
  queued: number;
  /** The ready task ids. Derived from `tasks` when omitted. */
  openTaskIds?: readonly string[];
  /** Open work with titles and `lastWorkedAt`, so stale tasks can be named. */
  tasks?: readonly IdleTask[];
  /** The stale subset, when the caller already selected it. Derived from `tasks` otherwise. */
  staleTasks?: readonly IdleTask[];
}

export type IdleNudgeStart = number | IdleNudgeStorage;

/**
 * Tracks one idle period. `noteActivity` re-arms it after any user message,
 * steer, run start or run end; `maybeNudge` fires at most once per task set.
 */
export class IdleNudge {
  private readonly storage: string | undefined;
  private lastActivityAt: number;
  private fired = false;
  private recordedHash: string | undefined;

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
    return this.recordedHash;
  }

  /** Reload the persisted task set, tolerant of a missing or corrupt record. */
  load(): void {
    if (this.storage === undefined) return;
    this.recordedHash = readIdleNudgeRecord(this.storage)?.hash;
  }

  /**
   * Forget the last nudge after its submission failed. Clearing both copies lets
   * the same task set try again instead of staying silenced until the set changes.
   */
  forgetNudge(): void {
    this.recordedHash = undefined;
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
  }

  /** The prompt to submit now, or null while disabled, busy, waiting, blocked or already nudged. */
  maybeNudge(state: IdleNudgeState, at: number = Date.now()): string | null {
    if (!this.armed) return null;
    if (state.active || state.queued > 0) return null;
    const tasks = state.tasks ?? [];
    const openIds = state.openTaskIds ?? openTaskIds(tasks);
    if (openIds.length === 0) return null;
    if (at - this.lastActivityAt < this.intervalMs) return null;
    const hash = taskSetHash(openIds);
    if (hash === this.recordedHash) return null;
    const stale = state.staleTasks ?? staleWorkedTasks(tasks, at);
    this.recordedHash = hash;
    this.fired = true;
    if (this.storage !== undefined) {
      try {
        writeIdleNudgeRecord(this.storage, { hash, nudgedAt: new Date(at).toISOString() });
      } catch (error) {
        console.error("[pi] could not record the idle nudge", error);
      }
    }
    return idleNudgeText(openIds, undefined, stale);
  }
}
