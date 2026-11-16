import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type JobStatus = "running" | "exited" | "failed" | "cancelled" | "lost";

/** Where a job came from: an explicit tool call, or a foreground bash call that ran too long. */
export type JobOrigin = "job_start" | "bash";

/** Which conversation hears about the job: the chat, or one plan agent's task. */
export type JobOwner = { kind: "chat" } | { kind: "plan"; taskId: string };

export interface JobRecord {
  id: string;
  name: string;
  command: string;
  cwd: string;
  pid: number | null;
  status: JobStatus;
  exitCode: number | null;
  signal: string | null;
  /** Whether the agent is told when the job ends. */
  notify: boolean;
  /** `job_start`, or a `bash` call that was handed over after the foreground window. */
  origin: JobOrigin;
  /** The conversation that receives the completion notice. */
  owner: JobOwner;
  /** A hidden record is still spawning or is inside its foreground window. Absent means true. */
  visible: boolean;
  startedAt: string;
  endedAt: string | null;
}

export interface JobStartOptions {
  command: string;
  name?: string;
  notify?: boolean;
  origin?: JobOrigin;
  owner?: JobOwner;
  /** Defaults to the manager's working directory. */
  cwd?: string;
}

export interface JobPromoteOptions {
  notify?: boolean;
  origin?: JobOrigin;
  owner?: JobOwner;
}

export interface JobOutput {
  job: JobRecord;
  text: string;
  /** Byte offset where `text` starts in the log. */
  from: number;
  /** Byte offset to pass as `offset` for the next read. */
  next: number;
  size: number;
  truncated: boolean;
}

/** Called once when a job ends on its own. A cancelled job is not reported. */
export type JobNotifier = (job: JobRecord, tail: string) => void;

export class JobError extends Error {}

/** Most visible `job_start` jobs running at once. */
export const MAX_RUNNING_JOBS = 8;
/** Most commands alive at once, including hidden foreground bash calls. */
export const MAX_LIVE_COMMANDS = 12;
/** Most characters one output read returns. */
export const MAX_OUTPUT_CHARS = 20_000;
/** Finished jobs kept in the list; older ones are forgotten (their logs stay on disk). */
const MAX_KEPT_JOBS = 50;
/** Grace period between SIGTERM and SIGKILL on cancel. */
const KILL_AFTER_MS = 5_000;

/** Distinguishes temporary files written by concurrent managers in this process. */
let writeSequence = 0;
/** One in-flight write chain per index path, shared by every manager on that directory. */
const indexWrites = new Map<string, Promise<void>>();

/** Queues one index body behind whatever is already writing to the same path. */
function writeIndex(indexPath: string, body: string): Promise<void> {
  const previous = indexWrites.get(indexPath) ?? Promise.resolve();
  const next = previous
    .then(async () => {
      writeSequence += 1;
      const temporary = `${indexPath}.${process.pid}.${writeSequence}.tmp`;
      try {
        await writeFile(temporary, body);
        await rename(temporary, indexPath);
      } catch (error) {
        await unlink(temporary).catch(() => undefined);
        throw error;
      }
    })
    .catch((error: unknown) => {
      console.error("[pi] could not save the job list", error);
    });
  indexWrites.set(indexPath, next);
  void next.then(() => {
    if (indexWrites.get(indexPath) === next) indexWrites.delete(indexPath);
  });
  return next;
}

/**
 * Shell commands the agent runs in the background. Each job runs `bash -lc` in its own
 * process group with stdout and stderr appended to `DATA_DIR/jobs/<id>.log`, so output
 * survives a server restart and a long build cannot fill memory. When a job ends on its
 * own, the notifier gets its record and the last lines of output. Jobs the agent is not
 * told about (cancelled, or started with `notify: false`) go to the quiet notifier, which
 * the chat shows without involving the agent.
 */
export class JobManager {
  private readonly dir: string;
  private readonly indexPath: string;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly children = new Map<string, ChildProcess>();
  private readonly killTimers = new Map<string, NodeJS.Timeout>();
  private readonly exitWaiters = new Map<string, Set<(exited: boolean) => void>>();
  private notifier: JobNotifier | undefined;
  private quietNotifier: JobNotifier | undefined;
  private changeListener: (() => void) | undefined;
  private readonly pending: JobRecord[] = [];
  private sequence = 0;
  private writes: Promise<void> = Promise.resolve();
  private orphanTimer: NodeJS.Timeout | undefined;

