import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type JobStatus = "running" | "exited" | "failed" | "cancelled" | "lost";

export type JobOrigin = "job_start" | "bash";

export type JobOwner =
  | { kind: "chat" }
  | { kind: "plan"; taskId: string }
  | { kind: "delegate"; runId: string };

export interface JobRecord {
  id: string;
  name: string;
  command: string;
  cwd: string;
  pid: number | null;
  status: JobStatus;
  exitCode: number | null;
  signal: string | null;

  notify: boolean;

  origin: JobOrigin;

  owner: JobOwner;

  visible: boolean;
  startedAt: string;
  endedAt: string | null;
}

export interface JobOutput {
  job: JobRecord;
  text: string;

  from: number;

  next: number;
  size: number;
  truncated: boolean;
}

export type JobNotifier = (job: JobRecord, tail: string) => void;

export class JobError extends Error {}

export const MAX_RUNNING_JOBS = 8;

export const MAX_LIVE_COMMANDS = 12;

export const MAX_OUTPUT_CHARS = 20_000;

const MAX_KEPT_JOBS = 50;

const KILL_AFTER_MS = 5_000;

let writeSequence = 0;

const indexWrites = new Map<string, Promise<void>>();

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

export class JobManager {
  private readonly dir: string;
  private readonly indexPath: string;
  private readonly jobs = new Map<string, JobRecord>();
  private readonly children = new Map<string, ChildProcess>();
  private readonly killTimers = new Map<string, NodeJS.Timeout>();
  private notifier: JobNotifier | undefined;
  private quietNotifier: JobNotifier | undefined;
  private changeListener: (() => void) | undefined;
  private readonly pending: JobRecord[] = [];

  private readonly exitWaiters = new Map<string, Set<(exited: boolean) => void>>();
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

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    let saved: JobRecord[] = [];
    let savedSequence = 0;
    try {
      const parsed = JSON.parse(await readFile(this.indexPath, "utf8")) as {
        jobs?: JobRecord[];
        sequence?: unknown;
      };
      saved = Array.isArray(parsed.jobs) ? parsed.jobs : [];
      if (typeof parsed.sequence === "number" && Number.isSafeInteger(parsed.sequence)) {
        savedSequence = Math.max(0, parsed.sequence);
      }
    } catch {
      saved = [];
    }

