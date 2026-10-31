import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { IDLE_NUDGE_FILE, idleNudgeText } from "../shared/idle-nudge.js";

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

export interface IdleNudgeState {
  /** A turn is running, or a submission has not reached durable yet. */
  active: boolean;
  /** Messages and steers waiting for the current turn. */
  queued: number;
  openTaskIds: readonly string[];
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
    if (state.openTaskIds.length === 0) return null;
    if (at - this.lastActivityAt < this.intervalMs) return null;
    const hash = taskSetHash(state.openTaskIds);
    if (hash === this.recordedHash) return null;
    this.recordedHash = hash;
    this.fired = true;
    if (this.storage !== undefined) {
      try {
        writeIdleNudgeRecord(this.storage, { hash, nudgedAt: new Date(at).toISOString() });
      } catch (error) {
        console.error("[pi] could not record the idle nudge", error);
      }
    }
    return idleNudgeText(state.openTaskIds);
  }
}
