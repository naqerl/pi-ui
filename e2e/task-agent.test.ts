import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { StreamHub } from "../src/server/stream-hub.js";
import {
  createTaskEditTool,
  isTaskAgentToolName,
  openingTaskPatch,
  selectTaskAgentTools,
  TASK_AGENT_TOOL_NAMES,
  TaskAgentManager,
  type TaskAgentSession,
  taskAgentInstructions,
  visibleTaskAgentMessages,
} from "../src/server/task-agent.js";
import { TaskStore } from "../src/server/tasks.js";
import { DEFAULT_NEW_TASK_TITLE } from "../src/shared/tasks.js";
import type { ChatMessage, RunState, TaskLedger } from "../src/shared/types.js";

let directory = "";
let store: TaskStore;
let published: TaskLedger[] = [];

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-ui-task-agent-"));
  store = new TaskStore(join(directory, "tasks.json"));
  await store.load();
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("task agents may only call bash, read, edit_task and the question tools", () => {
  const coding = (createCodingTools().tools ?? []).map((tool) => ({ name: tool.name }));
  const extras = [
    ...coding,
    { name: "edit_task" },
    { name: "ask_questions" },
    { name: "append_questions" },
    { name: "write" },
    { name: "edit" },
    { name: "task_edit" },
    { name: "task_working" },
    { name: "draw_diagram" },
  ];
  assert.deepEqual(
    selectTaskAgentTools(extras)
      .map((tool) => tool.name)
      .sort(),
    [...TASK_AGENT_TOOL_NAMES].sort(),
  );
  assert.equal(isTaskAgentToolName("bash"), true);
  assert.equal(isTaskAgentToolName("write"), false);
  assert.equal(isTaskAgentToolName("task_edit"), false);
});

test("the plan-mode prompt forbids edits and names the edit_task tool", () => {
  const prompt = taskAgentInstructions("base prompt", {
    id: "abcd",
    title: "Ship the release",
    project: "pi-ui",
    body: "Write a design.",
  });
  assert.match(prompt, /plan mode/i);
  assert.match(prompt, /must not edit/i);
  assert.match(prompt, /edit_task/);
  assert.match(prompt, /abcd/);
  assert.match(prompt, /Ship the release/);
  assert.doesNotMatch(prompt, /task_working/);
});

test("edit_task updates this task's title, body and project", async () => {
  published = [];
  const ledger = await store.create("Draft the plan", null);
  const task = ledger.tasks.find((item) => item.title === "Draft the plan");
  assert.ok(task);
  const tool = createTaskEditTool({
    taskId: task.id,
    store,
    publish: (next) => {
      published.push(next);
    },
  });
  assert.equal(tool.name, "edit_task");

  const other = (await store.create("Leave me alone", null, [], "other")).tasks.find(
    (item) => item.title === "Leave me alone",
  );
  assert.ok(other);

  const result = await tool.execute(
    {
      title: "Write the design",
      body: "Use a queue.\n\n```mermaid\nflowchart LR\n  A-->B\n```",
      project: "pi-ui",
    } as never,
    {} as never,
    {} as never,
  );
  assert.equal(result.isError === true, false);
  const text = result.output?.find((part) => part.type === "text");
  assert.ok(text && text.type === "text");
  assert.match(text.text, /Write the design/);
  assert.match(text.text, /pi-ui/);
  const next = store.ledger().tasks.find((item) => item.id === task.id);
  assert.equal(next?.title, "Write the design");
  assert.equal(next?.project, "pi-ui");
  assert.match(next?.body ?? "", /Use a queue/);
  assert.equal(published.length, 1);
  assert.equal(store.ledger().tasks.find((item) => item.id === other.id)?.title, "Leave me alone");
  assert.equal(store.ledger().tasks.find((item) => item.id === other.id)?.project, "other");
});

test("edit_task cannot target another task and rejects an empty patch", async () => {
  const task = (await store.create("Stay put", null)).tasks.find(
    (item) => item.title === "Stay put",
  );
  assert.ok(task);
  const tool = createTaskEditTool({
    taskId: task.id,
    store,
    publish: () => undefined,
  });
  const empty = await tool.execute({} as never, {} as never, {} as never);
  assert.equal(empty.isError, true);
  const missing = createTaskEditTool({
    taskId: "nope",
    store,
    publish: () => undefined,
  });
  const unknown = await missing.execute({ title: "Nope" } as never, {} as never, {} as never);
  assert.equal(unknown.isError, true);
  assert.equal(store.ledger().tasks.find((item) => item.id === task.id)?.title, "Stay put");
});

test("the first message on a placeholder task sets the title and strips @project", () => {
  const first = openingTaskPatch(
    { title: DEFAULT_NEW_TASK_TITLE },
    "@pi-ui Design the inbox\nwith two lines",
    ["pi-ui"],
  );
  assert.equal(first.title, "Design the inbox");
  assert.equal(first.project, "pi-ui");
  assert.equal(first.message, "Design the inbox\nwith two lines");

  const follow = openingTaskPatch(
    { title: "Design the inbox", project: "pi-ui" },
    "@citydiff Also consider this",
    ["pi-ui", "citydiff"],
  );
  assert.equal(follow.title, undefined);
  assert.equal(follow.project, "citydiff");
  assert.equal(follow.message, "Also consider this");
});