  constructor(
    dataDir: string,
    private readonly cwd: string,
  ) {
    this.dir = join(dataDir, "jobs");
    this.indexPath = join(this.dir, "jobs.json");
  }

  /** Loads the saved list. A job that was running when the server stopped is watched by pid. */
  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    let saved: JobRecord[] = [];
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, "utf8")) as { jobs?: JobRecord[] };
      saved = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    } catch {
      saved = [];
    }
    for (const raw of saved) {
      if (typeof raw?.id !== "string") continue;
      const job: JobRecord = {
        ...raw,
        origin: raw.origin ?? "job_start",
        owner: raw.owner ?? { kind: "chat" },
        visible: raw.visible !== false,
      };
      this.jobs.set(job.id, job);
      const number = Number.parseInt(job.id.replace(/^j/, ""), 10);
      if (Number.isSafeInteger(number)) this.sequence = Math.max(this.sequence, number);
      if (job.visible === false) {
        // A hide is transient: the foreground window either promoted the job before the
        // crash or the command ended with its record about to be discarded. A live pid is
        // adopted as an ordinary bash job; anything else is stale and leaves no log.
        if (job.status === "running" && alive(job.pid)) {
          job.visible = true;
          job.notify = true;
          job.origin = "bash";
        } else {
          this.jobs.delete(job.id);
          await unlink(this.logPath(job.id)).catch(() => undefined);
          continue;
        }
      }
      if (job.status === "running" && !alive(job.pid)) this.finish(job, "lost", null, null);
    }
    this.watchOrphans();
  }

  /** Sets who hears about finished jobs, and hands it any that ended before it was set. */
  /** Receives jobs that end without telling the agent: cancelled ones and `notify: false` ones. */
  setQuietNotifier(notifier: JobNotifier | undefined): void {
    this.quietNotifier = notifier;
  }

  setNotifier(notifier: JobNotifier | undefined): void {
    this.notifier = notifier;
    if (notifier === undefined) return;
    const pending = this.pending.splice(0);
    for (const job of pending) this.notify(job);
  }

  /** Called after any job starts, ends or is cancelled. */
  onChange(listener: (() => void) | undefined): void {
    this.changeListener = listener;
  }

  private all(): JobRecord[] {
    return [...this.jobs.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  list(): JobRecord[] {
    return this.all().filter((job) => job.visible !== false);
  }

  get(id: string): JobRecord {
    const job = this.jobs.get(id.trim());
    if (job === undefined) throw new JobError(`Unknown job ${id}. Use job_list to see job ids.`);
    return job;
  }

  /** Spawns a hidden command. It is not listed or announced until `promote()` makes it a job. */
  begin(options: JobStartOptions): JobRecord {
    const command = options.command.trim();
    if (command.length === 0) throw new JobError("The command is empty.");
    const live = [...this.jobs.values()].filter((job) => job.status === "running").length;
    if (live >= MAX_LIVE_COMMANDS) {
      throw new JobError(`${MAX_LIVE_COMMANDS} commands are already running; cancel one or wait.`);
    }
    this.sequence += 1;
    const id = `j${this.sequence}`;
    const cwd = options.cwd ?? this.cwd;
    const logPath = this.logPath(id);
    const fd = openSync(logPath, "a");
    let child: ChildProcess;
    try {
      child = spawn("bash", ["-lc", command], {
        cwd,
        detached: true,
        stdio: ["ignore", fd, fd],
        env: process.env,
      });
    } finally {
      closeSync(fd);
    }
    const job: JobRecord = {
      id,
      name: options.name?.trim() || command.split("\n")[0]?.slice(0, 80) || id,
      command,
      cwd,
      pid: child.pid ?? null,
      status: "running",
      exitCode: null,
      signal: null,
      notify: false,
      origin: options.origin ?? "bash",
      owner: options.owner ?? { kind: "chat" },
      visible: false,
      startedAt: new Date().toISOString(),
      endedAt: null,
    };
    this.jobs.set(id, job);
    this.children.set(id, child);
    child.on("error", (error) => {
      void this.appendLog(id, `\n[pi-ui] could not start: ${error.message}\n`);
      this.settle(id, "failed", null, null);
    });
    child.on("exit", (code, signal) => {
      const cancelled = this.jobs.get(id)?.status === "cancelled";
      if (cancelled) {
        this.children.delete(id);
        return;
      }
      this.settle(id, code === 0 ? "exited" : "failed", code, signal);
    });
    this.prune();
    this.save();
    return { ...job };
  }

  /** Starts a visible `job_start` job: the old contract, now built from `begin()` and `promote()`. */
  start(options: JobStartOptions): JobRecord {
    const running = this.list().filter((job) => job.status === "running").length;
    if (running >= MAX_RUNNING_JOBS) {
      throw new JobError(
        `${running} jobs are already running; the limit is ${MAX_RUNNING_JOBS}. Cancel one or wait.`,
      );
    }
    const job = this.begin({
      ...options,
      origin: options.origin ?? "job_start",
      owner: options.owner ?? { kind: "chat" },
    });
    return this.promote(job.id, { notify: options.notify !== false });
  }

  /** Makes a hidden command a real job: listed, announced when it ends, and watched by pid. */
  promote(id: string, options: JobPromoteOptions = {}): JobRecord {
    const job = this.get(id);
    job.visible = true;
    job.notify = options.notify ?? true;
    if (options.origin !== undefined) job.origin = options.origin;
    if (options.owner !== undefined) job.owner = options.owner;
    this.save();
    this.watchOrphans();
    // The command may have ended in the instant before the handoff. `finish()` skipped the
    // announcement while the record was hidden, so make it now instead of losing the notice.
    // A cancelled command sends no completion message, even if the cancel raced the handoff.
    if (job.status !== "running" && job.status !== "cancelled") this.announce(job);
    return { ...job };
  }

  /**
   * Forgets a hidden command once its output is no longer needed. The log is deleted unless
   * `keepLog` is set, which a truncated result needs so `fullOutputPath` still works.
   */
  async discard(id: string, options: { keepLog?: boolean } = {}): Promise<void> {
    const job = this.jobs.get(id.trim());
    if (job === undefined) return;
    this.jobs.delete(job.id);
    this.children.delete(job.id);
    // A cancelled command may still be ignoring SIGTERM. Keep its escalation timer: it owns
    // only the pid, checks groupAlive() before signalling, and removes itself when it fires.
    if (job.status !== "cancelled") {
      const timer = this.killTimers.get(job.id);
      if (timer !== undefined) {
        clearTimeout(timer);
        this.killTimers.delete(job.id);
      }
    }
    this.save();
    if (options.keepLog !== true) {
      await unlink(this.logPath(job.id)).catch(() => undefined);
    }
  }

  /**
   * Waits for a job to end, resolving `{exited:false}` on the timeout or an abort. It never stops
   * the command: the caller decides whether to promote it.
   */
  waitForExit(id: string, timeoutMs: number, signal?: AbortSignal): Promise<{ exited: boolean }> {
    const job = this.get(id);
    if (job.status !== "running") return Promise.resolve({ exited: true });
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      let settled = false;
      const settle = (exited: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.exitWaiters.get(id)?.delete(settle);
        resolve({ exited });
      };
      const onAbort = (): void => settle(false);
      if (signal?.aborted) {
        settle(false);
        return;
      }
      timer = setTimeout(() => settle(false), Math.max(0, timeoutMs));
      timer.unref();
      signal?.addEventListener("abort", onAbort, { once: true });
      let waiters = this.exitWaiters.get(id);
      if (waiters === undefined) {
        waiters = new Set();
        this.exitWaiters.set(id, waiters);
      }
      waiters.add(settle);
    });
  }

  /** Stops a running job and its children: SIGTERM to the group, SIGKILL if it is still up after 5 s. */
  cancel(id: string): JobRecord {
    const job = this.get(id);
    if (job.status !== "running") return { ...job };
    const pid = job.pid;
    job.status = "cancelled";
    job.endedAt = new Date().toISOString();
    this.save();
    // A foreground bash call is waiting in waitForExit. Cancelling is an exit, so wake it
    // now instead of leaving it to promote a cancelled command when the window expires.
    this.resolveExitWaiters(job.id, true);
    if (pid !== null) {
      signalGroup(pid, "SIGTERM");
      const timer = setTimeout(() => {
        this.killTimers.delete(job.id);
        // The group leader can exit while a child ignores SIGTERM, so ask the
        // group rather than the leader whether anything still needs SIGKILL.
        if (groupAlive(pid)) signalGroup(pid, "SIGKILL");
      }, KILL_AFTER_MS);
      timer.unref();
      this.killTimers.set(job.id, timer);
    }
    // A hidden command has no job row or completion notice yet; its caller returns the result.
    if (job.visible === false) return { ...job };
    const record = { ...job };
    void this.appendLog(job.id, "\n[pi-ui] cancelled\n").then(() =>
      this.notify(record, this.quietNotifier),
    );
    return { ...job };
  }

  /**
   * Reads a job's log. With `offset`, returns up to MAX_OUTPUT_CHARS from that byte; without it,
   * the last `tail` lines (default 100).
   */
  async output(id: string, options: { offset?: number; tail?: number } = {}): Promise<JobOutput> {
    const job = this.get(id);
    const path = this.logPath(job.id);
    let size = 0;
    try {
      size = (await stat(path)).size;
    } catch {
      return { job: { ...job }, text: "", from: 0, next: 0, size: 0, truncated: false };
    }
    if (options.offset !== undefined) {
      const from = Math.max(0, Math.min(Math.floor(options.offset), size));
      const length = Math.min(size - from, MAX_OUTPUT_CHARS * 4);
      let text = await readRange(path, from, length);
      let truncated = from + length < size;
      if (text.length > MAX_OUTPUT_CHARS) {
        text = text.slice(0, MAX_OUTPUT_CHARS);
        truncated = true;
      }
      const next = from + Buffer.byteLength(text);
      return { job: { ...job }, text, from, next, size, truncated };
    }
    const lines = Math.max(1, Math.min(Math.floor(options.tail ?? 100), 2000));
    const window = Math.min(size, MAX_OUTPUT_CHARS * 4);
    const raw = await readRange(path, size - window, window);
    const kept = tailLines(raw, lines, MAX_OUTPUT_CHARS);
    const from = size - Buffer.byteLength(kept);
    return { job: { ...job }, text: kept, from, next: size, size, truncated: from > 0 };
  }

  /** Where a job's combined stdout and stderr are appended. */
  logPath(id: string): string {
    return join(this.dir, `${id}.log`);
  }

  private async appendLog(id: string, text: string): Promise<void> {
    try {
      const handle = await open(this.logPath(id), "a");
      await handle.write(text);
      await handle.close();
    } catch {
      // The log is best effort; the record still carries the status.
    }
  }

  private settle(
    id: string,
    status: JobStatus,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    const job = this.jobs.get(id);
    this.children.delete(id);
    if (job === undefined || job.status !== "running") return;
    this.finish(job, status, exitCode, signal);
  }

  private finish(
    job: JobRecord,
    status: JobStatus,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    job.status = status;
    job.exitCode = exitCode;
    job.signal = signal;
    job.endedAt = new Date().toISOString();
    this.save();
    this.resolveExitWaiters(job.id, true);
    // A hidden command inside its foreground window is not a job yet: its caller reads
    // the record and discards it. Announcing it would put a phantom row in the activity page.
    if (job.visible === false) return;
    this.announce(job);
  }

  /** Wakes the waiters once, whether the command exited or was cancelled. */
  private resolveExitWaiters(id: string, exited: boolean): void {
    const waiters = this.exitWaiters.get(id);
    this.exitWaiters.delete(id);
    for (const waiter of waiters ?? []) waiter(exited);
  }

  private announce(job: JobRecord): void {
    if (!job.notify) {
      this.notify({ ...job }, this.quietNotifier);
      return;
    }
    if (this.notifier === undefined) this.pending.push({ ...job });
    else this.notify({ ...job });
  }

  private notify(job: JobRecord, notifier = this.notifier): void {
    if (notifier === undefined) return;
    void this.output(job.id, { tail: 20 })
      .then((output) => output.text)
      .catch(() => "")
      .then((tail) => notifier(job, tail));
  }

  /** Jobs left running by an earlier server process end without an exit event; poll their pids. */
  private watchOrphans(): void {
    if (this.orphanTimer !== undefined) return;
    const orphans = () =>
      this.list().filter((job) => job.status === "running" && !this.children.has(job.id));
    if (orphans().length === 0) return;
    this.orphanTimer = setInterval(() => {
      const left = orphans();
      for (const job of left) if (!alive(job.pid)) this.finish(job, "lost", null, null);
      if (left.every((job) => job.status !== "running") && this.orphanTimer !== undefined) {
        clearInterval(this.orphanTimer);
        this.orphanTimer = undefined;
      }
    }, 2_000);
    this.orphanTimer.unref();
  }

  private prune(): void {
    // Hidden records are transient: the caller discards them, and load() drops any left behind.
    const finished = this.list().filter((job) => job.status !== "running");
    for (const job of finished.slice(0, Math.max(0, finished.length - MAX_KEPT_JOBS))) {
      this.jobs.delete(job.id);
    }
  }

  private save(): void {
    try {
      this.changeListener?.();
    } catch (error) {
      console.error("[pi] job change listener failed", error);
    }
    // Hidden commands are saved too, so a crash inside the foreground window can adopt
    // the detached process instead of leaking it.
    const body = `${JSON.stringify({ jobs: this.all() }, null, 2)}\n`;
    this.writes = writeIndex(this.indexPath, body);
  }

  /** Resolves once pending list writes are on disk. */
  flush(): Promise<void> {
    return this.writes;
  }
}

