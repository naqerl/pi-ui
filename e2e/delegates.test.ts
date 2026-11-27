import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  activeSubagents,
  BackgroundJobsCounts,
  BackgroundJobsSheet,
} from "../src/client/BackgroundJobs.js";
import { createAcpDelegateTools } from "../src/server/delegate-tools.js";
import {
  DELEGATE_RESTART_ERROR,
  DELEGATE_TOOLS,
  DelegateManager,
  type DelegateSession,
  type DelegateTurnResult,
  MAX_IDLE_DELEGATES,
} from "../src/server/delegates.js";
import { parseNotice } from "../src/shared/notices.js";
import type { DelegateRunView } from "../src/shared/types.js";

const models = {} as ModelRuntime;

interface Harness {
  readonly manager: DelegateManager;
  readonly chips: string[];
  /** Job notices delivered into an open sub-agent turn. */
  readonly jobNotices: string[];
  finish(id: string, result: DelegateTurnResult): void;
  /** Resolves with the prompt once that run's current turn has started. */
  submitted(id: string): Promise<string>;
}

async function harness(dir: string): Promise<Harness> {
  const finishes = new Map<string, (result: DelegateTurnResult) => void>();
  const prompts = new Map<string, string>();
  const waiters = new Map<string, (prompt: string) => void>();
  const jobNotices: string[] = [];
  const manager = new DelegateManager({
    dataDir: dir,
    cwd: dir,
    models,
    model: undefined,
    openSession: (run) => {
      let cancelPending = false;
      const session: DelegateSession = {
        submit(prompt: string) {
          const waiter = waiters.get(run.id);
          if (waiter === undefined) prompts.set(run.id, prompt);
          else {
            waiters.delete(run.id);
            waiter(prompt);
          }
          return new Promise((resolve) => {
            if (cancelPending) {
              cancelPending = false;
              resolve({ text: "", cancelled: true, error: "Cancelled by the parent." });
              return;
            }
            finishes.set(run.id, resolve);
          });
        },
        async submitNotice(text: string) {
          jobNotices.push(text);
        },
        abort() {
          const resolve = finishes.get(run.id);
          if (resolve === undefined) {
            cancelPending = true;
            return;
          }
          finishes.delete(run.id);
          resolve({ text: "", cancelled: true, error: "Cancelled by the parent." });
        },
        async close() {},
      };
      return Promise.resolve(session);
    },
  });
  const chips: string[] = [];
  manager.setNotifier((text) => {
    chips.push(text);
  });
  return {
    manager,
    chips,
    jobNotices,
    finish(id, result) {
      const resolve = finishes.get(id);
      if (resolve === undefined) throw new Error(`sub-agent ${id} is not in a turn`);
      finishes.delete(id);
      resolve(result);
    },
    submitted(id) {
      const prompt = prompts.get(id);
      if (prompt !== undefined) {
        prompts.delete(id);
        return Promise.resolve(prompt);
      }
      return new Promise((resolve) => {
        waiters.set(id, resolve);
      });
    },
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a sub-agent");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function view(overrides: Partial<DelegateRunView> = {}): DelegateRunView {
  return {
    id: "del_1",
    agent: "subagent",
    task: "edit sshd_config",
    taskFirstLine: "edit sshd_config",
    cwd: "/tmp",
    status: "running",
    queuedAt: "2026-11-16T00:00:00.000Z",
    startedAt: "2026-11-16T00:00:01.000Z",
    endedAt: null,
    durationMs: 1_000,
    duration: "1s",
    resultPath: "/tmp/del_1.out",
    activityPath: "/tmp/del_1.activity",
    resultUrl: "/api/delegates/del_1/result",
    activityUrl: "/api/delegates/del_1/activity",
    ...overrides,
  };
}

const toolApi = {} as ToolExecutionApi;

async function cleanup(manager: DelegateManager | undefined, dir: string): Promise<void> {
  await manager?.shutdown();
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
}

test("acp_delegate returns while the sub-agent is still working", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ui-delegate-"));
  let manager: DelegateManager | undefined;
  try {
    const box = await harness(dir);
    manager = box.manager;
    const tools = createAcpDelegateTools(box.manager);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["acp_delegate", "acp_delegate_continue", "acp_delegate_cancel"],
    );
    const started = tools[0]?.execute({ prompt: "edit sshd_config" }, toolApi, BACKGROUND_CONTEXT);
    const result = await started;
    const body = (result?.output ?? [])
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n");
    const run = box.manager.list()[0];
    assert.ok(run !== undefined);
    assert.match(body, new RegExp(run.id));
    assert.match(body, /Do not poll or wait/);
    assert.doesNotMatch(body, /acp_delegate_wait/);
    assert.equal(run.status, "running");
    assert.equal(activeSubagents(box.manager.list()).length, 1);
    await box.submitted(run.id);

    box.finish(run.id, { text: "sshd_config now allows the group" });
    await waitFor(() => box.manager.get(run.id).status === "idle");
    assert.equal(activeSubagents(box.manager.list()).length, 0);
    assert.equal(box.manager.get(run.id).lastOutcome, "completed");
  } finally {
    await cleanup(manager, dir);
  }
});

