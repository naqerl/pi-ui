import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import {
  BASH_HANDOFF_MS,
  bashHandoffNotice,
  createTimedBashTool,
} from "../src/server/bash-tool.js";
import { createJobTools } from "../src/server/job-tools.js";
import { describeJob, JobManager, type JobRecord } from "../src/server/jobs.js";

interface RunResult {
  output?: { type: string; text: string }[];
  structuredOutput?: {
    output: string;
    truncated: boolean;
    fullOutputPath?: string;
    exitCode: number | null;
    jobId?: string;
  };
  isError?: boolean;
  diagnostics?: { severity: string; code?: string; message: string }[];
}

interface FakeApi {
  env: { cwd: string };
  output(chunk: string): void;
  retainedOutput(): { text: string; truncated: boolean };
  diagnostic(value: { severity: string; code?: string; message: string }): void;
}

function fakeApi(cwd: string, retainChars?: number): FakeApi {
  let text = "";
  return {
    env: { cwd },
    output(chunk) {
      text += chunk;
    },
    retainedOutput() {
      if (retainChars === undefined) return { text, truncated: false };
      return text.length > retainChars
        ? { text: text.slice(-retainChars), truncated: true }
        : { text, truncated: false };
    },
    diagnostic() {},
  };
}

function execute(
  tool: ToolRegistration,
  command: string,
  cwd: string,
  options: { signal?: AbortSignal; retainChars?: number } = {},
): Promise<{ result: RunResult; api: FakeApi }> {
  const api = fakeApi(cwd, options.retainChars);
  const run = tool as unknown as {
    execute(
      args: { command: string },
      api: unknown,
      context: { abortSignal?: AbortSignal },
    ): Promise<RunResult>;
  };
  return run
    .execute({ command }, api, options.signal === undefined ? {} : { abortSignal: options.signal })
    .then((result) => ({ result, api }));
}

