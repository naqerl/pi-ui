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
  idleActualizeNudgeText,
  idleDecisionNudgeText,
  idleMemoryNudgeText,
  openTaskIds,
  STALE_RUN_NUDGE_FILE,
  staleRunNudgeMs,
  staleRunNudgeText,
  staleRunTaskIds,
  staleWorkedTasks,
  withMemoryRequest,
  withStaleRequest,
  workingTaskIds,
} from "../shared/idle-nudge.js";
import type { TaskActivity } from "../shared/types.js";

export * from "../shared/idle-nudge.js";

export function taskSetHash(taskIds: readonly string[]): string {
  const hash = createHash("sha256");
  for (const id of [...taskIds].sort()) hash.update(id).update("\0");
  return hash.digest("hex");
}

export interface IdleNudgeTaskRecord {
  named: number;

  lastNamedAt: string;

  state: "open" | "working";

  silent: number;

  count?: number;
  times?: number;
  lastAt?: string;
}

export interface IdleNudgeRecord {
  hash: string;
  nudgedAt: string;

  tasks?: Record<string, IdleNudgeTaskRecord>;

  closed?: string[];
}

export interface IdleNudgeStorageOptions {
  dataDir?: string;
  file?: string;
}

type IdleNudgeStorage = string | IdleNudgeStorageOptions;

export function idleNudgeFile(dataDir: string): string {
  return join(dataDir, IDLE_NUDGE_FILE);
}

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

function instant(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stringIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter((id): id is string => typeof id === "string" && id.length > 0))];
}

function lastMemoryWriteAt(activity: TaskActivity | undefined): number | null {
  return instant(activity?.lastMemoryWriteAt ?? activity?.memoryWriteAt);
}

function closedAt(task: IdleTask): number | null {
  return instant(task.completedAt) ?? instant(task.closedAt) ?? instant(task.lastWorkedAt);
}

function unrecordedClosures(
  tasks: readonly IdleTask[],
  since: number,
  activity: TaskActivity | undefined,
  pending: ReadonlySet<string> = new Set(),
): IdleTask[] {
  const wroteAt = lastMemoryWriteAt(activity);
  return tasks
    .filter((task) => task.status === "done")
    .filter((task) => {
      const at = closedAt(task);
      if (at === null) return false;

      if (at <= since && !pending.has(task.id)) return false;
      return wroteAt === null || wroteAt < at;
    })
    .sort((a, b) => (closedAt(a) ?? 0) - (closedAt(b) ?? 0));
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

  if (nudgedAt === undefined) return undefined;
  const tasks = readTaskRecords(record, nudgedAt);
  const closed = stringIds(
    record.closed ?? record.closedIds ?? record.closures ?? record.askedClosures,
  );
  return {
    hash: record.hash,
    nudgedAt,
    ...(tasks === undefined ? {} : { tasks }),
    ...(closed === undefined ? {} : { closed }),
  };
}

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

export type StaleRunNudgeRecord = Record<string, string>;

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

  record(taskIds: readonly string[], at: number = this.clock()): void {
    if (taskIds.length === 0) return;
    for (const id of taskIds) this.nudgedAt.set(id, at);
    this.save();
  }

  forget(taskIds: readonly string[]): void {
    if (taskIds.length === 0) return;
    for (const id of taskIds) this.nudgedAt.delete(id);
    this.save();
  }

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
  active: boolean;

  queued: number;

  openTaskIds?: readonly string[];

  workingTaskIds?: readonly string[];

  tasks?: readonly IdleTask[];

  staleTasks?: readonly IdleTask[];

  taskStatuses?: Readonly<Record<string, IdleTaskStatus>>;
  statuses?: Readonly<Record<string, IdleTaskStatus>>;

  activity?: TaskActivity;

  taskActivity?: TaskActivity;
}

export type IdleNudgeStart = number | IdleNudgeStorage;

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

export class IdleNudge {
  private readonly storage: string | undefined;
  private lastActivityAt: number;

  private closureSinceAt: number;

  private pendingClosures = new Set<string>();

  private attemptedClosures: string[] = [];
  private fired = false;
  private record: IdleNudgeRecord | undefined;

