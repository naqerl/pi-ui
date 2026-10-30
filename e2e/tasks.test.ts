import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTaskTools, type TaskBridge } from "../src/server/task-tools.js";
import { TaskStore } from "../src/server/tasks.js";
import { formatTokenCount, parseTimeSpentMinutes } from "../src/shared/tasks.js";
import type { TaskLedger } from "../src/shared/types.js";

function tools(bridge: TaskBridge) {
  return new Map(createTaskTools(bridge).map((tool) => [tool.name, tool]));
}

async function call(bridge: TaskBridge, name: string, args: Record<string, unknown>) {
  const tool = tools(bridge).get(name);
  assert.ok(tool);
  return tool.execute(args as never, {} as never, {} as never);
}

function text(result: Awaited<ReturnType<typeof call>>) {
  const part = result.output?.find((item) => item.type === "text");
  return {
    text: part !== undefined && part.type === "text" ? part.text : "",
    isError: result.isError === true,
  };
}

async function temporaryStore() {
  const directory = await mkdtemp(join(tmpdir(), "pi-ui-task-completion-"));
  const file = join(directory, "tasks.json");
  const store = new TaskStore(file);
  await store.load();
  const bridge: TaskBridge = { store, publish() {} };
  return { directory, file, store, bridge };
}

test("parses the accepted time-spent forms", () => {
  const accepted: Array<[unknown, number]> = [
    ["~25m", 25],
    ["2h", 120],
    ["1h40m", 100],
    ["1h 40m", 100],
    ["45", 45],
    [45, 45],
  ];
  for (const [input, minutes] of accepted) {
    assert.equal(parseTimeSpentMinutes(input), minutes, String(input));
  }
  for (const input of ["", "0", "0m", "-5", "soon", null, undefined]) {
    assert.equal(parseTimeSpentMinutes(input), null, String(input));
  }
  assert.equal(formatTokenCount(120_000), "120k");
  assert.equal(formatTokenCount(0), "0");
});

test("task_done rejects each missing field and leaves the task open", async () => {
  const { directory, store, bridge } = await temporaryStore();
  try {
    const created = await store.create("Report the cost", null);
    const task = created.tasks[0];
    assert.ok(task);
    const complete = {
      timeSpent: "~25m",
      tokens: 120_000,
      evidence: "src/server/task-tools.ts",
    };

    for (const field of ["timeSpent", "tokens", "evidence"]) {
      const args: Record<string, unknown> = { id: task.id, ...complete };
      delete args[field];
      const rejected = text(await call(bridge, "task_done", args));
      assert.equal(rejected.isError, true, field);
      assert.match(rejected.text, new RegExp(field, "i"));
      const current = store.ledger().tasks.find((item) => item.id === task.id);
      assert.equal(current?.status, "open", field);
      assert.equal(current?.completedAt, null, field);
      assert.equal(current?.completion, null, field);
    }

    for (const invalid of [
      { ...complete, timeSpent: "soon" },
      { ...complete, timeSpent: "0" },
      { ...complete, tokens: -1 },
      { ...complete, tokens: 1.5 },
      { ...complete, evidence: "short" },
    ]) {
      const rejected = text(await call(bridge, "task_done", { id: task.id, ...invalid }));
      assert.equal(rejected.isError, true);
      const current = store.ledger().tasks.find((item) => item.id === task.id);
      assert.equal(current?.status, "open");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("task_done stores the report and both views show it", async () => {
  const { directory, store, bridge } = await temporaryStore();
  try {
    const task = (await store.create("Close with a report", null)).tasks[0];
    assert.ok(task);
    const closed = text(
      await call(bridge, "task_done", {
        id: task.id,
        timeSpent: "~25m",
        tokens: 120_000,
        evidence: "  commit 9c58abc  ",
      }),
    );
    assert.equal(closed.isError, false);

    const stored = store.ledger().tasks.find((item) => item.id === task.id);
    assert.equal(stored?.status, "done");
    assert.match(stored?.completedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(stored?.completion, {
      timeSpentMinutes: 25,
      timeSpentText: "~25m",
      tokens: 120_000,
      evidence: "commit 9c58abc",
    });

    const listed = text(await call(bridge, "task_list", {}));
    assert.match(listed.text, new RegExp(`${task.id} done · ~25m · 120k tok Close with a report`));
    const viewed = text(await call(bridge, "task_view", { id: task.id }));
    assert.match(viewed.text, /completed /);
    assert.match(viewed.text, /time spent ~25m \(25 min\)/);
    assert.match(viewed.text, /tokens 120000/);
    assert.match(viewed.text, /evidence commit 9c58abc/);

    const zero = (await store.create("No model work", null)).tasks.find(
      (item) => item.title === "No model work",
    );
    assert.ok(zero);
    const zeroDone = text(
      await call(bridge, "task_done", {
        id: zero.id,
        timeSpent: 45,
        tokens: 0,
        evidence: "Closed after review from the tasks page",
      }),
    );
    assert.equal(zeroDone.isError, false);
    assert.equal(store.ledger().tasks.find((item) => item.id === zero.id)?.completion?.tokens, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("store round-trips completedAt and clears it when reopened", async () => {
  const { directory, file, store } = await temporaryStore();
  try {
    const task = (await store.create("Persist the report", null)).tasks[0];
    assert.ok(task);
    assert.equal(task.completedAt, null);
    assert.equal(task.completion, null);

    const completion = {
      timeSpentMinutes: 100,
      timeSpentText: "1h40m",
      tokens: 12_345,
      evidence: "e2e/tasks.test.ts",
    };
    await store.update(task.id, { status: "done", completion });
    const closed = store.ledger().tasks.find((item) => item.id === task.id);
    assert.ok(closed?.completedAt);
    assert.deepEqual(closed.completion, completion);

    const loaded = new TaskStore(file);
    await loaded.load();
    const roundTripped = loaded.ledger().tasks.find((item) => item.id === task.id);
    assert.equal(roundTripped?.completedAt, closed.completedAt);
    assert.deepEqual(roundTripped?.completion, completion);

    await loaded.update(task.id, { status: "open" });
    const reopened = loaded.ledger().tasks.find((item) => item.id === task.id);
    assert.equal(reopened?.completedAt, null);
    assert.equal(reopened?.completion, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loads a task record written before completions existed", async () => {
  const { directory, file, store, bridge } = await temporaryStore();
  try {
    await writeFile(
      file,
      JSON.stringify({
        revision: 7,
        tasks: [
          {
            id: "old1",
            title: "Legacy done task",
            status: "done",
            parentId: null,
            blockedBy: [],
            createdAt: "2025-01-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    await store.load();
    const legacy = store.ledger().tasks[0];
    assert.equal(legacy?.completedAt, null);
    assert.equal(legacy?.completion, null);
    assert.match(text(await call(bridge, "task_list", {})).text, /old1 done Legacy done task/);
    const saved = JSON.parse(await readFile(file, "utf8")) as { tasks: TaskLedger["tasks"] };
    assert.equal(saved.tasks.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
