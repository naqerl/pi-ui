import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createJobTools } from "../src/server/job-tools.js";
import { JobManager, type JobRecord, jobNotice, tailLines } from "../src/server/jobs.js";

let dataDir: string;
let cwd: string;

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-jobs-data-"));
  cwd = await mkdtemp(join(tmpdir(), "pi-jobs-cwd-"));
});

after(async () => {
  await rm(dataDir, { recursive: true, force: true });
  await rm(cwd, { recursive: true, force: true });
});

function nextNotice(jobs: JobManager): Promise<{ job: JobRecord; tail: string }> {
  return new Promise((resolve) => {
    jobs.setNotifier((job, tail) => resolve({ job, tail }));
  });
}

async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("a job runs in the background and reports its end with the last output", async () => {
  const jobs = new JobManager(dataDir, cwd);
  await jobs.load();
  const notice = nextNotice(jobs);
  const job = jobs.start({ command: "pwd; for i in 1 2 3; do echo line $i; done; exit 3" });
  assert.equal(job.status, "running");
  const { job: ended, tail } = await notice;
  assert.equal(ended.id, job.id);
  assert.equal(ended.status, "failed");
  assert.equal(ended.exitCode, 3);
  assert.match(tail, /line 3/);
  assert.match(tail, new RegExp(cwd.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")));
  const text = jobNotice(ended, tail);
  assert.match(text, /background job j\d+ finished/);
  assert.match(text, /exited 3/);
});

test("output pages forward by offset and tails by lines", async () => {
  const jobs = new JobManager(dataDir, cwd);
  await jobs.load();
  const notice = nextNotice(jobs);
  const job = jobs.start({ command: "seq 1 500", name: "count" });
  await notice;
  const tail = await jobs.output(job.id, { tail: 3 });
  assert.equal(tail.text, "498\n499\n500\n");
  const first = await jobs.output(job.id, { offset: 0 });
  assert.ok(first.text.startsWith("1\n2\n"));
  assert.equal(first.next, first.size);
  const middle = await jobs.output(job.id, { offset: first.size - 4 });
  assert.equal(middle.text, "500\n");
});

test("cancel stops the job and its children, telling only the chat", async () => {
  const jobs = new JobManager(dataDir, cwd);
  await jobs.load();
  const notices: string[] = [];
  const quiet: { id: string; status: string; tail: string }[] = [];
  jobs.setNotifier((job) => notices.push(job.id));
  jobs.setQuietNotifier((job, tail) => quiet.push({ id: job.id, status: job.status, tail }));
  const job = jobs.start({ command: "sleep 30 & sleep 30; wait" });
  await new Promise((resolve) => setTimeout(resolve, 200));
  const cancelled = jobs.cancel(job.id);
  assert.equal(cancelled.status, "cancelled");
  const pid = job.pid ?? 0;
  await until(() => {
    try {
      process.kill(-pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(notices, []);
  assert.equal(jobs.get(job.id).status, "cancelled");
  await until(() => quiet.length > 0);
  assert.equal(quiet[0]?.id, job.id);
  assert.equal(quiet[0]?.status, "cancelled");
  assert.match(quiet[0]?.tail ?? "", /\[pi-ui\] cancelled/);
});

test("notify false stays quiet, and a restart keeps the list", async () => {
  const jobs = new JobManager(dataDir, cwd);
  await jobs.load();
  const notices: string[] = [];
  const quiet: string[] = [];
  jobs.setNotifier((job) => notices.push(job.id));
  jobs.setQuietNotifier((job) => quiet.push(job.id));
  const job = jobs.start({ command: "true", notify: false });
  await until(() => jobs.get(job.id).status !== "running");
  await jobs.flush();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(notices, []);
  await until(() => quiet.length > 0);
  assert.deepEqual(quiet, [job.id]);
  const reloaded = new JobManager(dataDir, cwd);
  await reloaded.load();
  assert.equal(reloaded.get(job.id).status, "exited");
  const next = reloaded.start({ command: "true", notify: false });
  assert.notEqual(next.id, job.id);
});

test("a job running when the server stopped is reported lost once its pid is gone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-jobs-lost-"));
  try {
    await mkdir(join(dir, "jobs"));
    await writeFile(
      join(dir, "jobs", "jobs.json"),
      JSON.stringify({
        jobs: [
          {
            id: "j7",
            name: "build",
            command: "make",
            cwd,
            pid: 2 ** 22 + 12345,
            status: "running",
            exitCode: null,
            signal: null,
            notify: true,
            startedAt: new Date().toISOString(),
            endedAt: null,
          },
        ],
      }),
    );
    const jobs = new JobManager(dir, cwd);
    await jobs.load();
    assert.equal(jobs.get("j7").status, "lost");
    const notice = nextNotice(jobs);
    const { job } = await notice;
    assert.equal(job.id, "j7");
    const extra = jobs.start({ command: "true", notify: false });
    assert.equal(extra.id, "j8");
    await until(() => jobs.get(extra.id).status !== "running");
    await jobs.flush();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the tools start, list, read and cancel jobs", async () => {
  const jobs = new JobManager(dataDir, cwd);
  await jobs.load();
  jobs.setNotifier(() => {});
  const tools = new Map(createJobTools(jobs).map((tool) => [tool.name, tool]));
  assert.deepEqual([...tools.keys()], ["job_start", "job_list", "job_output", "job_cancel"]);
  const run = async (name: string, args: Record<string, unknown>) => {
    const tool = tools.get(name);
    assert.ok(tool);
    const result = await (
      tool as unknown as {
        execute(args: unknown, context: unknown): Promise<{ output: { text: string }[] }>;
      }
    ).execute(args, {});
    return result.output[0]?.text ?? "";
  };
  const started = await run("job_start", { command: "echo hi; sleep 30", name: "napper" });
  const id = /Started (j\d+)/.exec(started)?.[1] ?? "";
  assert.ok(id.length > 0);
  assert.match(await run("job_list", {}), new RegExp(`${id} running for \\d+s: napper`));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.match(await run("job_output", { id }), /hi/);
  assert.match(await run("job_cancel", { id }), /cancelled/);
  assert.match(await run("job_output", { id: "nope" }), /Unknown job/);
});

test("tailLines keeps the last lines within the character cap", () => {
  assert.equal(tailLines("a\nb\nc\n", 2, 100), "b\nc\n");
  assert.equal(tailLines("abcdef", 5, 3), "def");
});