function alive(pid: number | null): boolean {
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

async function readRange(path: string, from: number, length: number): Promise<string> {
  if (length <= 0) return "";
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, from);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** The last `lines` lines of `text`, at most `maxChars` characters. */
export function tailLines(text: string, lines: number, maxChars: number): string {
  const parts = text.split("\n");
  const ends = parts.at(-1) === "";
  const body = ends ? parts.slice(0, -1) : parts;
  let kept = body.slice(-lines).join("\n") + (ends ? "\n" : "");
  if (kept.length > maxChars) kept = kept.slice(kept.length - maxChars);
  return kept;
}

/** A short duration like `42s` or `3m 05s`. */
export function formatDuration(
  startedAt: string,
  endedAt: string | null,
  now = Date.now(),
): string {
  const end = endedAt === null ? now : Date.parse(endedAt);
  const seconds = Math.max(0, Math.round((end - Date.parse(startedAt)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function describeJob(job: JobRecord, now = Date.now()): string {
  const duration = formatDuration(job.startedAt, job.endedAt, now);
  const state =
    job.status === "running"
      ? `running for ${duration}`
      : job.status === "exited"
        ? `exited 0 after ${duration}`
        : job.status === "failed"
          ? job.exitCode === null
            ? `failed${job.signal === null ? "" : ` (${job.signal})`} after ${duration}`
            : `exited ${job.exitCode} after ${duration}`
          : job.status === "cancelled"
            ? `cancelled after ${duration}`
            : "lost (the server restarted and the exit code is unknown)";
  const owner = job.owner?.kind === "plan" ? ` (plan ${job.owner.taskId})` : "";
  return `${job.id} ${state}: ${job.name}${owner}`;
}

/** What the agent reads when a job ends on its own. */
export function jobNotice(job: JobRecord, tail: string): string {
  const body = tail.trimEnd();
  return [
    `[background job ${job.id} finished] ${describeJob(job)}`,
    ...(job.name === job.command ? [] : [`Command: ${job.command}`]),
    body.length > 0 ? `Last output:\n\`\`\`\n${body}\n\`\`\`` : "It printed nothing.",
    `Read more with job_output id=${job.id}.`,
  ].join("\n");
}
