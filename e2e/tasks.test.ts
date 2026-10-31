import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskModal } from "../src/client/TasksView.js";
import { createTaskTools, type TaskBridge } from "../src/server/task-tools.js";
import { TaskStore } from "../src/server/tasks.js";
import {
  compareTasks,
  formatTokenCount,
  hasOpenDescendant,
  liveBlockerIds,
  parseTimeSpentMinutes,
} from "../src/shared/tasks.js";
import type { Task, TaskLedger } from "../src/shared/types.js";

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

test("task ordering puts proposals first, then ready, blocked and done deterministically", () => {
  const base: Omit<Task, "id" | "title" | "status" | "blockedBy" | "createdAt"> = {
    parentId: null,
    completedAt: null,
    completion: null,
  };
  const tasks: Task[] = [
    {
      ...base,
      id: "done",
      title: "Done",
      status: "done",
      blockedBy: [],
      createdAt: "2026-01-01T00:00:01.000Z",
    },
    {
      ...base,
      id: "blocked",
      title: "Blocked",
      status: "open",
      blockedBy: ["ready"],
      createdAt: "2026-01-01T00:00:02.000Z",
    },
    {
      ...base,
      id: "ready",
      title: "Ready",
      status: "open",
      blockedBy: [],
      createdAt: "2026-01-01T00:00:03.000Z",
    },
    {
      ...base,
      id: "proposed-b",
      title: "Proposed B",
      status: "proposed",
      blockedBy: [],
      createdAt: "2026-01-01T00:00:04.000Z",
    },
    {
      ...base,
      id: "proposed-a",
      title: "Proposed A",
      status: "proposed",
      blockedBy: [],
      createdAt: "2026-01-01T00:00:04.000Z",
    },
  ];
  assert.deepEqual(
    tasks
      .slice()
      .sort((a, b) => compareTasks(tasks, a, b))
      .map((task) => task.id),
    ["proposed-a", "proposed-b", "ready", "blocked", "done"],
  );
});

test("the task modal shows the full rationale, blockers and completion record", () => {
  const blocker: Task = {
    id: "b1",
    title: "Review the details",
    status: "done",
    parentId: null,
    blockedBy: [],
    createdAt: "2026-01-01T12:00:00.000Z",
    completedAt: "2026-01-01T12:20:00.000Z",
    completion: {
      timeSpentMinutes: 25,
      timeSpentText: "25m",
      tokens: 1200,
      evidence: "commit 9c58abc",
    },
  };
  const task: Task = {
    id: "t1",
    title: "Ship the modal",
    status: "open",
    parentId: null,
    blockedBy: [blocker.id],
    createdAt: "2026-01-01T12:00:01.000Z",
    rationale: `The card hides the rest of this rationale.\n\n${"A long explanation. ".repeat(20)}`,
    completedAt: null,
    completion: null,
  };
  const markup = renderToStaticMarkup(
    createElement(TaskModal, {
      task,
      tasks: [task, blocker],
      onClose: () => {},
      onStatus: () => {},
    }),
  );
  assert.match(markup, /data-testid="task-modal"/);
  assert.match(markup, /Ship the modal/);
  assert.match(markup, /The card hides the rest of this rationale\./);
  assert.match(markup, /A long explanation\./);
  assert.match(markup, /Review the details/);
  assert.match(markup, /done/);
  assert.match(markup, /Created/);
  assert.match(markup, /Mark done/);
});

test("the completed task modal carries time spent, tokens, evidence and the closed time", () => {
  const task: Task = {
    id: "t2",
    title: "Ship the modal",
    status: "done",
    parentId: null,
    blockedBy: [],
    createdAt: "2026-01-01T12:00:00.000Z",
    completedAt: "2026-01-01T12:25:00.000Z",
    completion: {
      timeSpentMinutes: 25,
      timeSpentText: "25m",
      tokens: 1200,
      evidence: "commit 9c58abc",
    },
  };
  const markup = renderToStaticMarkup(
    createElement(TaskModal, { task, tasks: [task], onClose: () => {}, onStatus: () => {} }),
  );
  assert.match(markup, /data-testid="task-modal-completion"/);
  assert.match(markup, /25m \(25 min\)/);
  assert.match(markup, /1\.2k/);
  assert.match(markup, /commit 9c58abc/);
  assert.match(markup, /Closed/);
});

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