test("visible task chat rows omit notice and keep ordinary messages", () => {
  const rows: ChatMessage[] = [
    { id: "u", role: "user", text: "hello", timestamp: "", order: 1 },
    {
      id: "n",
      role: "user",
      text: "notice",
      timestamp: "",
      order: 2,
      notice: { kind: "job" },
    } as ChatMessage,
    { id: "a", role: "assistant", text: "plan", timestamp: "", order: 3 },
  ];
  assert.deepEqual(
    visibleTaskAgentMessages(rows).map((item) => item.id),
    ["u", "a"],
  );
});

class FakeSession implements TaskAgentSession {
  closed = false;
  stopped = 0;
  submitted: string[] = [];
  attachments: string[][] = [];
  readonly hub = new StreamHub();
  run: RunState = "idle";

  constructor(readonly taskId: string) {}

  running(): boolean {
    return this.run === "running";
  }

  async snapshot() {
    return {
      taskId: this.taskId,
      messages: this.submitted.map((text, index) => ({
        id: `u-${index}`,
        role: "user" as const,
        text,
        timestamp: new Date().toISOString(),
        order: index,
      })),
      run: this.run,
      draft: { text: "", thinking: "", revision: 0 },
      questions: null,
    };
  }

  async submit(text: string, attachments: string[] = []) {
    this.submitted.push(text);
    this.attachments.push(attachments);
    this.run = "running";
    return this.snapshot();
  }

  async stop() {
    this.stopped += 1;
    this.run = "idle";
  }

  async close() {
    this.closed = true;
    this.run = "idle";
  }

  replayFrames() {
    return [];
  }
}

test("the agent session is created on first use, stopped when the task is done, and removed when the task is deleted", async () => {
  const fakes = new Map<string, FakeSession>();
  const manager = new TaskAgentManager({
    dataDir: directory,
    cwd: directory,
    models: {} as never,
    model: undefined,
    store,
    publish: () => undefined,
    baseInstructions: "base",
    openSession: async (taskId) => {
      const session = new FakeSession(taskId);
      fakes.set(taskId, session);
      return session;
    },
  });

  const created = (await store.create(DEFAULT_NEW_TASK_TITLE, null)).tasks.find(
    (item) => item.title === DEFAULT_NEW_TASK_TITLE,
  );
  assert.ok(created);

  const snapshot = await manager.submit(created.id, "@alpha Draft a login flow");
  const fake = fakes.get(created.id);
  assert.ok(fake);
  assert.deepEqual(fake.submitted, ["Draft a login flow"]);
  assert.equal(fake.running(), true);
  assert.equal(
    store.ledger().tasks.find((item) => item.id === created.id)?.title,
    "Draft a login flow",
  );
  assert.equal(store.ledger().tasks.find((item) => item.id === created.id)?.project, "alpha");
  assert.equal(snapshot.messages.at(-1)?.text, "Draft a login flow");

  await manager.stopRun(created.id);
  assert.equal(fake.stopped, 1);
  assert.equal(fake.running(), false);
  assert.equal(fake.closed, false);

  // A second ensure reuses the live session.
  const same = await manager.ensure(created.id);
  assert.equal(same, fake);

  await manager.remove(created.id);
  assert.equal(fake.closed, true);

  const { access } = await import("node:fs/promises");
  await assert.rejects(access(manager.taskDir(created.id)));

  await store.remove(created.id);
  await manager.close();
});

test("the manager forwards image attachments to the task agent session", async () => {
  const fakes = new Map<string, FakeSession>();
  const manager = new TaskAgentManager({
    dataDir: directory,
    cwd: directory,
    models: {} as never,
    model: undefined,
    store,
    publish: () => undefined,
    baseInstructions: "base",
    openSession: async (taskId) => {
      const session = new FakeSession(taskId);
      fakes.set(taskId, session);
      return session;
    },
  });

  const created = (await store.create("Plan the screenshot review", null)).tasks.find(
    (item) => item.title === "Plan the screenshot review",
  );
  assert.ok(created);

  const snapshot = await manager.submit(created.id, "look at this", ["media-1"]);
  const fake = fakes.get(created.id);
  assert.ok(fake);
  assert.deepEqual(fake.submitted, ["look at this"]);
  assert.deepEqual(fake.attachments, [["media-1"]]);
  assert.equal(snapshot.messages.at(-1)?.text, "look at this");

  const imageOnly = await manager.submit(created.id, "  ", ["media-2"]);
  assert.deepEqual(fake.submitted, ["look at this", ""]);
  assert.deepEqual(fake.attachments, [["media-1"], ["media-2"]]);
  assert.equal(imageOnly.messages.at(-1)?.text, "");

  await manager.close();
});