test("a delegate exposes the job tools and keeps a handed-off command cancellable", () => {
  assert.deepEqual(
    DELEGATE_TOOLS.filter((name) => name.startsWith("job_")),
    ["job_list", "job_output", "job_cancel"],
  );
  assert.equal(DELEGATE_TOOLS.includes("bash"), true);
  assert.equal(DELEGATE_TOOLS.includes("job_start" as never), false);
});

test("a job notice reaches an open turn without starting another", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ui-delegate-"));
  let manager: DelegateManager | undefined;
  try {
    const box = await harness(dir);
    manager = box.manager;
    const run = await box.manager.start({ prompt: "run the build" });
    await box.submitted(run.id);

    assert.equal(await box.manager.submitJobNotice(run.id, "job j1 finished"), true);
    assert.deepEqual(box.jobNotices, ["job j1 finished"]);
    assert.equal(box.manager.get(run.id).status, "running");
    assert.equal(box.chips.length, 0, "a notice does not finish the turn");

    box.finish(run.id, { text: "build done" });
    await waitFor(() => box.manager.get(run.id).status === "idle");
    assert.equal(box.chips.length, 1, "only the finished turn chips");
  } finally {
    await cleanup(manager, dir);
  }
});

test("a finished turn is not idle until its chip is recorded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ui-delegate-"));
  let manager: DelegateManager | undefined;
  try {
    const box = await harness(dir);
    manager = box.manager;
    let waiting = false;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    box.manager.setNotifier(async (text) => {
      waiting = true;
      await held;
      box.chips.push(text);
    });
    const run = await box.manager.start({ prompt: "run the build" });
    await box.submitted(run.id);

    box.finish(run.id, { text: "build done" });
    await waitFor(() => waiting);
    assert.equal(box.chips.length, 0);
    assert.equal(box.manager.get(run.id).status, "running", "a run with no chip is not idle");
    await assert.rejects(() => box.manager.continue(run.id, "again"), /finishing/);

    release();
    await waitFor(() => box.manager.get(run.id).status === "idle");
    assert.equal(box.chips.length, 1);
  } finally {
    await cleanup(manager, dir);
  }
});

test("a job notice falls back to the parent when the run is not open", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ui-delegate-"));
  let manager: DelegateManager | undefined;
  try {
    const box = await harness(dir);
    manager = box.manager;
    const run = await box.manager.start({ prompt: "run the build" });
    await box.submitted(run.id);
    box.finish(run.id, { text: "build done" });
    await waitFor(() => box.manager.get(run.id).status === "idle");
    assert.equal(await box.manager.submitJobNotice(run.id, "late job"), false);
    assert.deepEqual(box.jobNotices, []);
    assert.equal(await box.manager.submitJobNotice("del_missing", "late job"), false);
  } finally {
    await cleanup(manager, dir);
  }
});

test("continue resumes the same sub-agent and refuses a second prompt while it works", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ui-delegate-"));
  let manager: DelegateManager | undefined;
  try {
    const box = await harness(dir);
    manager = box.manager;
    const run = await box.manager.start({ prompt: "write the unit file" });
    await box.submitted(run.id);
    box.finish(run.id, { text: "wrote app.service" });
    await waitFor(() => box.chips.length === 1);
    assert.match(box.chips[0] ?? "", /acp_delegate_continue/);
    assert.match(box.chips[0] ?? "", /wrote app\.service/);
    assert.doesNotMatch(box.chips[0] ?? "", /continue your original task/);
    const notice = parseNotice(box.chips[0] ?? "");
    assert.equal(notice?.kind, "delegate");
    if (notice?.kind === "delegate") {
      assert.equal(notice.runId, run.id);
      assert.equal(notice.status, "completed");
      assert.equal(notice.excerpt, "wrote app.service");
    }

    const again = await box.manager.continue(run.id, "reload the unit");
    assert.equal(again.id, run.id);
    await waitFor(() => box.manager.get(run.id).status === "running");
    assert.equal(activeSubagents(box.manager.list()).length, 1);
    await assert.rejects(() => box.manager.continue(run.id, "again"), /still running/);
    await box.submitted(run.id);
    box.finish(run.id, { text: "reloaded" });
    await waitFor(() => box.chips.length === 2);
    assert.equal(box.manager.get(run.id).status, "idle");
    assert.equal(activeSubagents(box.manager.list()).length, 0);
  } finally {
    await cleanup(manager, dir);
  }
});

