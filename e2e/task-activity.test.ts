import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Registry, ToolRegistration } from "@earendil-works/pi-durable";
import { TaskActivityTracker } from "../src/server/task-activity.js";
import {
  attributeTools,
  TASK_ID_PARAM,
  taggedTaskId,
  withTaskParam,
} from "../src/server/task-attribution.js";
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

test("every tool takes an optional piuiTaskId and never sees it", async () => {
  const seen: unknown[] = [];
  const tool = withTaskParam(fakeTool(seen));
  const schema = tool.parameters as unknown as {
    properties: Record<string, { type: string }>;
    required: string[];
  };
  assert.equal(schema.properties[TASK_ID_PARAM]?.type, "string");
  assert.deepEqual(schema.required, ["path"], "the tag stays optional");
  assert.equal(tool.deferred, true, "other registration fields survive");
  await tool.execute({ path: "a", [TASK_ID_PARAM]: "abcd" } as never, {} as never, {} as never);
  await tool.execute({ path: "b" } as never, {} as never, {} as never);
  assert.deepEqual(seen, [{ path: "a" }, { path: "b" }]);
  assert.equal(taggedTaskId({ [TASK_ID_PARAM]: " abcd " }), "abcd");
  assert.equal(taggedTaskId({ [TASK_ID_PARAM]: "" }), undefined);
  assert.equal(taggedTaskId("text"), undefined);
});

test("prepareArguments runs without the tag and gives it back", () => {
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
    [TASK_ID_PARAM]: "t1",
  });
});

test("a registry installs every extension's tools with the tag", () => {
  const installed: ToolRegistration[][] = [];
  const registry = {
    install(extension: { tools?: readonly ToolRegistration[] }) {
      installed.push([...(extension.tools ?? [])]);
    },
  } as unknown as Registry<ToolRegistration>;
  attributeTools(registry).install({ name: "mcp", tools: [fakeTool([])] } as never);
  const params = installed[0]?.[0]?.parameters as unknown as { properties: object } | undefined;
  const props = params?.properties ?? {};
  assert.equal(TASK_ID_PARAM in props, true);
});

test("tagged calls make a task's run, untagged ones count as untracked", () => {
  let now = Date.parse("2026-10-31T12:00:00.000Z");
  const tracker = new TaskActivityTracker(undefined, () => now);
  tracker.observeLedger([task("a"), task("b")]);
  tracker.runStarted();
  tracker.toolStarted("bash", { command: "ls", [TASK_ID_PARAM]: "a" });
  now += 60_000;
  tracker.toolEnded({ [TASK_ID_PARAM]: "a" });
  tracker.toolStarted("read", { path: "x" });
  tracker.modelCall({
    toolCalls: [{ arguments: { [TASK_ID_PARAM]: "a" } }, { arguments: { [TASK_ID_PARAM]: "b" } }],
    tokens: 1000,
    cost: 0.02,
  });
  let view = tracker.view();
  assert.equal(view.running, true);
  assert.equal(view.traces.a?.lastRun?.outcome, "running");
  assert.equal(view.traces.a?.measured.activeMs, 60_000, "the live run counts already");
  assert.equal(view.traces.a?.measured.tokens, 500);
  assert.equal(view.traces.b?.measured.cost, 0.01);
  assert.deepEqual(view.untracked, {
    calls: 1,
    lastAt: "2026-10-31T12:01:00.000Z",
    lastTool: "read",
  });
  tracker.runEnded();
  view = tracker.view();
  assert.equal(view.running, false);
  assert.equal(view.untracked, null);
  assert.equal(view.traces.a?.lastRun?.outcome, "ok");
  assert.equal(view.traces.a?.measured.runs, 1);
  assert.equal(view.traces.a?.measured.calls, 1);
  assert.deepEqual(
    view.traces.a?.history.map((event) => event.kind),
    ["created", "run-start", "run-end"],
  );
});

test("a failed run marks the tasks it touched, and the ledger adds status history", () => {
  const tracker = new TaskActivityTracker(undefined);
  tracker.observeLedger([task("a"), task("b", { status: "proposed" })]);
  tracker.runStarted();
  tracker.toolStarted("bash", { [TASK_ID_PARAM]: "a" });
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
    first.observeLedger([task("a")]);
    first.runStarted();
    first.toolStarted("bash", { [TASK_ID_PARAM]: "a" });
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
