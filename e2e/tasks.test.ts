import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  PLAN_TASK_DRAFT_KEY,
  readPlanTaskDraft,
  writePlanTaskDraft,
} from "../src/client/composer-preferences.js";
import {
  dayLabel,
  doneDayLabel,
  groupByDay,
  groupByProject,
  TaskDetail,
  TaskRow,
  TaskTimes,
} from "../src/client/TasksView.js";
import type { PushNotification } from "../src/server/push.js";
import { createTaskTools, type TaskBridge } from "../src/server/task-tools.js";
import { TaskStore, type TaskStoreOptions, taskReopenStats } from "../src/server/tasks.js";
import type { OperatorNoticeRecord } from "../src/shared/notices.js";
import {
  compareTasks,
  formatActiveTime,
  formatCost,
  formatTokenCount,
  hasOpenDescendant,
  liveBlockerIds,
  TASK_BODY_MAX_LENGTH,
} from "../src/shared/tasks.js";
import { formatDateTime, formatTime } from "../src/shared/time.js";
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

async function temporaryStore(options: TaskStoreOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pi-ui-task-completion-"));
  const file = join(directory, "tasks.json");
  const store = new TaskStore(file, options);
  await store.load();
  const bridge: TaskBridge = { store, publish() {} };
  return { directory, file, store, bridge };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function renderTaskCard(task: Task, planning: readonly string[] = []) {
  return renderToStaticMarkup(
    createElement(TaskRow, {
      task,
      tasks: [task],
      planning: new Set(planning),
      activity: undefined,
      state: (item: Task) =>
        item.status === "done"
          ? "done"
          : item.status === "proposed"
            ? "proposed"
            : item.status === "planning"
              ? "planning"
              : "ready",
      depth: 0,
      selectedId: null,
      cardClickGuard: { current: { pointer: null, ignore: null, timer: null } },
      armCardClickIgnore: () => {},
      problem: null,
      menuTaskId: null,
      onOpenMenu: () => {},
      onOpen: () => {},
    }),
  );
}

test("the plan-task composer choice is on by default and remembered for the session", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  // A fresh session starts planning; only an explicit off choice wins over it.
  assert.equal(readPlanTaskDraft(storage), true);
  writePlanTaskDraft(false, storage);
  assert.equal(values.get(PLAN_TASK_DRAFT_KEY), "0");
  assert.equal(readPlanTaskDraft(storage), false);
  writePlanTaskDraft(true, storage);
  assert.equal(readPlanTaskDraft(storage), true);
  assert.equal(readPlanTaskDraft(undefined), true);
});