async function until(
  check: () => boolean | Promise<boolean>,
  ms = 10_000,
  what = "condition",
): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > ms) throw new Error(`${what} did not happen within ${ms}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function jobStore(t: {
  after: (fn: () => Promise<void>) => void;
}): Promise<{ dataDir: string; jobs: JobManager }> {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-bash-handoff-"));
  const jobs = new JobManager(dataDir, dataDir);
  await jobs.load();
  t.after(async () => {
    for (const job of jobs.list()) {
      if (job.status !== "running") continue;
      jobs.cancel(job.id);
    }
    await jobs.flush();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, jobs };
}

async function logFiles(dataDir: string): Promise<string[]> {
  return (await readdir(join(dataDir, "jobs"))).filter((name) => name.endsWith(".log"));
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function liveGroup(pid: number): string[] {
  const result = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,cmd="], {
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  return (result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      const fields = line.split(/\s+/);
      return Number.parseInt(fields[2] ?? "", 10) === pid && !/^[ZX]/.test(fields[3] ?? "");
    });
}

test("a fast command returns its output and leaves no job or log", async (t) => {
  const { dataDir, jobs } = await jobStore(t);
  const tool = createTimedBashTool(jobs, { handoffMs: 5_000 });
  const { result } = await execute(tool, "echo hi", dataDir);
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredOutput?.exitCode, 0);
  assert.match(result.structuredOutput?.output ?? "", /hi/);
  assert.deepEqual(jobs.list(), []);
  assert.deepEqual(await logFiles(dataDir), []);

  const jobList = createJobTools(jobs).find((candidate) => candidate.name === "job_list");
  assert.ok(jobList);
  const listed = await (
    jobList as unknown as {
      execute(args: unknown, api: unknown): Promise<{ output: { text: string }[] }>;
    }
  ).execute({}, {});
  assert.equal(listed.output[0]?.text, "No background jobs.");
});

test("a nonzero exit is an error result with its exit code", async (t) => {
  const { dataDir, jobs } = await jobStore(t);
  const tool = createTimedBashTool(jobs, { handoffMs: 5_000 });
  const { result } = await execute(tool, "echo boom; exit 3", dataDir);
  assert.equal(result.isError, true);
  assert.equal(result.structuredOutput?.exitCode, 3);
  assert.equal(result.diagnostics?.[0]?.code, "exit_code");
  assert.match(result.structuredOutput?.output ?? "", /boom/);
});

test("a truncated fast-path result keeps the full log and returns its path", async (t) => {
  const { dataDir, jobs } = await jobStore(t);
  const tool = createTimedBashTool(jobs, { handoffMs: 5_000 });
  const { result } = await execute(tool, "seq -f 'line-%04g' 1 1000", dataDir, {
    retainChars: 200,
  });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredOutput?.exitCode, 0);
  assert.equal(result.structuredOutput?.truncated, true);
  const fullOutputPath = result.structuredOutput?.fullOutputPath;
  assert.ok(fullOutputPath);
  const full = await readFile(fullOutputPath, "utf8");
  assert.match(full, /line-0001\n/);
  assert.match(full, /line-1000\n/);
  assert.equal(existsSync(fullOutputPath), true);
  assert.deepEqual(jobs.list(), []);
});

test("cancelling a hidden command wakes waitForExit without a notice", async (t) => {
  const { dataDir, jobs } = await jobStore(t);
  const notices: string[] = [];
  const quiet: string[] = [];
  jobs.setNotifier((job) => notices.push(job.id));
  jobs.setQuietNotifier((job) => quiet.push(job.id));
  const hidden = jobs.begin({ command: "sleep 30", cwd: dataDir, origin: "bash" });
  const pending = jobs.waitForExit(hidden.id, 5_000);
  const started = Date.now();
  const cancelled = jobs.cancel(hidden.id);
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(await pending, { exited: true });
  assert.ok(Date.now() - started < 1_000, "cancel wakes the foreground wait");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(notices, [], "cancel does not send the completion notice");
  assert.deepEqual(quiet, [], "a hidden command has no cancellation notice");
  assert.equal(jobs.get(hidden.id).status, "cancelled");
});

test("discarding a cancelled hidden command keeps the SIGKILL escalation", async (t) => {
  const { dataDir, jobs } = await jobStore(t);
  const hidden = jobs.begin({
    command: 'trap "" TERM; echo ready; while :; do sleep 1; done',
    cwd: dataDir,
    origin: "bash",
  });
  const pid = hidden.pid;
  assert.ok(pid);
  t.after(() => {
    if (groupAlive(pid)) process.kill(-pid, "SIGKILL");
  });
  await until(async () => (await readFile(jobs.logPath(hidden.id), "utf8")).includes("ready"));
  jobs.cancel(hidden.id);
  assert.equal(jobs.get(hidden.id).status, "cancelled");
  await jobs.discard(hidden.id);
  assert.ok(liveGroup(pid).length > 0, "the command ignored SIGTERM and must still be alive");
  await until(
    () => liveGroup(pid).length === 0,
    10_000,
    "the process group to receive the escalation SIGKILL",
  );
});

test("a command still running at the handoff becomes a visible bash job", async (t) => {
  const { dataDir, jobs } = await jobStore(t);
  const tool = createTimedBashTool(jobs, { handoffMs: 100 });
  const started = Date.now();
  const { result } = await execute(tool, "echo started; sleep 30", dataDir);
  assert.ok(Date.now() - started < 2_000, "the tool returned at the handoff");
  assert.equal(result.isError, undefined);
  const jobId = result.structuredOutput?.jobId ?? "";
  assert.ok(jobId.length > 0);
  assert.match(result.structuredOutput?.output ?? "", /background job j\d+/);
  assert.match(result.diagnostics?.[0]?.message ?? "", /background job j\d+/);
  assert.equal(result.diagnostics?.[0]?.code, "bash_handoff");

  const job = jobs.list().find((item) => item.id === jobId);
  assert.ok(job);
  assert.equal(job.status, "running");
  assert.equal(job.origin, "bash");
  assert.equal(job.visible, true);

  const cancel = createJobTools(jobs).find((candidate) => candidate.name === "job_cancel");
  assert.ok(cancel);
  const cancelled = await (
    cancel as unknown as {
      execute(args: unknown, api: unknown): Promise<{ output: { text: string }[] }>;
    }
  ).execute({ id: jobId }, {});
  assert.match(cancelled.output[0]?.text ?? "", /cancelled/);
  await until(() => jobs.get(jobId).status === "cancelled");
});

test("an already-aborted signal hands off instead of killing the command", async (t) => {
  const { dataDir, jobs } = await jobStore(t);
  const tool = createTimedBashTool(jobs, { handoffMs: 10_000 });
  const controller = new AbortController();
  controller.abort();
  const { result } = await execute(tool, "sleep 30", dataDir, { signal: controller.signal });
  const jobId = result.structuredOutput?.jobId ?? "";
  assert.ok(jobId.length > 0);
  assert.match(result.structuredOutput?.output ?? "", /The run was stopped/);
  assert.equal(jobs.get(jobId).status, "running");
  assert.equal(jobs.get(jobId).visible, true);
  jobs.cancel(jobId);
  await until(() => jobs.get(jobId).status === "cancelled");
});

test("exactly one notice with the tail reaches the owner when the job ends", async (t) => {
  const { dataDir, jobs } = await jobStore(t);
  const notices: { job: JobRecord; tail: string }[] = [];
  jobs.setNotifier((job, tail) => notices.push({ job, tail }));
  const tool = createTimedBashTool(jobs, {
    handoffMs: 50,
    owner: { kind: "plan", taskId: "t1" },
  });
  const { result } = await execute(tool, "sleep 0.4; echo done-job", dataDir);
  const jobId = result.structuredOutput?.jobId ?? "";
  assert.ok(jobId.length > 0);
  await until(() => notices.length > 0);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.job.id, jobId);
  assert.equal(notices[0]?.job.owner.kind, "plan");
  assert.match(notices[0]?.tail ?? "", /done-job/);
  assert.match(describeJob(notices[0]?.job as JobRecord), /\(plan t1\)$/);
});

test("promoting a command that ended at the handoff still sends its notice", async (t) => {
  const { dataDir, jobs } = await jobStore(t);
  const notices: { job: JobRecord; tail: string }[] = [];
  jobs.setNotifier((job, tail) => notices.push({ job, tail }));
  const hidden = jobs.begin({ command: "echo race-over", cwd: dataDir, origin: "bash" });
  await until(() => jobs.get(hidden.id).status !== "running");
  assert.equal(notices.length, 0, "a hidden record is not announced");

  const promoted = jobs.promote(hidden.id);
  assert.equal(promoted.status, "exited");
  await until(() => notices.length > 0);
  assert.equal(notices.length, 1);
  assert.equal(notices[0]?.job.id, hidden.id);
  assert.match(notices[0]?.tail ?? "", /race-over/);
});

test("load promotes a hidden running record with a live pid", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-bash-adopt-"));
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  t.after(async () => {
    if (child.pid !== undefined) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
    await rm(dataDir, { recursive: true, force: true });
  });
  await mkdir(join(dataDir, "jobs"), { recursive: true });
  const job: JobRecord = {
    id: "j42",
    name: "sleep 30",
    command: "sleep 30",
    cwd: dataDir,
    pid: child.pid ?? null,
    status: "running",
    exitCode: null,
    signal: null,
    notify: false,
    origin: "bash",
    owner: { kind: "chat" },
    visible: false,
    startedAt: new Date().toISOString(),
    endedAt: null,
  };
  await writeFile(join(dataDir, "jobs", "jobs.json"), JSON.stringify({ jobs: [job] }));
  await writeFile(join(dataDir, "jobs", "j42.log"), "still running\n");

  const jobs = new JobManager(dataDir, dataDir);
  await jobs.load();
  const promoted = jobs.get("j42");
  assert.equal(promoted.visible, true);
  assert.equal(promoted.origin, "bash");
  assert.equal(promoted.notify, true);
  assert.equal(promoted.startedAt, job.startedAt, "promotion keeps the spawn time");
  jobs.cancel("j42");
  await jobs.flush();
});

test("load drops a hidden record whose pid is dead and deletes its log", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-bash-stale-"));
  t.after(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });
  await mkdir(join(dataDir, "jobs"), { recursive: true });
  const job: JobRecord = {
    id: "j43",
    name: "build",
    command: "make",
    cwd: dataDir,
    pid: 2 ** 22 + 54321,
    status: "running",
    exitCode: null,
    signal: null,
    notify: false,
    origin: "bash",
    owner: { kind: "chat" },
    visible: false,
    startedAt: new Date().toISOString(),
    endedAt: null,
  };
  await writeFile(join(dataDir, "jobs", "jobs.json"), JSON.stringify({ jobs: [job] }));
  const log = join(dataDir, "jobs", "j43.log");
  await writeFile(log, "stale\n");

  const jobs = new JobManager(dataDir, dataDir);
  await jobs.load();
  assert.throws(() => jobs.get("j43"), /Unknown job/);
  assert.equal(existsSync(log), false);
  await jobs.flush();
});

test("the handoff notice is one exported message", () => {
  assert.equal(BASH_HANDOFF_MS, 120_000);
  const running = bashHandoffNotice("j7");
  assert.match(running, /This command has run for 2 minutes and continues as background job j7\./);
  assert.match(running, /job_output id=j7, stop it with job_cancel id=j7/);
  assert.match(
    bashHandoffNotice("j7", { stopped: true }),
    /The run was stopped; this command continues as background job j7\./,
  );
});
