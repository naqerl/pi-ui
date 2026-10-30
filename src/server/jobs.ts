import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type JobStatus = "running" | "exited" | "failed" | "cancelled" | "lost";

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
  startedAt: string;
  endedAt: string | null;
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

/** Most jobs running at once. */
export const MAX_RUNNING_JOBS = 8;
/** Most characters one output read returns. */
export const MAX_OUTPUT_CHARS = 20_000;
/** Finished jobs kept in the list; older ones are forgotten (their logs stay on disk). */
const MAX_KEPT_JOBS = 50;
/** Grace period between SIGTERM and SIGKILL on cancel. */
const KILL_AFTER_MS = 5_000;

/**
 * Shell commands the agent runs in the background. Each job runs `bash -lc` in its own
 * process group with stdout and stderr appended to `DATA_DIR/jobs/<id>.log`, so output
 * survives a server restart and a long build cannot fill memory. When a job ends on its
 * own, the notifier gets its record and the last lines of output.
 */
export class JobManager {
  private readonly dir: string;
  private readonly indexPath: string;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly children = new Map<string, ChildProcess>();
  private readonly killTimers = new Map<string, NodeJS.Timeout>();
  private notifier: JobNotifier | undefined;
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
    for (const job of saved) {
      if (typeof job?.id !== "string") continue;
      this.jobs.set(job.id, job);
      const number = Number.parseInt(job.id.replace(/^j/, ""), 10);
      if (Number.isSafeInteger(number)) this.sequence = Math.max(this.sequence, number);
      if (job.status === "running" && !alive(job.pid)) this.finish(job, "lost", null, null);
    }
    this.watchOrphans();
  }

  /** Sets who hears about finished jobs, and hands it any that ended before it was set. */
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

  list(): JobRecord[] {
    return [...this.jobs.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  get(id: string): JobRecord {
    const job = this.jobs.get(id.trim());
    if (job === undefined) throw new JobError(`Unknown job ${id}. Use job_list to see job ids.`);
    return job;
  }

  start(options: { command: string; name?: string; notify?: boolean }): JobRecord {
    const command = options.command.trim();
    if (command.length === 0) throw new JobError("The command is empty.");
    const running = this.list().filter((job) => job.status === "running").length;
    if (running >= MAX_RUNNING_JOBS) {
      throw new JobError(
        `${running} jobs are already running; the limit is ${MAX_RUNNING_JOBS}. Cancel one or wait.`,
      );
    }
    this.sequence += 1;
    const id = `j${this.sequence}`;
    const logPath = this.logPath(id);
    const fd = openSync(logPath, "a");
    let child: ChildProcess;
    try {
      child = spawn("bash", ["-lc", command], {
        cwd: this.cwd,
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
      cwd: this.cwd,
      pid: child.pid ?? null,
      status: "running",
      exitCode: null,
      signal: null,
      notify: options.notify !== false,
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

  /** Stops a running job and its children: SIGTERM to the group, SIGKILL if it is still up after 5 s. */
  cancel(id: string): JobRecord {
    const job = this.get(id);
    if (job.status !== "running") return { ...job };
    const pid = job.pid;
    job.status = "cancelled";
    job.endedAt = new Date().toISOString();
    this.save();
    if (pid !== null) {
      signalGroup(pid, "SIGTERM");
      const timer = setTimeout(() => {
        this.killTimers.delete(job.id);
        if (alive(pid)) signalGroup(pid, "SIGKILL");
      }, KILL_AFTER_MS);
      timer.unref();
      this.killTimers.set(job.id, timer);
    }
    void this.appendLog(job.id, "\n[pi-ui] cancelled\n");
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

  private logPath(id: string): string {
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
    if (!job.notify) return;
    if (this.notifier === undefined) this.pending.push({ ...job });
    else this.notify({ ...job });
  }

  private notify(job: JobRecord): void {
    const notifier = this.notifier;
    if (notifier === undefined) return;
    void this.output(job.id, { tail: 20 })
      .then((output) => output.text)
      .catch(() => "")
      .then((tail) => notifier(job, tail));
  }

  /** Jobs left running by an earlier server process end without an exit event; poll their pids. */
  private watchOrphans(): void {
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
    const body = `${JSON.stringify({ jobs: this.list() }, null, 2)}\n`;
    this.writes = this.writes
      .then(async () => {
        const temporary = `${this.indexPath}.${process.pid}.tmp`;
        await writeFile(temporary, body);
        await rename(temporary, this.indexPath);
      })
      .catch((error: unknown) => {
        console.error("[pi] could not save the job list", error);
      });
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
  return `${job.id} ${state}: ${job.name}`;
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