test("concurrent creates each return the exact task they inserted", async () => {
  const { directory, store } = await temporaryStore();
  try {
    const titles = ["First plan draft", "Second plan draft"];
    const [first, second] = await Promise.all(
      titles.map((title) =>
        store.createWithResult(title, null, [], undefined, `${title} body`, {
          status: "planning",
        }),
      ),
    );
    assert.equal(first.task.title, titles[0]);
    assert.equal(second.task.title, titles[1]);
    assert.notEqual(first.task.id, second.task.id);
    assert.equal(first.ledger.tasks.find((task) => task.id === first.task.id)?.title, titles[0]);
    assert.equal(second.ledger.tasks.find((task) => task.id === second.task.id)?.title, titles[1]);
    assert.deepEqual(
      store
        .ledger()
        .tasks.filter((task) => titles.includes(task.title))
        .map((task) => [task.title, task.status, task.body]),
      [
        [titles[0], "planning", `${titles[0]} body`],
        [titles[1], "planning", `${titles[1]} body`],
      ],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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
    completion: { evidence: "commit 9c58abc" },
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
    createElement(TaskDetail, {
      task,
      tasks: [task, blocker],
      state: "blocked",
      trace: undefined,
      wide: true,
      notice: null,
      onClose: () => {},
      onOpen: () => {},
      onStatus: () => {},
      onApprove: () => {},
      onDismiss: () => {},
      onRemove: () => {},
    }),
  );
  assert.match(markup, /data-testid="task-detail"/);
  assert.match(markup, /Ship the modal/);
  assert.match(markup, /The card hides the rest of this rationale\./);
  assert.match(markup, /A long explanation\./);
  assert.doesNotMatch(markup, /Review the details/);
  assert.doesNotMatch(markup, /Blocked by/);
  assert.doesNotMatch(markup, />Done</);
  assert.match(markup, /Task details/);
  assert.match(markup, /data-testid="task-details-bar"/);
  assert.match(markup, /data-testid="task-detail-menu"/);
  assert.doesNotMatch(markup, /data-testid="task-state"/);
  assert.doesNotMatch(markup, /data-testid="task-header-meta"/);
  assert.doesNotMatch(markup, /data-testid="task-stats"/);
  assert.doesNotMatch(markup, /Active time/);
  assert.doesNotMatch(markup, /data-testid="task-history"/);
  assert.doesNotMatch(markup, /History/);
  assert.doesNotMatch(markup, /earlier event/);
});

test("the completed task modal carries the evidence and the closed time", () => {
  const task: Task = {
    id: "t2",
    title: "Ship the modal",
    status: "done",
    parentId: null,
    blockedBy: [],
    createdAt: "2026-01-01T12:00:00.000Z",
    completedAt: "2026-01-01T12:25:00.000Z",
    completion: { evidence: "commit 9c58abc" },
  };
  const markup = renderToStaticMarkup(
    createElement(TaskDetail, {
      task,
      tasks: [task],
      state: "done",
      trace: {
        lastActivityAt: "2026-01-01T12:20:00.000Z",
        lastRun: { id: "r1", outcome: "ok", at: "2026-01-01T12:21:00.000Z" },
        measured: { runs: 2, calls: 9, activeMs: 18 * 60_000, tokens: 41_200, cost: 0.42 },
        history: [
          { at: "2026-01-01T12:00:00.000Z", kind: "created", text: "created" },
          { at: "2026-01-01T12:01:00.000Z", kind: "run-start", text: "run started" },
          { at: "2026-01-01T12:25:00.000Z", kind: "done", text: "marked done" },
        ],
      },
      wide: false,
      notice: null,
      onClose: () => {},
      onOpen: () => {},
      onStatus: () => {},
      onApprove: () => {},
      onDismiss: () => {},
      onRemove: () => {},
    }),
  );
  assert.match(markup, /data-testid="task-modal-completion"/);
  assert.match(markup, /commit 9c58abc/);
  assert.match(markup, /closed /);
  assert.doesNotMatch(markup, /data-testid="task-stats"/);
  assert.doesNotMatch(markup, /Active time/);
  assert.doesNotMatch(markup, /data-testid="task-history"/);
  assert.doesNotMatch(markup, /run started/);
  assert.doesNotMatch(markup, /earlier event/);
  assert.match(markup, /data-testid="task-detail-back"/);
});

function inZone<T>(zone: string, run: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

test("task cards show created and closed times in the browser's local zone", () => {
  const task: Task = {
    id: "t1",
    title: "Ship the modal",
    status: "done",
    parentId: null,
    blockedBy: [],
    createdAt: "2026-01-01T12:00:00.000Z",
    completedAt: "2026-01-01T12:25:00.000Z",
    completion: { evidence: "e2e/tasks.test.ts" },
  };
  const markup = inZone("Asia/Tokyo", () =>
    renderToStaticMarkup(createElement(TaskTimes, { task })),
  );
  const created = inZone("Asia/Tokyo", () => formatDateTime(task.createdAt));
  const closed = inZone("Asia/Tokyo", () => formatDateTime(task.completedAt ?? ""));
  const utc = inZone("UTC", () => formatDateTime(task.createdAt));

  assert.match(markup, /data-testid="task-times"/);
  assert.match(markup, new RegExp(`Created ${created.replaceAll(".", "\\.")}`));
  assert.match(markup, new RegExp(`Closed ${closed.replaceAll(".", "\\.")}`));
  assert.notEqual(created, utc);
  assert.doesNotMatch(markup, new RegExp(`Created ${utc.replaceAll(".", "\\.")}`));
});

test("a task card shows only the created time while the task is open", () => {
  const task: Task = {
    id: "card-open",
    title: "Keep the ledger open",
    status: "open",
    parentId: null,
    blockedBy: [],
    createdAt: "2026-01-01T12:00:00.000Z",
    completedAt: null,
    completion: null,
  };
  const markup = inZone("Asia/Tokyo", () => renderTaskCard(task));
  const created = inZone("Asia/Tokyo", () => formatTime(task.createdAt));

  assert.match(markup, /data-testid="task-card-times"/);
  assert.match(markup, new RegExp(`dateTime="${task.createdAt}"`));
  assert.match(markup, new RegExp(`Created ${created}`));
  assert.doesNotMatch(markup, /Closed/);
});

test("a planning task row shows the live planning badge", () => {
  const task: Task = {
    id: "card-planning",
    title: "Specify the launch",
    status: "planning",
    parentId: null,
    blockedBy: [],
    createdAt: "2026-01-01T12:00:00.000Z",
    completedAt: null,
    completion: null,
  };
  const idle = renderTaskCard(task);
  assert.doesNotMatch(idle, /data-testid="task-planning-card-planning"/);
  const live = renderTaskCard(task, [task.id]);
  assert.match(live, /data-testid="task-planning-card-planning"/);
  assert.match(live, /data-state="planning"/);
});

test("a done task card shows the created and closed times", () => {
  const task: Task = {
    id: "card-done",
    title: "Close the ledger",
    status: "done",
    parentId: null,
    blockedBy: [],
    createdAt: "2026-01-01T12:00:00.000Z",
    completedAt: "2026-01-01T12:25:00.000Z",
    completion: { evidence: "e2e/tasks.test.ts" },
  };
  const markup = inZone("Asia/Tokyo", () => renderTaskCard(task));
  const created = inZone("Asia/Tokyo", () => formatTime(task.createdAt));
  const closed = inZone("Asia/Tokyo", () => formatTime(task.completedAt ?? ""));

  assert.match(markup, new RegExp(`dateTime="${task.createdAt}"`));
  assert.match(markup, new RegExp(`dateTime="${task.completedAt}"`));
  assert.match(markup, new RegExp(`Created ${created}`));
  assert.match(markup, new RegExp(`Closed ${closed}`));
});

test("a done task card without completedAt falls back to the created time", () => {
  const task: Task = {
    id: "card-done-legacy",
    title: "Legacy card without a closing instant",
    status: "done",
    parentId: null,
    blockedBy: [],
    createdAt: "2026-01-01T12:00:00.000Z",
    completedAt: null,
    completion: null,
  };
  const markup = inZone("UTC", () => renderTaskCard(task));
  const created = inZone("UTC", () => formatTime(task.createdAt));

  assert.match(markup, new RegExp(`Created ${created}`));
  assert.doesNotMatch(markup, /Closed/);
});

test("formats measured tokens, time and cost", () => {
  assert.equal(formatTokenCount(120_000), "120k");
  assert.equal(formatTokenCount(0), "0");
  assert.equal(formatActiveTime(42_000), "42s");
  assert.equal(formatActiveTime(18 * 60_000), "18m");
  assert.equal(formatActiveTime(65 * 60_000), "1h 05m");
  assert.equal(formatCost(0), "$0");
  assert.equal(formatCost(0.004), "<$0.01");
  assert.equal(formatCost(1.234), "$1.23");
});

test("task_done needs checkable evidence and leaves the task open without it", async () => {
  const { directory, store, bridge } = await temporaryStore();
  try {
    const created = await store.create("Report the evidence", null);
    const task = created.tasks[0];
    assert.ok(task);
    for (const args of [{ id: task.id }, { id: task.id, evidence: "short" }]) {
      const rejected = text(await call(bridge, "task_done", args));
      assert.equal(rejected.isError, true);
      assert.match(rejected.text, /evidence/i);
      const current = store.ledger().tasks.find((item) => item.id === task.id);
      assert.equal(current?.status, "open");
      assert.equal(current?.completedAt, null);
      assert.equal(current?.completion, null);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("task_done stores the evidence, and the views do not invent a cost", async () => {
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
    assert.equal(closed.isError, false, "old callers that still send numbers are not refused");

    const stored = store.ledger().tasks.find((item) => item.id === task.id);
    assert.equal(stored?.status, "done");
    assert.match(stored?.completedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(stored?.completion, { evidence: "commit 9c58abc" });

    const listed = text(await call(bridge, "task_list", {}));
    assert.match(listed.text, new RegExp(`${task.id} done Close with a report`));
    const viewed = text(await call(bridge, "task_view", { id: task.id }));
    assert.match(viewed.text, /completed /);
    assert.doesNotMatch(viewed.text, /time spent|tokens/);
    assert.match(viewed.text, /evidence commit 9c58abc/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a human can close a task without evidence, and old completion records load", async () => {
  const { directory, file, store } = await temporaryStore();
  try {
    const task = (await store.create("Tick it off", null)).tasks[0];
    assert.ok(task);
    await store.update(task.id, { status: "done" });
    const closed = store.ledger().tasks.find((item) => item.id === task.id);
    assert.equal(closed?.status, "done");
    assert.equal(closed?.completion, null);

    await writeFile(
      file,
      JSON.stringify({
        revision: 3,
        tasks: [
          {
            id: "old2",
            title: "Self-reported",
            status: "done",
            parentId: null,
            blockedBy: [],
            createdAt: "2025-01-01T00:00:00.000Z",
            completedAt: "2025-01-01T01:00:00.000Z",
            completion: {
              timeSpentMinutes: 25,
              timeSpentText: "25m",
              tokens: 9,
              evidence: "abc1234x",
            },
          },
        ],
      }),
      "utf8",
    );
    await store.load();
    assert.deepEqual(store.ledger().tasks[0]?.completion, { evidence: "abc1234x" });
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

test("approving a proposal records one operator notice without a push", async () => {
  const pushes: PushNotification[] = [];
  const notices: OperatorNoticeRecord[] = [];
  const { directory, store } = await temporaryStore({
    notify: (notification) => {
      pushes.push(notification);
    },
    notice: (record) => {
      notices.push(record);
    },
    pushWindowMs: 0,
  });
  try {
    await store.propose(
      "Tidy the ledger",
      "The repeated cleanup costs more than the change and makes reviews noisy.",
    );
    const proposal = store.ledger().tasks[0];
    assert.ok(proposal);
    pushes.length = 0;

    await store.update(proposal.id, { status: "open" });

    assert.deepEqual(pushes, []);
    assert.equal(notices.length, 1);
    assert.match(notices[0]?.body ?? "", /Tidy the ledger/);
    assert.match(notices[0]?.body ?? "", /approved/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("approving returns only after the decision's queue entry is placed", async () => {
  const notices: OperatorNoticeRecord[] = [];
  let release: (() => void) | undefined;
  let started: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { directory, store } = await temporaryStore({
    notify: () => undefined,
    notice: (record) => {
      notices.push(record);
      started?.();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    pushWindowMs: 0,
  });
  try {
    await store.propose(
      "Deliver the decision with the write",
      "The approval must not return while the model entry is still waiting to be queued.",
    );
    const proposal = store.ledger().tasks[0];
    assert.ok(proposal);

    let settled = false;
    const update = store.update(proposal.id, { status: "open" }).then((ledger) => {
      settled = true;
      return ledger;
    });
    await entered;
    assert.equal(settled, false);
    release?.();
    const ledger = await update;
    assert.equal(ledger.tasks.find((task) => task.id === proposal.id)?.status, "open");
    assert.equal(notices.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("declining a proposal records one operator notice without a push", async () => {
  const pushes: PushNotification[] = [];
  const notices: OperatorNoticeRecord[] = [];
  const { directory, store } = await temporaryStore({
    notify: (notification) => {
      pushes.push(notification);
    },
    notice: (record) => {
      notices.push(record);
    },
    pushWindowMs: 0,
  });
  try {
    await store.propose(
      "Drop the old importer",
      "The old importer fails on files bigger than a gigabyte and nothing uses it.",
    );
    const proposal = store.ledger().tasks[0];
    assert.ok(proposal);
    pushes.length = 0;

    await store.remove(proposal.id);

    assert.deepEqual(pushes, []);
    assert.equal(notices.length, 1);
    assert.match(notices[0]?.body ?? "", /Drop the old importer/);
    assert.match(notices[0]?.body ?? "", /declined/i);

    const open = (await store.create("Keep this task", null)).tasks[0];
    assert.ok(open);
    pushes.length = 0;
    notices.length = 0;
    await store.remove(open.id);
    assert.deepEqual(pushes, []);
    assert.deepEqual(notices, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("approving in the burst window cancels the approval push and keeps the other proposal", async () => {
  const pushes: PushNotification[] = [];
  const notices: OperatorNoticeRecord[] = [];
  const { directory, store } = await temporaryStore({
    notify: (notification) => {
      pushes.push(notification);
    },
    notice: (record) => {
      notices.push(record);
    },
    pushWindowMs: 150,
  });
  try {
    const [alphaLedger] = await Promise.all([
      store.propose("Alpha", "Alpha is worth doing because it removes repeated manual work."),
      store.propose("Beta", "Beta is worth doing because it removes repeated manual work."),
    ]);
    const alpha = alphaLedger.tasks.find((task) => task.title === "Alpha");
    assert.ok(alpha);

    await store.update(alpha.id, { status: "open" });
    await wait(250);

    assert.equal(pushes.length, 1);
    assert.equal(pushes[0]?.title, "New proposal");
    const body = pushes[0]?.body ?? "";
    assert.doesNotMatch(body, /Proposal approved: Alpha/);
    assert.doesNotMatch(body, /New proposal: Alpha/);
    assert.equal(body, "Beta");
    assert.equal(notices.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("three proposal decisions in one burst record three notices without a push", async () => {
  const pushes: PushNotification[] = [];
  const notices: OperatorNoticeRecord[] = [];
  const { directory, store } = await temporaryStore({
    notify: (notification) => {
      pushes.push(notification);
    },
    notice: (record) => {
      notices.push(record);
    },
    pushWindowMs: 150,
  });
  try {
    await Promise.all([
      store.propose("Alpha", "Alpha is worth doing because it removes repeated manual work."),
      store.propose("Beta", "Beta is worth doing because it removes repeated manual work."),
      store.propose("Gamma", "Gamma is worth doing because it removes repeated manual work."),
    ]);
    const tasks = store.ledger().tasks;
    const alpha = tasks.find((task) => task.title === "Alpha");
    const beta = tasks.find((task) => task.title === "Beta");
    const gamma = tasks.find((task) => task.title === "Gamma");
    assert.ok(alpha);
    assert.ok(beta);
    assert.ok(gamma);

    await Promise.all([
      store.update(alpha.id, { status: "open" }),
      store.remove(beta.id),
      store.remove(gamma.id),
    ]);
    await wait(250);

    assert.deepEqual(pushes, []);
    assert.equal(notices.length, 3);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failing operator notice does not fail a proposal decision", async () => {
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    const pushes: PushNotification[] = [];
    const { directory, store } = await temporaryStore({
      notify: (notification) => {
        pushes.push(notification);
      },
      notice: () => {
        throw new Error("chat notice unavailable");
      },
      pushWindowMs: 0,
    });
    try {
      await store.propose(
        "Approve despite the notice",
        "The decision must be saved even when the chat cannot record its notice.",
      );
      const proposal = store.ledger().tasks[0];
      assert.ok(proposal);
      pushes.length = 0;

      const ledger = await store.update(proposal.id, { status: "open" });
      assert.equal(ledger.tasks.find((task) => task.id === proposal.id)?.status, "open");
      assert.deepEqual(pushes, []);
      assert.equal(errors.length, 1);
      assert.match(String(errors[0]?.[0]), /\[pi\] task notice failed for/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  } finally {
    console.error = original;
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

test("store round-trips completedAt and keeps it as history when reopened", async () => {
  const { directory, file, store } = await temporaryStore();
  try {
    const task = (await store.create("Persist the report", null)).tasks[0];
    assert.ok(task);
    assert.equal(task.completedAt, null);
    assert.equal(task.completion, null);

    const completion = { evidence: "e2e/tasks.test.ts" };
    await store.update(task.id, { status: "done", completion });
    const closed = store.ledger().tasks.find((item) => item.id === task.id);
    assert.ok(closed?.completedAt);
    assert.deepEqual(closed.completion, completion);

    const loaded = new TaskStore(file);
    await loaded.load();
    const roundTripped = loaded.ledger().tasks.find((item) => item.id === task.id);
    assert.equal(roundTripped?.completedAt, closed.completedAt);
    assert.deepEqual(roundTripped?.completion, completion);

    await loaded.update(task.id, {
      status: "open",
      reopenReason: "The fix regressed on the next run",
    });
    const reopened = loaded.ledger().tasks.find((item) => item.id === task.id);
    assert.equal(reopened?.completedAt, null);
    assert.deepEqual(reopened?.completion, completion, "the old report stays as history");
    assert.equal(reopened?.reopens?.length, 1);
    assert.equal(reopened?.reopens?.[0]?.reason, "The fix regressed on the next run");
    assert.equal(reopened?.reopenedAt, reopened?.reopens?.[0]?.at);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a done task cannot move to working or backlog without an audited reopen", async () => {
  const { directory, store } = await temporaryStore();
  try {
    const task = (await store.create("Finished work", null)).tasks[0];
    assert.ok(task);
    const completion = { evidence: "e2e/tasks.test.ts finished" };
    await store.update(task.id, { status: "done", completion });

    await assert.rejects(store.update(task.id, { status: "working" }), /task_reopen/);
    let current = store.ledger().tasks.find((item) => item.id === task.id);
    assert.equal(current?.status, "done");
    assert.deepEqual(current?.completion, completion);
    assert.equal(current?.reopens, undefined);
    assert.equal(current?.reopenedAt, null);

    await assert.rejects(store.update(task.id, { status: "backlog" }), /task_reopen/);
    current = store.ledger().tasks.find((item) => item.id === task.id);
    assert.equal(current?.status, "done");
    assert.deepEqual(current?.completion, completion);

    await store.update(task.id, {
      status: "open",
      reopenReason: "The operator says it is still wrong",
    });
    current = store.ledger().tasks.find((item) => item.id === task.id);
    assert.equal(current?.status, "open");
    assert.equal(current?.reopens?.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lastWorkedAt survives a restart and clears when the task closes or reopens", async () => {
  const { directory, file, store } = await temporaryStore();
  try {
    const task = (await store.create("Remember the work", null)).tasks[0];
    assert.ok(task);
    const first = "2026-01-01T10:00:00.000Z";
    await store.noteWorked(task.id, first);
    assert.equal(store.ledger().tasks.find((item) => item.id === task.id)?.lastWorkedAt, first);

    const restarted = new TaskStore(file);
    await restarted.load();
    assert.equal(
      restarted.ledger().tasks.find((item) => item.id === task.id)?.lastWorkedAt,
      first,
      "the ledger remembers work across a restart",
    );

    await restarted.update(task.id, { status: "done" });
    assert.equal(
      restarted.ledger().tasks.find((item) => item.id === task.id)?.lastWorkedAt,
      null,
      "closing clears the stamp",
    );
    await restarted.noteWorked(task.id, "2026-01-01T11:00:00.000Z");
    assert.equal(
      restarted.ledger().tasks.find((item) => item.id === task.id)?.lastWorkedAt,
      null,
      "a tagged call that finishes after the close does not revive the task",
    );

    await restarted.update(task.id, {
      status: "open",
      reopenReason: "The report says it is still wrong",
    });
    assert.equal(
      restarted.ledger().tasks.find((item) => item.id === task.id)?.lastWorkedAt,
      null,
      "reopening starts untouched",
    );
    const again = "2026-01-01T12:00:00.000Z";
    await restarted.noteWorked(task.id, again);
    assert.equal(
      restarted.ledger().tasks.find((item) => item.id === task.id)?.lastWorkedAt,
      again,
      "new work stamps it again",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a released task ignores a late attributed call", async () => {
  const { directory, store } = await temporaryStore();
  try {
    const task = (await store.create("Park the work", null)).tasks[0];
    assert.ok(task);
    await store.update(task.id, { status: "working" });
    await store.update(task.id, { status: "open", releaseReason: "Waiting for capacity" });
    const released = store.ledger().tasks.find((item) => item.id === task.id);
    assert.equal(released?.status, "open");
    assert.equal(released?.releaseReason, "Waiting for capacity");
    assert.equal(released?.workingSince, undefined);
    assert.equal(released?.lastWorkedAt, null);

    // The release tool's own end-of-call attribution used to land here and revive the badge.
    await store.noteWorked(
      task.id,
      new Date(Date.parse(released?.releasedAt ?? "2026-01-01T00:00:00.000Z") + 2),
    );
    const after = store.ledger().tasks.find((item) => item.id === task.id);
    assert.equal(after?.status, "open");
    assert.equal(after?.lastWorkedAt, null);
    assert.equal(after?.workingSince, undefined);
    assert.equal(after?.releaseReason, "Waiting for capacity");
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

test("done tasks group by local day: today, yesterday, then short dates", () => {
  inZone("Europe/Belgrade", () => {
    const now = new Date(2026, 9, 31, 13, 0);
    const items = [
      { at: new Date(2026, 9, 31, 9, 0).toISOString(), id: "a" },
      { at: new Date(2026, 9, 29, 18, 0).toISOString(), id: "b" },
      { at: new Date(2026, 9, 30, 23, 30).toISOString(), id: "c" },
      { at: new Date(2026, 9, 31, 8, 0).toISOString(), id: "d" },
    ];
    const days = groupByDay(items, (item) => item.at);
    assert.deepEqual(
      days.map(([key, group]) => [key, group.map((item) => item.id)]),
      [
        ["2026-10-31", ["a", "d"]],
        ["2026-10-30", ["c"]],
        ["2026-10-29", ["b"]],
      ],
    );
    assert.deepEqual(
      days.map(([key]) => doneDayLabel(key, now)),
      ["Done today", "Done yesterday", "Done Oct 29"],
    );
    assert.equal(dayLabel("2026-10-31", now), "Today");
    assert.equal(dayLabel("2026-10-30", now), "Yesterday");
    assert.notEqual(dayLabel("2026-10-29", now), "Yesterday");
    assert.match(dayLabel("2026-10-29", now), /29/);
  });
});

test("a task completed today and one yesterday land in their named done days", () => {
  inZone("Europe/Belgrade", () => {
    const now = new Date(2026, 9, 31, 13, 0);
    const tasks = [
      { id: "today", completedAt: new Date(2026, 9, 31, 9, 0).toISOString() },
      { id: "yesterday", completedAt: new Date(2026, 9, 30, 9, 0).toISOString() },
    ];
    const days = groupByDay(tasks, (task) => task.completedAt);
    assert.deepEqual(
      days.map(([key, group]) => [doneDayLabel(key, now), group.map((task) => task.id)]),
      [
        ["Done today", ["today"]],
        ["Done yesterday", ["yesterday"]],
      ],
    );
  });
});

test("open tasks group by project A–Z, case-insensitively, with no project last", () => {
  const groups = groupByProject([
    { id: "a" },
    { id: "b", project: "zeroshot" },
    { id: "c", project: "citydiff" },
    { id: "d", project: "CityDiff" },
    { id: "e" },
  ]);
  assert.deepEqual(
    groups.map(([name, items]) => [name, items.map((item) => item.id)]),
    [
      ["citydiff", ["c", "d"]],
      ["zeroshot", ["b"]],
      [null, ["a", "e"]],
    ],
  );
  const loose: Array<{ id: string; project?: string }> = [{ id: "a" }];
  assert.deepEqual(groupByProject(loose), [[null, loose]]);
});

test("the task detail edits its project and shows a body as markdown", () => {
  const task: Task = {
    id: "t3",
    title: "Diff the tram routes",
    status: "open",
    parentId: null,
    blockedBy: [],
    createdAt: "2026-01-01T12:00:00.000Z",
    rationale: "The proposer's reason stays separate.",
    body: "# Route plan\n\nUse **tram 4**.",
    completedAt: null,
    completion: null,
    project: "citydiff",
  };
  const props = {
    tasks: [task],
    state: "ready" as const,
    trace: undefined,
    wide: true,
    notice: null,
    onClose: () => {},
    onOpen: () => {},
    onStatus: () => {},
    onApprove: () => {},
    onDismiss: () => {},
    onRemove: () => {},
  };
  const markup = renderToStaticMarkup(createElement(TaskDetail, { ...props, task }));
  assert.match(markup, /data-testid="task-details-bar"/);
  assert.match(markup, /Task details/);
  assert.match(markup, /data-testid="task-detail-menu"/);
  assert.doesNotMatch(markup, /data-testid="task-header-project"/);
  assert.doesNotMatch(markup, /data-testid="task-title"/);
  assert.doesNotMatch(markup, /<select/);
  assert.match(markup, /data-testid="task-body"/);
  assert.match(markup, /<h1[^>]*>Route plan<\/h1>/);
  assert.match(markup, /<strong[^>]*>tram 4<\/strong>/);
  assert.match(markup, /The proposer&#x27;s reason stays separate\./);
  assert.doesNotMatch(markup, /data-testid="task-title-edit"/);
  assert.doesNotMatch(markup, /data-testid="task-body-edit"/);
  const { project: _drop, ...loose } = task;
  const bare = renderToStaticMarkup(createElement(TaskDetail, { ...props, task: loose }));
  assert.match(bare, /data-testid="task-details-bar"/);
  assert.doesNotMatch(bare, /data-testid="task-header-project"/);
});

test("the task store rejects an empty title and a body that is not a string or too long", async () => {
  const { directory, file, store } = await temporaryStore();
  try {
    const task = (await store.create("Edit me", null)).tasks[0];
    assert.ok(task);
    await assert.rejects(store.update(task.id, { title: "   " }), /title must not be empty/);
    await assert.rejects(
      store.update(task.id, { body: 42 as unknown as string }),
      /body must be a string/,
    );
    await assert.rejects(
      store.update(task.id, { body: "x".repeat(TASK_BODY_MAX_LENGTH + 1) }),
      /body must be at most 20000 characters/,
    );
    const saved = await store.update(task.id, {
      title: "  Edit me too  ",
      body: "  # Notes\n\nKeep **this**.  ",
    });
    const edited = saved.tasks.find((item) => item.id === task.id);
    assert.equal(edited?.title, "Edit me too");
    assert.equal(edited?.body, "# Notes\n\nKeep **this**.");
    const cleared = await store.update(task.id, { body: "" });
    assert.equal(cleared.tasks.find((item) => item.id === task.id)?.body, undefined);
    const reloaded = new TaskStore(file, { notify: () => {} });
    await reloaded.load();
    assert.equal(reloaded.ledger().tasks.find((item) => item.id === task.id)?.body, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reopen stats count tasks and this week's reopens per project", () => {
  const now = Date.parse("2026-11-04T12:00:00.000Z");
  const recent = "2026-11-03T09:00:00.000Z";
  const old = "2026-10-20T09:00:00.000Z";
  const base = {
    status: "open" as const,
    parentId: null,
    blockedBy: [],
    createdAt: old,
    completedAt: null,
    completion: null,
  };
  const tasks: Task[] = [
    {
      ...base,
      id: "a1",
      title: "Alpha fix",
      project: "pi-ui",
      reopens: [
        { at: old, reason: "still wrong", by: "operator" },
        { at: recent, reason: "regressed", by: "agent" },
      ],
      reopenedAt: recent,
    },
    {
      ...base,
      id: "a2",
      title: "Beta fix",
      project: "PI-UI",
      reopens: [{ at: recent, reason: "wrong again", by: "operator" }],
      reopenedAt: recent,
    },
    {
      ...base,
      id: "a3",
      title: "Loose fix",
      reopens: [{ at: old, reason: "came back", by: "operator" }],
      reopenedAt: old,
    },
  ];
  assert.deepEqual(taskReopenStats(tasks, now), {
    totalReopenedTasks: 3,
    totalReopens: 4,
    reopensThisWeek: 2,
    projects: [
      { project: "pi-ui", reopenedTasks: 2, reopens: 3, reopensThisWeek: 2 },
      { project: null, reopenedTasks: 1, reopens: 1, reopensThisWeek: 0 },
    ],
  });
});