  private lastOpportunityAt: number | undefined;

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
    this.closureSinceAt =
      (this.record === undefined ? null : instant(this.record.nudgedAt)) ?? this.lastActivityAt;
  }

  get enabled(): boolean {
    return this.intervalMs > 0;
  }

  get armed(): boolean {
    return this.enabled && !this.fired;
  }

  get nudgedHash(): string | undefined {
    return this.record?.hash;
  }

  get nudgedTasks(): Readonly<Record<string, IdleNudgeTaskRecord>> {
    return this.record?.tasks ?? {};
  }

  load(): void {
    if (this.storage === undefined) return;
    this.record = readIdleNudgeRecord(this.storage);
    this.legacy = this.record !== undefined && this.record.tasks === undefined;
  }

  forgetNudge(): void {
    for (const id of this.attemptedClosures) this.pendingClosures.add(id);
    this.attemptedClosures = [];
    this.record = undefined;
    this.legacy = false;
    if (this.storage === undefined) return;
    try {
      clearIdleNudgeRecord(this.storage);
    } catch (error) {
      console.error("[pi] could not clear the idle nudge record", error);
    }
  }

  noteActivity(at: number = Date.now()): void {
    this.lastActivityAt = at;
    this.fired = false;

    this.lastOpportunityAt = undefined;
  }

  maybeNudge(state: IdleNudgeState, at?: number, activity?: TaskActivity): string | null;
  maybeNudge(state: IdleNudgeState, activity?: TaskActivity, at?: number): string | null;
  maybeNudge(
    state: IdleNudgeState,
    atOrActivity?: number | TaskActivity,
    activityOrAt?: TaskActivity | number,
  ): string | null {
    const at =
      typeof atOrActivity === "number"
        ? atOrActivity
        : typeof activityOrAt === "number"
          ? activityOrAt
          : Date.now();
    const explicitActivity =
      typeof atOrActivity === "object"
        ? atOrActivity
        : typeof activityOrAt === "object"
          ? activityOrAt
          : undefined;
    if (!this.armed) return null;
    if (state.active || state.queued > 0) return null;
    const { open, working } = selectableTasks(state);

    const stale = state.staleTasks ?? staleWorkedTasks(state.tasks ?? [], at);
    const activity = explicitActivity ?? state.activity ?? state.taskActivity;
    const previousNudge = this.record === undefined ? null : instant(this.record.nudgedAt);

    const since = previousNudge ?? this.closureSinceAt;
    const closures = unrecordedClosures(state.tasks ?? [], since, activity, this.pendingClosures);
    const liveClosures = new Set(closures.map((task) => task.id));
    for (const id of [...this.pendingClosures]) {
      if (!liveClosures.has(id)) this.pendingClosures.delete(id);
    }
    if (open.length === 0 && working.length === 0 && stale.length === 0 && closures.length === 0) {
      return null;
    }
    if (at - this.lastActivityAt < this.intervalMs) return null;

    const staleIds = stale.map((task) => task.id);
    const closedIds = [
      ...new Set([...(this.record?.closed ?? []), ...closures.map((task) => task.id)]),
    ];
    const hash = taskSetHash([...new Set([...open, ...working, ...staleIds, ...closedIds])]);
    const hasMemoryAsk = closures.length > 0;

    if (
      !hasMemoryAsk &&
      hash === this.record?.hash &&
      this.lastOpportunityAt !== undefined &&
      at - this.lastOpportunityAt < this.intervalMs
    ) {
      return null;
    }

    if (!hasMemoryAsk && this.legacy && hash === this.record?.hash) return null;

    const atIso = new Date(at).toISOString();
    const tasks: Record<string, IdleNudgeTaskRecord> = {};
    for (const [id, record] of Object.entries(this.record?.tasks ?? {})) {
      tasks[id] = { ...record };
    }
    const current = new Set([...open, ...working, ...staleIds]);
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
        previous.silent = 1;
      }
    }

    const visibleOpen = pickedOpen.slice(0, IDLE_NUDGE_TASK_LIMIT);
    const visibleWorking = pickedWorking.slice(
      0,
      Math.max(0, IDLE_NUDGE_TASK_LIMIT - visibleOpen.length),
    );

    if (visibleOpen.length === 0 && visibleWorking.length === 0) {
      const staleDue = stale.length > 0 && (hash !== this.record?.hash || hasMemoryAsk);
      if (staleDue || hasMemoryAsk) {
        const base = staleDue ? idleActualizeNudgeText(stale) : "";
        const text =
          base.length === 0 ? idleMemoryNudgeText(closures) : withMemoryRequest(base, closures);
        this.markAttempt(closures, at);
        this.record = {
          hash,
          nudgedAt: atIso,
          tasks,
          ...(closedIds.length === 0 ? {} : { closed: closedIds }),
        };
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

      this.lastOpportunityAt = at;
      this.record = {
        hash,
        nudgedAt: this.record?.nudgedAt ?? atIso,
        tasks,
        ...(closedIds.length === 0 ? {} : { closed: closedIds }),
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
    const text = withMemoryRequest(
      withStaleRequest(idleDecisionNudgeText(visibleOpen, visibleWorking, open.length), stale),
      closures,
    );
    this.markAttempt(closures, at);
    this.record = {
      hash,
      nudgedAt: atIso,
      tasks,
      ...(closedIds.length === 0 ? {} : { closed: closedIds }),
    };
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

  private markAttempt(closures: readonly IdleTask[], at: number): void {
    this.attemptedClosures = closures.map((task) => task.id);
    this.pendingClosures.clear();
    if (at > this.closureSinceAt) this.closureSinceAt = at;
  }
}
