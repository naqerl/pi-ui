import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Registry, ToolRegistration } from "@earendil-works/pi-durable";
import { TaskActivityTracker } from "../src/server/task-activity.js";
import { attributeTools, TASK_ID_PARAM, withTaskParam } from "../src/server/task-attribution.js";
import { taskState } from "../src/shared/task-status.js";
import type { Task } from "../src/shared/types.js";

function fakeTool(seen: unknown[], extra: Partial<ToolRegistration> = {}): ToolRegistration {
  return {
    name: "read",
    description: "read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    deferred: true,
    execute(args: unknown) {
      seen.push(args);
      return { content: [{ type: "text", text: "ok" }] };
    },
    ...extra,
  } as unknown as ToolRegistration;
}

function task(id: string, patch: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    status: "open",
    parentId: null,
    blockedBy: [],
    createdAt: "2026-10-31T10:00:00.000Z",
    completedAt: null,
    completion: null,
    ...patch,
  };
}

test("no tool advertises piuiTaskId, and a legacy tag is ignored and warned once", async () => {
  const seen: unknown[] = [];
  const tool = withTaskParam(fakeTool(seen));
  const schema = tool.parameters as unknown as {
    properties: Record<string, { type: string }>;
    required: string[];
  };
  assert.equal(TASK_ID_PARAM in schema.properties, false, "the tag is not offered to the model");
  assert.deepEqual(schema.required, ["path"], "the tool's own schema is unchanged");
  assert.equal(tool.deferred, true, "other registration fields survive");

  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    await tool.execute({ path: "a", [TASK_ID_PARAM]: "abcd" } as never, {} as never, {} as never);
    await tool.execute({ path: "c", [TASK_ID_PARAM]: "efgh" } as never, {} as never, {} as never);
    await tool.execute({ path: "b" } as never, {} as never, {} as never);
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(seen, [{ path: "a" }, { path: "c" }, { path: "b" }]);
  assert.deepEqual(warnings, ["[tasks] ignoring piuiTaskId; attribution follows the working task"]);
});

test("prepareArguments runs without the legacy tag", () => {
  const tool = withTaskParam(
    fakeTool([], {
      prepareArguments(args: unknown) {
        assert.equal(TASK_ID_PARAM in (args as object), false);
        return { path: String((args as { file: string }).file) };
      },
    } as Partial<ToolRegistration>),
  );
  assert.deepEqual(tool.prepareArguments?.({ file: "x", [TASK_ID_PARAM]: "t1" }), {
    path: "x",
  });
});

test("a registry installs every extension's tools without the legacy tag", () => {
  const installed: ToolRegistration[][] = [];
  const registry = {
    install(extension: { tools?: readonly ToolRegistration[] }) {
      installed.push([...(extension.tools ?? [])]);
    },
  } as unknown as Registry<ToolRegistration>;
  attributeTools(registry).install({ name: "mcp", tools: [fakeTool([])] } as never);
  const params = installed[0]?.[0]?.parameters as unknown as { properties: object } | undefined;
  const props = params?.properties ?? {};
  assert.equal(TASK_ID_PARAM in props, false);
});

test("a call made while one task is working is charged to it", () => {
  let now = Date.parse("2026-10-31T12:00:00.000Z");
  const tracker = new TaskActivityTracker(undefined, () => now);
  tracker.observeLedger([task("a", { status: "working" }), task("b")]);
  tracker.runStarted();
  assert.equal(tracker.toolStarted("bash", { command: "ls" }), "a");
  now += 60_000;
  tracker.toolEnded("a");
  assert.equal(tracker.toolStarted("read", { path: "x" }), "a");
  tracker.modelCall({
    toolCalls: [{ arguments: { command: "ls" } }, { arguments: { path: "x" } }],
    tokens: 1000,
    cost: 0.02,
  });
  let view = tracker.view();
  assert.equal(view.running, true);
  assert.equal(view.traces.a?.lastRun?.outcome, "running");
  assert.equal(view.traces.a?.measured.activeMs, 60_000, "the live run counts already");
  assert.equal(view.traces.a?.measured.calls, 2);
  assert.equal(view.traces.a?.measured.tokens, 1000);
  assert.equal(view.traces.a?.measured.cost, 0.02);
  assert.equal(view.traces.b?.measured.calls, 0, "the other task is not charged");
  tracker.runEnded();
  view = tracker.view();
  assert.equal(view.running, false);
  assert.equal(view.traces.a?.lastRun?.outcome, "ok");
  assert.equal(view.traces.a?.measured.runs, 1);
  assert.equal(view.traces.a?.measured.calls, 2);
  assert.deepEqual(
    view.traces.a?.history.map((event) => event.kind),
    ["created", "run-start", "run-end"],
  );
});