test("a restart requeues a saved sub-agent instead of failing the turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ui-delegate-"));
  let manager: DelegateManager | undefined;
  try {
    const id = "del_boot";
    await mkdir(join(dir, "delegates", id), { recursive: true });
    await writeFile(join(dir, "delegates", id, "pi.sqlite3"), "");
    await writeFile(
      join(dir, "delegates", "delegates.json"),
      `${JSON.stringify({
        runs: [
          {
            id,
            task: "fix the config",
            cwd: dir,
            status: "running",
            queuedAt: "2026-11-16T00:00:00.000Z",
            startedAt: "2026-11-16T00:00:00.000Z",
            endedAt: null,
            timeoutMinutes: 30,
          },
        ],
      })}\n`,
    );
    const box = await harness(dir);
    manager = box.manager;
    await box.manager.load();
    assert.equal(box.manager.restartInterrupted(), 1);
    assert.equal(await box.submitted(id), "fix the config");
    assert.equal(box.manager.get(id).status, "running");
    assert.equal(box.manager.get(id).lastOutcome, undefined);
    await box.manager.flushBootNotices();
    assert.equal(box.chips.length, 0);
    box.finish(id, { text: "config written" });
    await waitFor(() => box.manager.get(id).status === "idle");
    assert.equal(box.manager.get(id).lastOutcome, "completed");
  } finally {
    await cleanup(manager, dir);
  }
});

test("a restart without a saved session tells the chat to start a new sub-agent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ui-delegate-"));
  let manager: DelegateManager | undefined;
  try {
    await mkdir(join(dir, "delegates"), { recursive: true });
    await writeFile(
      join(dir, "delegates", "delegates.json"),
      `${JSON.stringify({
        runs: [
          {
            id: "del_old",
            task: "fix the config",
            cwd: dir,
            status: "running",
            queuedAt: "2026-11-16T00:00:00.000Z",
            startedAt: "2026-11-16T00:00:00.000Z",
            endedAt: null,
            timeoutMinutes: 30,
          },
        ],
      })}\n`,
    );
    const box = await harness(dir);
    manager = box.manager;
    await box.manager.load();
    assert.equal(box.manager.get("del_old").status, "idle");
    assert.match(box.manager.get("del_old").error ?? "", new RegExp(DELEGATE_RESTART_ERROR));
    await box.manager.flushBootNotices();
    assert.match(box.chips[0] ?? "", /Start a new one with acp_delegate/);
    await assert.rejects(() => box.manager.continue("del_old", "again"), /was closed/);
  } finally {
    await cleanup(manager, dir);
  }
});

test("idle sessions past the cap are closed and the newest can still continue", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ui-delegate-"));
  let manager: DelegateManager | undefined;
  try {
    const box = await harness(dir);
    manager = box.manager;
    const ids: string[] = [];
    for (let index = 0; index < MAX_IDLE_DELEGATES + 1; index++) {
      const run = await box.manager.start({ prompt: `edit file ${index}` });
      ids.push(run.id);
      await box.submitted(run.id);
      box.finish(run.id, { text: `done ${index}` });
      await waitFor(
        () =>
          box.manager.get(run.id).status === "idle" ||
          box.manager.get(run.id).lastOutcome === "completed",
      );
    }
    await waitFor(() => box.chips.length === MAX_IDLE_DELEGATES + 1);
    await assert.rejects(() => box.manager.continue(ids[0] ?? "", "more"), /was closed/);
    const newest = ids.at(-1) ?? "";
    const continued = await box.manager.continue(newest, "one more edit");
    assert.equal(continued.id, newest);
    await waitFor(() => box.manager.get(newest).status === "running");
  } finally {
    await cleanup(manager, dir);
  }
});

test("the dock counts a working sub-agent and shows its prompt", () => {
  const running = view();
  const idle = view({
    id: "del_2",
    status: "idle",
    lastOutcome: "completed",
    taskFirstLine: "done",
  });
  assert.equal(activeSubagents([running, idle]).length, 1);
  const counts = renderToStaticMarkup(
    createElement(BackgroundJobsCounts, {
      jobs: [],
      delegates: [running, idle],
      onOpen: () => undefined,
      visible: true,
    }),
  );
  assert.match(counts, /1 subagent/);
  assert.doesNotMatch(counts, /2 subagents/);
  const hidden = renderToStaticMarkup(
    createElement(BackgroundJobsCounts, {
      jobs: [],
      delegates: [idle],
      onOpen: () => undefined,
      visible: true,
    }),
  );
  assert.equal(hidden, "");
  const sheet = renderToStaticMarkup(
    createElement(BackgroundJobsSheet, {
      kind: "subagents",
      jobs: [],
      delegates: [running],
      onOpenItem: () => undefined,
      onClose: () => undefined,
    }),
  );
  assert.match(sheet, /edit sshd_config/);
  assert.doesNotMatch(sheet, /reviewer|worker|planner|oracle/);
});

test("an older role chip still parses", () => {
  const legacy = parseNotice(
    [
      "[acp_delegate completed] **worker** (runId `del_x`) completed after 3s.",
      "Task: edit the file",
      "Result: /tmp/del_x.out",
      "Activity: /tmp/del_x.activity",
      "Tokens: 10 in, 2 out.",
    ].join("\n"),
  );
  assert.equal(legacy?.kind, "delegate");
  if (legacy?.kind === "delegate") {
    assert.equal(legacy.agent, "worker");
    assert.equal(legacy.runId, "del_x");
    assert.equal(legacy.status, "completed");
    assert.equal(legacy.task, "edit the file");
    assert.equal(legacy.excerpt, null);
  }
});
