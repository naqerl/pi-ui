import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { ToolExecutionResult, ToolPark, ToolRegistration } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createReadTool } from "@earendil-works/pi-durable/tools";
import { createJobTools } from "../src/server/job-tools.js";
import { JobManager, type JobRecord, jobNotice, tailLines } from "../src/server/jobs.js";

let cwd: string;

before(async () => {
  cwd = await mkdtemp(join(tmpdir(), "pi-jobs-cwd-"));
});

after(async () => {
  await rm(cwd, { recursive: true, force: true });
});

/**
 * A fresh job directory per test, plus a cleanup hook that cancels and awaits any job the test
 * left running before the directory is removed. No job may cross into the next test.
 */
async function jobStore(t: { after: (fn: () => Promise<void>) => void }): Promise<{
  dataDir: string;
  track: (jobs: JobManager) => JobManager;
}> {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-jobs-data-"));
  const managers: JobManager[] = [];
  t.after(async () => {
    for (const jobs of managers) {
      for (const job of jobs.list()) {
        if (job.status !== "running") continue;
        const pid = job.pid;
        jobs.cancel(job.id);
        if (pid !== null) {
          await waitForGroup(
            pid,
            (live) => live.length === 0,
            `process group ${pid} to exit`,
          ).catch(() => undefined);
        }
      }
    }
    await Promise.all(managers.map((jobs) => jobs.flush()));
    await rm(dataDir, { recursive: true, force: true });
  });
  return {
    dataDir,
    track: (jobs) => {
      managers.push(jobs);
      return jobs;
    },
  };
}

function nextNotice(jobs: JobManager): Promise<{ job: JobRecord; tail: string }> {
  return new Promise((resolve) => {
    jobs.setNotifier((job, tail) => resolve({ job, tail }));
  });
}

function jobToolMap(jobs: JobManager): Map<string, ToolRegistration> {
  return new Map(createJobTools(jobs).map((tool) => [tool.name, tool]));
}

type ToolResult = ToolExecutionResult | ToolPark;

async function runJobTool(
  tools: Map<string, ToolRegistration>,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = tools.get(name);
  assert.ok(tool);
  const api = { env: new NodeExecutionEnv({ cwd }) };
  return tool.execute(args as never, api as never, {} as never);
}

function resultText(result: ToolResult): string {
  return (result.output ?? [])
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("\n");
}

function diagnosticText(result: ToolResult): string {
  return (result.diagnostics ?? []).map((diagnostic) => diagnostic.message).join("\n");
}

const GROUP_WAIT_MS = 20_000;

function processGroup(pid: number): string[] {
  const result = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,cmd="], {
    encoding: "utf8",
  });
  if (result.error !== undefined) throw result.error;
  return (result.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && Number.parseInt(line.split(/\s+/)[2] ?? "", 10) === pid);
}

function isLiveProcess(line: string): boolean {
  const state = line.split(/\s+/)[3] ?? "";
  // Zombies (Z) and dead (X) processes are no longer running. An isolated test
  // container may not reap them, so they can remain listed in the group forever.
  return !/^[ZX]/.test(state);
}