test("calls are charged to nobody without exactly one working task", () => {
  let now = Date.parse("2026-10-31T12:00:00.000Z");
  const tracker = new TaskActivityTracker(undefined, () => now);
  tracker.observeLedger([task("a"), task("b")]);
  tracker.runStarted();
  // An old tag is ignored: it no longer decides attribution.
  assert.equal(tracker.toolStarted("bash", { command: "ls", [TASK_ID_PARAM]: "a" }), undefined);
  tracker.modelCall({ toolCalls: [{ arguments: { [TASK_ID_PARAM]: "a" } }], tokens: 100, cost: 1 });
  now += 1_000;
  tracker.observeLedger([task("a", { status: "working" }), task("b", { status: "working" })]);
  assert.equal(tracker.toolStarted("bash", { command: "ls" }), undefined);
  tracker.modelCall({ toolCalls: [{ arguments: {} }], tokens: 200, cost: 2 });
  const view = tracker.view();
  for (const id of ["a", "b"]) {
    assert.equal(view.traces[id]?.measured.runs, 0, `${id} has no run`);
    assert.equal(view.traces[id]?.measured.calls, 0, `${id} has no calls`);
    assert.equal(view.traces[id]?.measured.tokens, 0, `${id} has no tokens`);
    assert.equal(view.traces[id]?.measured.cost, 0, `${id} has no cost`);
  }
  tracker.runEnded();
});

test("an attributed call is handed to the ledger recorder at start and end", () => {
  let now = Date.parse("2026-10-31T12:00:00.000Z");
  const seen: Array<[string, number]> = [];
  const tracker = new TaskActivityTracker(
    undefined,
    () => now,
    (id, at) => seen.push([id, at]),
  );
  tracker.observeLedger([task("a", { status: "working" })]);
  tracker.runStarted();
  assert.equal(tracker.toolStarted("bash", {}), "a");
  now += 1_000;
  tracker.toolEnded("a");
  tracker.observeLedger([task("a")]);
  assert.equal(tracker.toolStarted("read", { path: "untagged" }), undefined);
  assert.deepEqual(seen, [
    ["a", Date.parse("2026-10-31T12:00:00.000Z")],
    ["a", Date.parse("2026-10-31T12:00:01.000Z")],
  ]);
});

test("a working task keeps its measured time after it closes", () => {
  let now = Date.parse("2026-10-31T12:00:00.000Z");
  const tracker = new TaskActivityTracker(undefined, () => now);
  const tasks = [task("a", { status: "working" })];
  tracker.observeLedger(tasks);
  tracker.runStarted();
  const taskId = tracker.toolStarted("bash", { command: "npm run build" });
  assert.equal(taskId, "a");
  now += 25 * 60_000;
  let view = tracker.view();
  assert.equal(taskState(tasks, tasks[0] as Task, view), "working", "still inside a call");
  assert.equal(view.traces.a?.measured.activeMs, 25 * 60_000);
  tracker.toolEnded(taskId);
  now += 15 * 60_000;
  view = tracker.view();
  assert.equal(view.traces.a?.measured.activeMs, 25 * 60_000, "silence after the call is not work");
  tracker.runEnded();
  tracker.observeLedger([task("a", { status: "done" })]);
  view = tracker.view();
  assert.equal(view.traces.a?.lastRun?.outcome, "ok");
  assert.equal(view.traces.a?.measured.calls, 1, "closing a task keeps its accounting");
  assert.equal(view.traces.a?.measured.activeMs, 25 * 60_000);
});

test("a failed run marks the tasks it touched, and the ledger adds status history", () => {
  const tracker = new TaskActivityTracker(undefined);
  tracker.observeLedger([task("a", { status: "working" }), task("b", { status: "proposed" })]);
  tracker.runStarted();
  assert.equal(tracker.toolStarted("bash", {}), "a");
  tracker.runFailed("error", "rate limited");
  tracker.runFailed("interrupted", "aborted");
  tracker.runEnded();
  const trace = tracker.view().traces.a;
  assert.equal(trace?.lastRun?.outcome, "error");
  assert.equal(trace?.lastRun?.reason, "rate limited");
  assert.equal(trace?.history.at(-1)?.text, "Run failed: rate limited");

  tracker.observeLedger([task("a", { blockedBy: ["b"] }), task("b")]);
  tracker.observeLedger([task("a", { status: "done" }), task("b")]);
  const view = tracker.view();
  assert.deepEqual(
    view.traces.a?.history.slice(-1).map((event) => event.kind),
    ["done"],
  );
  assert.equal(view.traces.b?.history.at(-1)?.kind, "approved");
  tracker.observeLedger([task("b")]);
  assert.equal(tracker.view().traces.a, undefined, "removed tasks drop their trace");
});

test("a run that was live when pi-ui stopped loads as interrupted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-ui-activity-"));
  try {
    const path = join(dir, "task-activity.json");
    const first = new TaskActivityTracker(path);
    first.observeLedger([task("a", { status: "working" })]);
    first.runStarted();
    first.toolStarted("bash", {});
    await first.flush();
    assert.match(await readFile(path, "utf8"), /"running"/);
    const second = new TaskActivityTracker(path);
    await second.load();
    const trace = second.view().traces.a;
    assert.equal(trace?.lastRun?.outcome, "interrupted");
    assert.equal(trace?.lastRun?.reason, "pi-ui restarted mid-run");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