    this.sequence = Math.max(this.sequence, savedSequence);
    try {
      for (const name of await readdir(this.dir)) {
        const match = /^j(\d+)\.log$/.exec(name);
        const number = match === null ? Number.NaN : Number.parseInt(match[1] ?? "", 10);
        if (Number.isSafeInteger(number)) this.sequence = Math.max(this.sequence, number);
      }
    } catch {}
    let changed = false;
    for (const raw of saved) {
      if (typeof raw?.id !== "string") continue;
      const job = normalizeJob(raw);
      const number = Number.parseInt(job.id.replace(/^j/, ""), 10);
      if (Number.isSafeInteger(number)) this.sequence = Math.max(this.sequence, number);

      if (job.visible === false && job.status !== "running") {
        await unlink(this.pathFor(job.id)).catch(() => undefined);
        changed = true;
        continue;
      }
      this.jobs.set(job.id, job);
      if (job.status !== "running") continue;
      if (!alive(job.pid)) {
        if (job.visible === false) {
          this.jobs.delete(job.id);
          await unlink(this.pathFor(job.id)).catch(() => undefined);
          changed = true;
        } else {
          this.finish(job, "lost", null, null);
        }
        continue;
      }
      if (job.visible === false) {
        job.visible = true;
        job.notify = true;
        job.origin = "bash";
        changed = true;
      }
    }
    if (changed) this.save();
    this.watchOrphans();
  }

  setQuietNotifier(notifier: JobNotifier | undefined): void {
    this.quietNotifier = notifier;
  }

  setNotifier(notifier: JobNotifier | undefined): void {
    this.notifier = notifier;
    if (notifier === undefined) return;
    const pending = this.pending.splice(0);
    for (const job of pending) this.notify(job);
  }

  onChange(listener: (() => void) | undefined): void {
    this.changeListener = listener;
  }

  list(): JobRecord[] {
    return this.all().filter((job) => job.visible !== false);
  }

  private all(): JobRecord[] {
    return [...this.jobs.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  get(id: string): JobRecord {
    const job = this.jobs.get(id.trim());
    if (job === undefined) throw new JobError(`Unknown job ${id}. Use job_list to see job ids.`);
    return job;
  }

  start(options: { command: string; name?: string; notify?: boolean }): JobRecord {
    const running = this.list().filter(
      (job) => job.status === "running" && job.origin === "job_start",
    ).length;
    if (running >= MAX_RUNNING_JOBS) {
      throw new JobError(
        `${running} jobs are already running; the limit is ${MAX_RUNNING_JOBS}. Cancel one or wait.`,
      );
    }
    const job = this.begin({ ...options, origin: "job_start" });
    return this.promote(job.id, { notify: options.notify !== false });
  }

  begin(options: {
    command: string;
    name?: string;
    cwd?: string;
    notify?: boolean;
    owner?: JobOwner;
    origin?: JobOrigin;
  }): JobRecord {
    const command = options.command.trim();
    if (command.length === 0) throw new JobError("The command is empty.");
    const live = this.all().filter((job) => job.status === "running").length;
    if (live >= MAX_LIVE_COMMANDS) {
      throw new JobError(`${live} commands are already running; cancel one or wait.`);
    }
    let id: string;
    do {
      this.sequence += 1;
      id = `j${this.sequence}`;
    } while (this.jobs.has(id) || existsSync(this.pathFor(id)));
    const logPath = this.pathFor(id);
    const cwd = options.cwd ?? this.cwd;

    const fd = openSync(logPath, "w");
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
      notify: options.notify !== false,
      origin: options.origin ?? "job_start",
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

  promote(id: string, options: { notify?: boolean } = {}): JobRecord {
    const job = this.get(id);
    const wasVisible = job.visible !== false;
    job.visible = true;
    job.notify = options.notify ?? true;
    this.save();
    if (job.status === "running") {
      if (!wasVisible) this.watchOrphans();
    } else if (!wasVisible) {
      this.publishFinished(job);
    }
    return { ...job };
  }

  async discard(id: string, options: { keepLog?: boolean } = {}): Promise<void> {
    const job = this.jobs.get(id);
    if (job === undefined) return;
    this.jobs.delete(id);
    this.children.delete(id);
    this.resolveExitWaiters(id, true);
    if (options.keepLog !== true) await unlink(this.pathFor(job.id)).catch(() => undefined);
    this.save();
  }

  waitForExit(
    id: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ exited: true } | { exited: false }> {
    const job = this.get(id);
    if (job.status !== "running") return Promise.resolve({ exited: true });
    if (signal?.aborted === true) return Promise.resolve({ exited: false });
    return new Promise((resolve) => {
      let done = false;
      let timer: NodeJS.Timeout | undefined;
      const waiter = (exited: boolean): void => {
        if (done) return;
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.exitWaiters.get(id)?.delete(waiter);
        resolve(exited ? { exited: true } : { exited: false });
      };
      const onAbort = (): void => waiter(false);
      timer = setTimeout(() => waiter(false), Math.max(0, timeoutMs));
      timer.unref?.();
      signal?.addEventListener("abort", onAbort, { once: true });
      let waiters = this.exitWaiters.get(id);
      if (waiters === undefined) {
        waiters = new Set();
        this.exitWaiters.set(id, waiters);
      }
      waiters.add(waiter);
    });
  }

  cancel(id: string): JobRecord {
    const job = this.get(id);
    if (job.status !== "running") return { ...job };
    const pid = job.pid;
    job.status = "cancelled";
    job.endedAt = new Date().toISOString();
    this.save();
    this.resolveExitWaiters(job.id, true);
    if (pid !== null) {
      signalGroup(pid, "SIGTERM");
      const timer = setTimeout(() => {
        this.killTimers.delete(job.id);

        if (groupAlive(pid)) signalGroup(pid, "SIGKILL");
      }, KILL_AFTER_MS);
      timer.unref();
      this.killTimers.set(job.id, timer);
    }
    const record = { ...job };
    void this.appendLog(job.id, "\n[pi-ui] cancelled\n").then(() =>
      this.notify(record, this.quietNotifier),
    );
    return { ...job };
  }

  async output(id: string, options: { offset?: number; tail?: number } = {}): Promise<JobOutput> {
    const job = this.get(id);
    const path = this.pathFor(job.id);
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

  logPath(id: string): string {
    const job = this.get(id);
    return this.pathFor(job.id);
  }

  private pathFor(id: string): string {
    return join(this.dir, `${id}.log`);
  }

  private async appendLog(id: string, text: string): Promise<void> {
    try {
      const handle = await open(this.pathFor(id), "a");
      await handle.write(text);
      await handle.close();
    } catch {}
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
    if (job.visible === false) return;
    this.publishFinished(job);
  }

  private publishFinished(job: JobRecord): void {
    if (!job.notify) {
      this.notify({ ...job }, this.quietNotifier);
      return;
    }
    if (this.notifier === undefined) this.pending.push({ ...job });
    else this.notify({ ...job });
  }

  private resolveExitWaiters(id: string, exited: boolean): void {
    const waiters = this.exitWaiters.get(id);
    if (waiters === undefined) return;
    this.exitWaiters.delete(id);
    for (const waiter of waiters) waiter(exited);
  }

  private notify(job: JobRecord, notifier = this.notifier): void {
    if (notifier === undefined) return;
    void this.output(job.id, { tail: 20 })
      .then((output) => output.text)
      .catch(() => "")
      .then((tail) => notifier(job, tail));
  }

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
    const finished = this.all().filter((job) => job.status !== "running");
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
    const body = `${JSON.stringify({ sequence: this.sequence, jobs: this.all() }, null, 2)}\n`;
    this.writes = writeIndex(this.indexPath, body);
  }

  flush(): Promise<void> {
    return this.writes;
  }
}

function normalizeJob(job: JobRecord): JobRecord {
  const owner = job.owner;
  return {
    ...job,
    origin: job.origin === "bash" ? "bash" : "job_start",
    owner:
      owner?.kind === "plan" && typeof owner.taskId === "string"
        ? { kind: "plan", taskId: owner.taskId }
        : owner?.kind === "delegate" && typeof owner.runId === "string"
          ? { kind: "delegate", runId: owner.runId }
          : { kind: "chat" },
    visible: job.visible !== false,
  };
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
    } catch {}
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

export function tailLines(text: string, lines: number, maxChars: number): string {
  const parts = text.split("\n");
  const ends = parts.at(-1) === "";
  const body = ends ? parts.slice(0, -1) : parts;
  let kept = body.slice(-lines).join("\n") + (ends ? "\n" : "");
  if (kept.length > maxChars) kept = kept.slice(kept.length - maxChars);
  return kept;
}

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
  const owner =
    job.owner?.kind === "plan"
      ? ` (plan ${job.owner.taskId})`
      : job.owner?.kind === "delegate"
        ? ` (delegate ${job.owner.runId})`
        : "";
  return `${job.id} ${state}: ${job.name}${owner}`;
}

export function jobNotice(job: JobRecord, tail: string): string {
  const body = tail.trimEnd();
  return [
    `[background job ${job.id} finished] ${describeJob(job)}`,
    ...(job.name === job.command ? [] : [`Command: ${job.command}`]),
    body.length > 0 ? `Last output:\n\`\`\`\n${body}\n\`\`\`` : "It printed nothing.",
    `Read more with job_output id=${job.id}.`,
  ].join("\n");
}