async function waitForGroup(
  pid: number,
  ready: (live: string[]) => boolean,
  what: string,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    const members = processGroup(pid);
    const live = members.filter(isLiveProcess);
    if (ready(live)) return;
    const elapsed = Date.now() - started;
    if (elapsed >= GROUP_WAIT_MS) {
      throw new Error(
        `${what} did not happen within ${elapsed}ms; process group ${pid} had ${live.length} live process(es)\n` +
          `ps -A -o pid,ppid,pgid,stat,cmd for PGID ${pid}:\n${members.join("\n") || "(none)"}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function until(
  check: () => boolean | Promise<boolean>,
  ms = 5000,
  what = "condition",
): Promise<void> {
  const started = Date.now();
  const end = started + ms;
  while (!(await check())) {
    if (Date.now() > end) {
      throw new Error(`${what} did not happen within ${Date.now() - started}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("a job runs in the background and reports its end with the last output", async (t) => {
  const { dataDir, track } = await jobStore(t);
  const jobs = track(new JobManager(dataDir, cwd));
  await jobs.load();
  const notice = nextNotice(jobs);
  const job = jobs.start({ command: "pwd; for i in 1 2 3; do echo line $i; done; exit 3" });
  assert.equal(job.status, "running");
  const { job: ended, tail } = await notice;
  assert.equal(ended.id, job.id);
  assert.equal(ended.status, "failed");
  assert.equal(ended.exitCode, 3);
  assert.match(tail, /line 3/);
  const printedCwd = realpathSync(cwd);
  assert.match(tail, new RegExp(printedCwd.replace(/[/\\^$*+?.()|[\]{}]/g, "\\$&")));
  const text = jobNotice(ended, tail);
  assert.match(text, /background job j\d+ finished/);
  assert.match(text, /exited 3/);
});

test("output pages forward by offset and tails by lines", async (t) => {
  const { dataDir, track } = await jobStore(t);
  const jobs = track(new JobManager(dataDir, cwd));
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

test("cancel stops the job and its children, telling only the chat", async (t) => {
  const { dataDir, track } = await jobStore(t);
  const jobs = track(new JobManager(dataDir, cwd));
  await jobs.load();
  const notices: string[] = [];
  const quiet: { id: string; status: string; tail: string }[] = [];
  jobs.setNotifier((job) => notices.push(job.id));
  jobs.setQuietNotifier((job, tail) => quiet.push({ id: job.id, status: job.status, tail }));
  const job = jobs.start({ command: "sleep 30 & sleep 30; wait" });
  await until(
    () => jobs.get(job.id).status === "running" && jobs.get(job.id).pid !== null,
    30_000,
    `job ${job.id} to be running with a pid`,
  );
  const pid = jobs.get(job.id).pid;
  assert.ok(pid !== null);
  await waitForGroup(pid, (live) => live.length >= 2, `job ${job.id}'s children to start`);
  const cancelled = jobs.cancel(job.id);
  assert.equal(cancelled.status, "cancelled");
  await until(
    () => jobs.get(job.id).status === "cancelled",
    30_000,
    `job ${job.id} to be marked cancelled`,
  );
  await waitForGroup(pid, (live) => live.length === 0, `process group ${pid} to exit`);
  await until(() => quiet.length > 0, 30_000, `the quiet notice for ${job.id}`);
  assert.deepEqual(notices, []);
  assert.equal(jobs.get(job.id).status, "cancelled");
  assert.equal(quiet.length, 1);
  assert.equal(quiet[0]?.id, job.id);
  assert.equal(quiet[0]?.status, "cancelled");
  assert.match(quiet[0]?.tail ?? "", /\[pi-ui\] cancelled/);
});

test("notify false stays quiet, and a restart keeps the list", async (t) => {
  const { dataDir, track } = await jobStore(t);
  const jobs = track(new JobManager(dataDir, cwd));
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
  const reloaded = track(new JobManager(dataDir, cwd));
  await reloaded.load();
  assert.equal(reloaded.get(job.id).status, "exited");
  const next = reloaded.start({ command: "true", notify: false });
  assert.notEqual(next.id, job.id);
  await until(() => reloaded.get(next.id).status !== "running");
  await reloaded.flush();
});

test("two managers on one directory save the same index at once", async (t) => {
  const { dataDir, track } = await jobStore(t);
  const first = track(new JobManager(dataDir, cwd));
  await first.load();
  const j1 = first.start({ command: "true", notify: false });
  await until(() => first.get(j1.id).status !== "running");
  await first.flush();

  const second = track(new JobManager(dataDir, cwd));
  await second.load();
  const j2 = second.start({ command: "true", notify: false });
  await until(() => second.get(j2.id).status !== "running");
  await second.flush();

  await first.load();
  assert.deepEqual(
    first.list().map((job) => job.id),
    [j1.id, j2.id],
    "the first manager adopted the second manager's saved job",
  );

  // A saved running job whose pid is gone makes both managers finish and save the
  // same full list at once: the shared temp-file collision this case covers.
  const stamp = new Date().toISOString();
  await writeFile(
    join(dataDir, "jobs", "jobs.json"),
    JSON.stringify({
      jobs: [
        ...first.list().map((job) => ({ ...job })),
        {
          id: "j3",
          name: "stale",
          command: "make",
          cwd,
          pid: 2 ** 22 + 12345,
          status: "running",
          exitCode: null,
          signal: null,
          notify: false,
          startedAt: stamp,
          endedAt: null,
        },
      ],
    }),
  );

  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  try {
    await Promise.all([first.load(), second.load()]);
    await Promise.all([first.flush(), second.flush()]);
  } finally {
    console.error = original;
  }
  assert.deepEqual(
    errors.filter((line) => line.includes("could not save the job list")),
    [],
    "neither manager loses its save",
  );

  const fresh = track(new JobManager(dataDir, cwd));
  await fresh.load();
  assert.deepEqual(
    fresh.list().map((job) => job.id),
    [j1.id, j2.id, "j3"],
  );
  assert.equal(fresh.get("j3").status, "lost");
});

test("a job running when the server stopped is reported lost once its pid is gone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-jobs-lost-"));
  try {
    await mkdir(join(dir, "jobs"));
    await writeFile(join(dir, "jobs", "j7.log"), "restored\n");
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
    assert.equal(
      resultText(
        await runJobTool(jobToolMap(jobs), "job_output", {
          id: "j7",
        }),
      ),
      "restored\n",
    );
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

test("the tools start, list, read and cancel jobs", async (t) => {
  const { dataDir, track } = await jobStore(t);
  const jobs = track(new JobManager(dataDir, cwd));
  await jobs.load();
  jobs.setNotifier(() => {});
  const tools = jobToolMap(jobs);
  assert.deepEqual([...tools.keys()], ["job_start", "job_list", "job_output", "job_cancel"]);
  const run = async (name: string, args: Record<string, unknown>) =>
    resultText(await runJobTool(tools, name, args));
  const started = await run("job_start", { command: "echo hi; sleep 30", name: "napper" });
  const id = /Started (j\d+)/.exec(started)?.[1] ?? "";
  assert.ok(id.length > 0);
  assert.match(await run("job_list", {}), new RegExp(`${id} running for \\d+s: napper`));
  let output = "";
  await until(
    async () => {
      output = await run("job_output", { id });
      return /hi/.test(output);
    },
    10_000,
    `job_output for ${id} to contain "hi"`,
  );
  assert.match(output, /hi/);
  const pid = jobs.get(id).pid;
  assert.ok(pid !== null);
  assert.match(await run("job_cancel", { id }), /cancelled/);
  await waitForGroup(pid, (live) => live.length === 0, `process group ${pid} to exit`);
  await jobs.flush();
  assert.match(await run("job_output", { id: "nope" }), /Unknown job/);
});

test("job_output reads lines like read and reports empty, unknown and past-end jobs", async (t) => {
  const { dataDir, track } = await jobStore(t);
  const jobs = track(new JobManager(dataDir, cwd));
  await jobs.load();
  const tools = jobToolMap(jobs);
  const notice = nextNotice(jobs);
  const job = jobs.start({ command: "printf 'a\\nb\\nc\\nd\\ne\\n'", name: "lines" });
  await notice;

  const api = { env: new NodeExecutionEnv({ cwd }) };
  const viaJob = await runJobTool(tools, "job_output", { id: job.id, offset: 2, limit: 2 });
  const viaRead = await createReadTool().execute(
    { path: jobs.logPath(job.id), offset: 2, limit: 2 } as never,
    api as never,
    {} as never,
  );
  assert.equal(resultText(viaJob), "b\nc");
  assert.equal(resultText(viaJob), resultText(viaRead));
  assert.equal(viaJob.structuredOutput, viaRead.structuredOutput);

  const emptyJob = jobs.start({ command: "true", notify: false });
  await until(() => jobs.get(emptyJob.id).status !== "running");
  const empty = await runJobTool(tools, "job_output", { id: emptyJob.id });
  assert.notEqual(empty.isError, true);
  assert.equal(resultText(empty), `Job ${emptyJob.id} has no output yet.`);

  const unknown = await runJobTool(tools, "job_output", { id: "nope" });
  assert.equal(unknown.isError, true);
  assert.match(resultText(unknown), /Unknown job nope/);

  const beyond = await runJobTool(tools, "job_output", { id: emptyJob.id, offset: 999 });
  assert.equal(beyond.isError, true);
  assert.match(
    resultText(beyond),
    new RegExp(`Job ${emptyJob.id}: Offset 999 is beyond end of file \\(1 lines total\\)`),
  );
  await jobs.flush();
});

test("job_output pages a long log with the read continuation diagnostic", async (t) => {
  const { dataDir, track } = await jobStore(t);
  const jobs = track(new JobManager(dataDir, cwd));
  await jobs.load();
  const job = jobs.start({ command: "seq 1 5000", notify: false });
  await until(() => jobs.get(job.id).status !== "running", 30_000, `job ${job.id} to finish`);
  const tools = jobToolMap(jobs);

  const pages: string[] = [];
  let offset: number | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await runJobTool(tools, "job_output", {
      id: job.id,
      ...(offset === undefined ? {} : { offset }),
    });
    pages.push(resultText(result));
    if (page === 0) {
      assert.match(pages[0] ?? "", /^1\n2\n/);
      assert.doesNotMatch(pages[0] ?? "", /\n2001\n/);
      assert.match(diagnosticText(result), /Use offset=\d+ to continue/);
    }
    const next = /Use offset=(\d+) to continue/.exec(diagnosticText(result));
    if (next === null) break;
    offset = Number(next[1]);
  }

  assert.ok(pages.length >= 3, "the log takes more than one read page");
  assert.match(pages.at(-1) ?? "", /5000\n$/);
  const joined = pages.reduce((all, page, index) => (index === 0 ? page : `${all}\n${page}`), "");
  assert.equal(joined, await readFile(jobs.logPath(job.id), "utf8"));
});

test("job_output reads a growing log, then the same log after exit", async (t) => {
  const { dataDir, track } = await jobStore(t);
  const jobs = track(new JobManager(dataDir, cwd));
  const marker = join(dataDir, "continue");
  await jobs.load();
  const notice = nextNotice(jobs);
  const job = jobs.start({
    command: `printf 'one\\n'; while [ ! -f '${marker}' ]; do sleep 0.05; done; printf 'two\\n'`,
    notify: true,
  });
  const tools = jobToolMap(jobs);

  let early = "";
  await until(
    async () => {
      early = resultText(await runJobTool(tools, "job_output", { id: job.id }));
      return /one/.test(early);
    },
    10_000,
    `job ${job.id} to print its first line`,
  );
  assert.equal(jobs.get(job.id).status, "running");
  assert.doesNotMatch(early, /two/);

  await writeFile(marker, "continue\n");
  await notice;
  const final = resultText(await runJobTool(tools, "job_output", { id: job.id }));
  assert.match(final, /one/);
  assert.match(final, /two/);
  await jobs.flush();
});

test("the job_start limit counts only jobs started by job_start", async (t) => {
  const { dataDir, track } = await jobStore(t);
  const jobs = track(new JobManager(dataDir, cwd));
  await jobs.load();
  const handedOff: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    const job = jobs.begin({ command: "sleep 30", origin: "bash", notify: false });
    handedOff.push(jobs.promote(job.id, { notify: false }).id);
  }
  const normal = jobs.start({ command: "true", notify: false });
  await until(() => jobs.get(normal.id).status !== "running");
  for (const id of handedOff) jobs.cancel(id);

  const started: string[] = [];
  for (let index = 0; index < 8; index += 1) {
    started.push(jobs.start({ command: "sleep 30", notify: false }).id);
  }
  assert.throws(
    () => jobs.start({ command: "sleep 30", notify: false }),
    /8 jobs are already running; the limit is 8/,
  );
  for (const id of started) jobs.cancel(id);
  await jobs.flush();
});

test("promotions share the one orphan watcher already running", async (t) => {
  const { dataDir, track } = await jobStore(t);
  const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
  child.unref();
  try {
    await mkdir(join(dataDir, "jobs"), { recursive: true });
    await writeFile(
      join(dataDir, "jobs", "jobs.json"),
      JSON.stringify({
        jobs: [
          {
            id: "j1",
            name: "adopted",
            command: "sleep 30",
            cwd,
            pid: child.pid ?? null,
            status: "running",
            exitCode: null,
            signal: null,
            notify: true,
            origin: "bash",
            owner: { kind: "chat" },
            visible: true,
            startedAt: new Date().toISOString(),
            endedAt: null,
          },
        ],
      }),
    );
    const jobs = track(new JobManager(dataDir, cwd));
    await jobs.load();
    const watcher = (jobs as unknown as { orphanTimer?: NodeJS.Timeout }).orphanTimer;
    assert.ok(watcher, "loading an orphan starts its watcher");
    for (let index = 0; index < 3; index += 1) {
      const job = jobs.begin({ command: "true", notify: false });
      jobs.promote(job.id, { notify: false });
      await until(() => jobs.get(job.id).status !== "running");
    }
    assert.equal(
      (jobs as unknown as { orphanTimer?: NodeJS.Timeout }).orphanTimer,
      watcher,
      "promoting another job must not replace the watcher",
    );
    jobs.cancel("j1");
    await jobs.flush();
  } finally {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  }
});

test("tailLines keeps the last lines within the character cap", () => {
  assert.equal(tailLines("a\nb\nc\n", 2, 100), "b\nc\n");
  assert.equal(tailLines("abcdef", 5, 3), "def");
});
