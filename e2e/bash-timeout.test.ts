import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import {
  BASH_HANDOFF_MS,
  bashHandoffNotice,
  createTimedBashTool,
} from "../src/server/bash-tool.js";
import { createJobTools } from "../src/server/job-tools.js";
import { JobManager, type JobOwner, jobNotice } from "../src/server/jobs.js";

let cwd = "";

before(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pi-bash-timeout-cwd-"));
});

after(async () => {
  await rm(cwd, { recursive: true, force: true });
});

type Diagnostic = { severity: string; code?: string; message: string };

function fakeApi(limit = 20_000) {
  let text = "";
  let truncated = false;
  const chunks: string[] = [];
  const diagnostics: Diagnostic[] = [];
  return {
    env: { cwd },
    output(chunk: string) {
      chunks.push(chunk);
      text += chunk;
      if (text.length > limit) {
        text = text.slice(text.length - limit);
        truncated = true;
      }
    },
    retainedOutput() {
      return { text, truncated };
    },
    diagnostic(diagnostic: Diagnostic) {
      diagnostics.push(diagnostic);
    },
    chunks,
    diagnostics,
  };
}

async function store(t: { after: (fn: () => Promise<void>) => void }) {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-bash-timeout-data-"));
  const jobs = new JobManager(dataDir, cwd);
  await jobs.load();
  t.after(async () => {
    for (const job of jobs.list()) {
      if (job.status === "running") jobs.cancel(job.id);
    }
    await jobs.flush();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { dataDir, jobs };
}

async function run(
  tool: { execute: (...args: never[]) => Promise<Record<string, unknown>> },
  command: string,
  api: ReturnType<typeof fakeApi>,
  signal?: AbortSignal,
) {
  return tool.execute({ command } as never, api as never, { abortSignal: signal } as never);
}

async function until(check: () => boolean | Promise<boolean>, ms = 10_000, what = "condition") {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > ms) throw new Error(`${what} did not happen within ${ms}ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function cancelViaTool(jobs: JobManager, id: string): Promise<void> {
  const tool = createJobTools(jobs).find((candidate) => candidate.name === "job_cancel");
  assert.ok(tool);
  await tool.execute({ id } as never, {} as never, {} as never);
}

test("the default foreground window is 120 seconds", () => {
  assert.equal(BASH_HANDOFF_MS, 120_000);
});

test("a fast command returns its output, drops the job and removes the log", async (t) => {
  const { dataDir, jobs } = await store(t);
  const tool = createTimedBashTool(jobs, { handoffMs: 5_000 });
  const api = fakeApi();
  const result = await run(tool, "echo hi", api);
  const structured = result.structuredOutput as {
    output: string;
    exitCode: number;
    truncated: boolean;
  };
  assert.equal(structured.exitCode, 0);
  assert.match(structured.output, /hi/);
  assert.equal(result.isError, undefined);
  assert.deepEqual(jobs.list(), []);
  const files = await readdir(join(dataDir, "jobs"));
  assert.deepEqual(
    files.filter((file) => file.endsWith(".log")),
    [],
  );
});

test("truncated fast output keeps the full path it advertises", async (t) => {
  const { jobs } = await store(t);
  const tool = createTimedBashTool(jobs, { handoffMs: 5_000 });
  const api = fakeApi(100);
  const result = await run(tool, "seq 1 1000", api);
  const structured = result.structuredOutput as {
    truncated: boolean;
    fullOutputPath?: string;
    exitCode: number;
  };
  assert.equal(structured.exitCode, 0);
  assert.equal(structured.truncated, true);
  assert.ok(structured.fullOutputPath);
  const full = await readFile(structured.fullOutputPath, "utf8");
  assert.match(full, /1000/);
  assert.deepEqual(jobs.list(), [], "the hidden record is still dropped");
});

test("restarting never reuses a kept truncated log", async (t) => {
  const { dataDir, jobs } = await store(t);
  const tool = createTimedBashTool(jobs, { handoffMs: 5_000 });
  const first = await run(tool, "seq 1 1000", fakeApi(100));
  const firstOutput = first.structuredOutput as { fullOutputPath?: string };
  assert.ok(firstOutput.fullOutputPath);
  const keptPath = firstOutput.fullOutputPath;
  assert.equal(existsSync(keptPath), true);
  await jobs.flush();

  const indexPath = join(dataDir, "jobs", "jobs.json");
  const saved = JSON.parse(await readFile(indexPath, "utf8")) as {
    sequence?: number;
    jobs: unknown[];
  };
  assert.ok((saved.sequence ?? 0) >= 1, "the id high-water mark is persisted");
  delete saved.sequence;
  await writeFile(indexPath, JSON.stringify(saved));

  const reopened = new JobManager(dataDir, cwd);
  await reopened.load();
  const second = await run(
    createTimedBashTool(reopened, { handoffMs: 5_000 }),
    "echo NEW-OUTPUT",
    fakeApi(),
  );
  const secondOutput = second.structuredOutput as { output: string };
  assert.equal(secondOutput.output.trim(), "NEW-OUTPUT");
  assert.equal(existsSync(keptPath), true);
  assert.match(await readFile(keptPath, "utf8"), /1000/);
  assert.doesNotMatch(await readFile(keptPath, "utf8"), /NEW-OUTPUT/);
  const logs = (await readdir(join(dataDir, "jobs"))).filter((file) => file.endsWith(".log"));
  assert.deepEqual(
    logs,
    [keptPath.split("/").at(-1)],
    "the new fast command used a fresh id and dropped its own log",
  );
  await reopened.flush();
});

test("huge newline-less output is read as a bounded tail and kept in the log", async (t) => {
  const { jobs } = await store(t);
  const tool = createTimedBashTool(jobs, { handoffMs: 5_000 });
  const api = fakeApi(2_000);
  const started = Date.now();
  const result = await run(tool, "head -c 20000000 /dev/zero | tr '\\0' x", api);
  assert.ok(Date.now() - started < 3_000, "the final read is bounded, not the whole log");
  const structured = result.structuredOutput as {
    exitCode: number;
    truncated: boolean;
    fullOutputPath?: string;
  };
  assert.equal(structured.exitCode, 0);
  assert.equal(structured.truncated, true);
  assert.ok(structured.fullOutputPath);
  assert.equal((await stat(structured.fullOutputPath)).size, 20_000_000);
  assert.ok(
    api.chunks.join("").length < 1_000_000,
    "the foreground emits only a bounded tail, not the whole 20 MB",
  );
});

test("a continuously writing command hands off without chasing its log", async (t) => {
  const { jobs } = await store(t);
  const tool = createTimedBashTool(jobs, { handoffMs: 100 });
  const started = Date.now();
  const result = await run(tool, "yes x", fakeApi(2_000));
  assert.ok(Date.now() - started < 2_000, "the handoff does not wait for the writer to stop");
  const structured = result.structuredOutput as { jobId: string };
  assert.equal(jobs.get(structured.jobId).status, "running");
  await cancelViaTool(jobs, structured.jobId);
  assert.equal(jobs.get(structured.jobId).status, "cancelled");
});

test("abort hands off a continuously writing command", async (t) => {
  const { jobs } = await store(t);
  const tool = createTimedBashTool(jobs, { handoffMs: 5_000 });
  const api = fakeApi(2_000);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 50);
  const started = Date.now();
  const result = await run(tool, "yes y", api, controller.signal);
  assert.ok(Date.now() - started < 2_000, "abort returns instead of draining forever");
  const structured = result.structuredOutput as { jobId: string };
  assert.ok(api.chunks.join("").includes(bashHandoffNotice(structured.jobId, true)));
  assert.equal(jobs.get(structured.jobId).status, "running");
  await cancelViaTool(jobs, structured.jobId);
  assert.equal(jobs.get(structured.jobId).status, "cancelled");
});

test("a nonzero exit keeps the usual error result", async (t) => {
  const { jobs } = await store(t);
  const tool = createTimedBashTool(jobs, { handoffMs: 5_000 });
  const api = fakeApi();
  const result = await run(tool, "exit 3", api);
  const structured = result.structuredOutput as { exitCode: number };
  assert.equal(structured.exitCode, 3);
  assert.equal(result.isError, true);
  const diagnostics = (result.diagnostics ?? []) as Diagnostic[];
  assert.ok(diagnostics.some((item) => item.code === "exit_code"));
  assert.deepEqual(jobs.list(), []);
});

test("a command still running at the window becomes a listed job", async (t) => {
  const { jobs } = await store(t);
  const tool = createTimedBashTool(jobs, { handoffMs: 100 });
  const api = fakeApi();
  const started = Date.now();
  const result = await run(tool, "sleep 1", api);
  assert.ok(Date.now() - started < 1_000, "the tool returns at the handoff, not at exit");
  assert.equal(result.isError, false);
  const structured = result.structuredOutput as { jobId: string; exitCode: null };
  assert.match(structured.jobId, /^j\d+$/);
  assert.equal(structured.exitCode, null);
  const notice = bashHandoffNotice(structured.jobId);
  assert.ok(api.chunks.join("").includes(notice));
  const diagnostics = (result.diagnostics ?? []) as Diagnostic[];
  assert.ok(diagnostics.some((item) => item.code === "bash_handoff"));
  const job = jobs.get(structured.jobId);
  assert.equal(job.origin, "bash");
  assert.equal(job.visible, true);
  assert.equal(job.status, "running");
  assert.deepEqual(
    jobs.list().map((item) => item.id),
    [structured.jobId],
  );
  await cancelViaTool(jobs, structured.jobId);
  assert.equal(jobs.get(structured.jobId).status, "cancelled");
});

test("an already-aborted turn hands the command off instead of killing it", async (t) => {
  const { jobs } = await store(t);
  const tool = createTimedBashTool(jobs, { handoffMs: 5_000 });
  const api = fakeApi();
  const controller = new AbortController();
  controller.abort();
  const result = await run(tool, "sleep 1", api, controller.signal);
  const structured = result.structuredOutput as { jobId: string };
  const notice = bashHandoffNotice(structured.jobId, true);
  assert.ok(api.chunks.join("").includes(notice));
  assert.match(notice, /The run was stopped; this command continues as background job/);
  assert.equal(jobs.get(structured.jobId).status, "running");
  assert.deepEqual(
    jobs.list().map((item) => item.id),
    [structured.jobId],
  );
  await cancelViaTool(jobs, structured.jobId);
  assert.equal(jobs.get(structured.jobId).status, "cancelled");
});

test("a promoted job reports once to the route that owns it", async (t) => {
  const { jobs } = await store(t);
  const routes: Record<
    "chat" | "plan" | "delegate",
    Array<{ id: string; text: string; ownerId?: string }>
  > = {
    chat: [],
    plan: [],
    delegate: [],
  };
  jobs.setNotifier((job, tail) => {
    const text = jobNotice(job, tail);
    if (job.owner.kind === "plan") {
      routes.plan.push({ id: job.id, text, ownerId: job.owner.taskId });
    } else if (job.owner.kind === "delegate") {
      routes.delegate.push({ id: job.id, text, ownerId: job.owner.runId });
    } else {
      routes.chat.push({ id: job.id, text });
    }
  });
  const chatTool = createTimedBashTool(jobs, { handoffMs: 100 });
  const planOwner: JobOwner = { kind: "plan", taskId: "task-42" };
  const planTool = createTimedBashTool(jobs, { handoffMs: 100, owner: planOwner });
  const delegateOwner: JobOwner = { kind: "delegate", runId: "del_42" };
  const delegateTool = createTimedBashTool(jobs, { handoffMs: 100, owner: delegateOwner });
  const chatResult = await run(chatTool, "echo chat-tail; sleep 1", fakeApi());
  const planResult = await run(planTool, "echo plan-tail; sleep 1", fakeApi());
  const delegateResult = await run(delegateTool, "echo delegate-tail; sleep 1", fakeApi());
  const chatId = (chatResult.structuredOutput as { jobId: string }).jobId;
  const planId = (planResult.structuredOutput as { jobId: string }).jobId;
  const delegateId = (delegateResult.structuredOutput as { jobId: string }).jobId;
  await until(
    () => routes.chat.length === 1 && routes.plan.length === 1 && routes.delegate.length === 1,
  );
  await sleep(300);
  assert.equal(routes.chat.length, 1, "exactly one chat notice");
  assert.equal(routes.plan.length, 1, "exactly one plan notice");
  assert.equal(routes.delegate.length, 1, "exactly one delegate notice");
  assert.equal(routes.chat[0]?.id, chatId);
  assert.equal(routes.plan[0]?.id, planId);
  assert.equal(routes.delegate[0]?.id, delegateId);
  assert.equal(routes.plan[0]?.ownerId, "task-42");
  assert.equal(routes.delegate[0]?.ownerId, "del_42");
  assert.match(routes.chat[0]?.text ?? "", /chat-tail/);
  assert.match(routes.plan[0]?.text ?? "", /plan-tail/);
  assert.match(routes.delegate[0]?.text ?? "", /delegate-tail/);
});

test("a delegate handoff names, lists and cancels the same job", async (t) => {
  const { jobs } = await store(t);
  const owner: JobOwner = { kind: "delegate", runId: "del_accept" };
  const tool = createTimedBashTool(jobs, { handoffMs: 100, owner });
  const result = await run(tool, "sleep 1", fakeApi());
  const structured = result.structuredOutput as { jobId: string; exitCode: null };
  assert.match(structured.jobId, /^j\d+$/);
  assert.equal(structured.exitCode, null);
  const job = jobs.get(structured.jobId);
  assert.deepEqual(job.owner, owner);
  assert.equal(job.origin, "bash");
  assert.equal(job.visible, true);
  assert.deepEqual(
    jobs.list().map((item) => item.id),
    [structured.jobId],
  );
  await cancelViaTool(jobs, structured.jobId);
  assert.equal(jobs.get(structured.jobId).status, "cancelled");
});

test("load adopts a hidden live command and drops one whose pid is gone", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-bash-timeout-load-"));
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  child.unref();
  t.after(async () => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {}
    await rm(dataDir, { recursive: true, force: true });
  });
  await mkdir(join(dataDir, "jobs"), { recursive: true });
  const startedAt = new Date().toISOString();
  const base = {
    name: "hidden",
    command: "sleep 30",
    cwd,
    status: "running",
    exitCode: null,
    signal: null,
    notify: true,
    origin: "bash",
    owner: { kind: "chat" },
    visible: false,
    startedAt,
    endedAt: null,
  };
  await writeFile(
    join(dataDir, "jobs", "jobs.json"),
    JSON.stringify({
      jobs: [
        { ...base, id: "j4", pid: child.pid ?? null },
        { ...base, id: "j5", pid: 2 ** 22 + 12345 },
      ],
    }),
  );
  await writeFile(join(dataDir, "jobs", "j4.log"), "still here\n");
  await writeFile(join(dataDir, "jobs", "j5.log"), "gone\n");

  const jobs = new JobManager(dataDir, cwd);
  await jobs.load();
  const live = jobs.get("j4");
  assert.equal(live.visible, true);
  assert.equal(live.origin, "bash");
  assert.equal(live.notify, true);
  assert.deepEqual(
    jobs.list().map((job) => job.id),
    ["j4"],
  );
  assert.equal(existsSync(join(dataDir, "jobs", "j4.log")), true);
  assert.equal(existsSync(join(dataDir, "jobs", "j5.log")), false);
  assert.throws(() => jobs.get("j5"), /Unknown job/);
  jobs.cancel("j4");
  await jobs.flush();
});