test("propose_task requires a reason and keeps proposals out of task_list", async () => {
  const { directory, store, bridge } = await temporaryStore();
  try {
    const short = text(
      await call(bridge, "propose_task", {
        title: "Tidy the ledger",
        rationale: "It would be nice.",
      }),
    );
    assert.equal(short.isError, true);
    assert.match(short.text, /rationale|reason/i);
    assert.equal(store.ledger().tasks.length, 0);

    const rationale = "This removes repeated work and makes the ledger easier to review.";
    const proposed = text(
      await call(bridge, "propose_task", { title: "Tidy the ledger", rationale }),
    );
    assert.equal(proposed.isError, false);
    assert.doesNotMatch(proposed.text, /Tidy the ledger/);
    assert.match(proposed.text, /^proposals: 1 waiting for approval$/m);

    const task = store.ledger().tasks.find((item) => item.title === "Tidy the ledger");
    assert.ok(task);
    assert.equal(task.status, "proposed");
    assert.equal(task.parentId, null);
    assert.deepEqual(task.blockedBy, []);
    assert.equal(task.rationale, rationale);
    assert.match(task.proposedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);

    const listed = text(await call(bridge, "task_list", {}));
    assert.doesNotMatch(listed.text, /Tidy the ledger/);
    assert.equal(listed.text.split("\n").at(-1), "proposals: 1 waiting for approval");

    await store.create("A real task", null);
    const withWork = text(await call(bridge, "task_list", {}));
    assert.match(withWork.text, /A real task/);
    assert.equal(withWork.text.split("\n").at(-1), "proposals: 1 waiting for approval");

    await store.remove(task.id);
    const withoutProposals = text(await call(bridge, "task_list", {}));
    assert.doesNotMatch(withoutProposals.text, /proposals:/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("task_proposals lists proposals and task_done refuses them", async () => {
  const { directory, store, bridge } = await temporaryStore();
  try {
    const rationale = "Reviewing this now avoids a larger migration later.";
    await call(bridge, "propose_task", { title: "Plan the migration", rationale });
    const proposal = store.ledger().tasks[0];
    assert.ok(proposal);

    const listed = text(await call(bridge, "task_proposals", {}));
    assert.equal(listed.isError, false);
    assert.match(listed.text, new RegExp(proposal.id));
    assert.match(listed.text, /Plan the migration/);
    assert.match(listed.text, new RegExp(rationale));
    assert.match(listed.text, new RegExp(proposal.proposedAt ?? proposal.createdAt));

    const refused = text(
      await call(bridge, "task_done", {
        id: proposal.id,
        timeSpent: "5m",
        tokens: 10,
        evidence: "e2e/tasks.test.ts",
      }),
    );
    assert.equal(refused.isError, true);
    assert.match(refused.text, /proposal must be approved first/i);
    assert.equal(store.ledger().tasks[0]?.status, "proposed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("approving a proposal keeps its rationale and makes it normal work", async () => {
  const { directory, store, bridge } = await temporaryStore();
  try {
    const rationale = "The old importer fails on files bigger than a gigabyte.";
    await store.propose("Replace the importer", rationale);
    const proposal = store.ledger().tasks[0];
    assert.ok(proposal);

    const approved = await store.update(proposal.id, { status: "open" });
    const task = approved.tasks.find((item) => item.id === proposal.id);
    assert.equal(task?.status, "open");
    assert.equal(task?.proposedAt, null);
    assert.equal(task?.rationale, rationale);
    assert.equal(task?.completedAt, null);
    assert.equal(task?.completion, null);

    const listed = text(await call(bridge, "task_list", {}));
    assert.match(listed.text, new RegExp(`${proposal.id} open Replace the importer`));
    assert.doesNotMatch(listed.text, /proposals:/);

    await assert.rejects(store.update(proposal.id, { status: "proposed" }), /only a proposal/i);
    await store.remove(proposal.id);
    assert.equal(store.ledger().tasks.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("proposed tasks cannot block and do not keep a parent open", async () => {
  const { directory, store, bridge } = await temporaryStore();
  try {
    await store.propose(
      "Maybe add a cache",
      "The slow path repeats the same fetch on every request.",
    );
    const proposal = store.ledger().tasks[0];
    assert.ok(proposal);
    const target = (await store.create("Do the work", null)).tasks.find(
      (task) => task.title === "Do the work",
    );
    assert.ok(target);

    const updated = await store.update(target.id, { blockedBy: [proposal.id] });
    const after = updated.tasks.find((task) => task.id === target.id);
    assert.deepEqual(after?.blockedBy, []);
    assert.deepEqual(liveBlockerIds(updated.tasks, after as Task), []);
    assert.doesNotMatch(text(await call(bridge, "task_list", {})).text, /blocked-by=/);

    const parent: Task = {
      ...target,
      id: "parent",
      title: "Parent",
      status: "open",
      parentId: null,
      blockedBy: [],
    };
    const child: Task = {
      ...proposal,
      id: "child",
      title: "Proposed child",
      status: "proposed",
      parentId: parent.id,
      blockedBy: [],
    };
    assert.equal(hasOpenDescendant([parent, child], parent.id), false);
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
