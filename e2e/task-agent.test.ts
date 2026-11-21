import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createModels } from "@earendil-works/pi-ai";
import type { EntryRecord, SubmissionDraft } from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { createJobTools } from "../src/server/job-tools.js";
import { MediaStore } from "../src/server/media.js";
import { SnapshotCache, SnapshotController } from "../src/server/memory/snapshot.js";
import { MemoryStore } from "../src/server/memory/store.js";
import { createMemoryTools } from "../src/server/memory/tools.js";
import { RunMarkerStore } from "../src/server/run-marker.js";
import {
  buildTranscript,
  JOB_NOTICE_ENTRY_KIND,
  SESSION_CONTEXT,
  TASK_ATTACHMENTS_ENTRY_KIND,
} from "../src/server/session.js";
import type { SseFrame } from "../src/server/sse.js";
import { StreamHub } from "../src/server/stream-hub.js";
import {
  createPlanPromptBuilder,
  createTaskEditTool,
  DurableTaskAgentSession,
  derivePlanningTaskIds,
  isTaskAgentToolName,
  openingTaskPatch,
  planPromptFingerprint,
  selectTaskAgentMemoryTools,
  selectTaskAgentTools,
  syncTaskAttachments,
  TASK_AGENT_MEMORY_TOOL_NAMES,
  TASK_AGENT_TOOL_NAMES,
  TaskAgentManager,
  type TaskAgentSession,
  taskAgentHarnessSettings,
  taskAgentInstructions,
  taskAgentMemoryBase,
  taskAgentProjectInstructions,
  visibleTaskAgentMessages,
} from "../src/server/task-agent.js";
import { TaskStore } from "../src/server/tasks.js";
import { mergeQueuedNotices } from "../src/shared/queue.js";
import { runErrorFromUnanswered, runErrorMatchesDismissal } from "../src/shared/run-error.js";
import { DEFAULT_NEW_TASK_TITLE } from "../src/shared/tasks.js";
import type { ChatMessage, RunState, StreamRunState, TaskLedger } from "../src/shared/types.js";

let directory = "";
let store: TaskStore;
let published: TaskLedger[] = [];
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-ui-task-agent-"));
  store = new TaskStore(join(directory, "tasks.json"));
  await store.load();
  // Keep project-guidance tests hermetic: no developer ~/.pi/agent/AGENTS.md.
  const agentDir = join(directory, "agent");
  await mkdir(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
});

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(directory, { recursive: true, force: true });
});

test("task agents may only call bash, read, edit_task, propose_task, the question tools and memory", () => {
  const coding = (createCodingTools().tools ?? []).map((tool) => ({ name: tool.name }));
  const memory = createMemoryTools({} as never).map((tool) => ({ name: tool.name }));
  const jobTools = createJobTools({} as never).map((tool) => ({ name: tool.name }));
  const extras = [
    ...coding,
    ...memory,
    ...jobTools,
    { name: "edit_task" },
    { name: "propose_task" },
    { name: "ask_questions" },
    { name: "append_questions" },
    { name: "write" },
    { name: "edit" },
    { name: "task_done" },
    { name: "task_working" },
    { name: "task_release" },
    { name: "task_block" },
    { name: "task_edit" },
    { name: "draw_diagram" },
  ];
  assert.deepEqual(
    selectTaskAgentTools(extras)
      .map((tool) => tool.name)
      .sort(),
    [...TASK_AGENT_TOOL_NAMES].sort(),
  );
  assert.equal(TASK_AGENT_TOOL_NAMES.length, 14);
  assert.deepEqual([...TASK_AGENT_TOOL_NAMES].sort(), [
    "append_questions",
    "ask_questions",
    "bash",
    "edit_task",
    "job_cancel",
    "job_list",
    "job_output",
    "memory_find",
    "memory_grep",
    "memory_read",
    "memory_status",
    "memory_write",
    "propose_task",
    "read",
  ]);
  assert.deepEqual([...TASK_AGENT_MEMORY_TOOL_NAMES].sort(), [
    "memory_find",
    "memory_grep",
    "memory_read",
    "memory_status",
    "memory_write",
  ]);
  assert.deepEqual(
    selectTaskAgentMemoryTools(memory)
      .map((tool) => tool.name)
      .sort(),
    [...TASK_AGENT_MEMORY_TOOL_NAMES].sort(),
  );
  assert.ok(TASK_AGENT_TOOL_NAMES.includes("propose_task"));
  assert.equal(TASK_AGENT_TOOL_NAMES.includes("memory_write"), true);
  assert.deepEqual(
    selectTaskAgentTools([{ name: "memory_write" }]).map((tool) => tool.name),
    ["memory_write"],
  );
  assert.deepEqual(selectTaskAgentTools([{ name: "memory_dream" }]), []);
  for (const forbidden of [
    "task_done",
    "task_working",
    "task_release",
    "task_block",
    "task_edit",
    "memory_dream",
    "write",
    "edit",
  ]) {
    assert.equal(TASK_AGENT_TOOL_NAMES.includes(forbidden as never), false);
    assert.equal(isTaskAgentToolName(forbidden), false);
  }
  assert.equal(isTaskAgentToolName("bash"), true);
  assert.equal(isTaskAgentToolName("write"), false);
  assert.equal(isTaskAgentToolName("propose_task"), true);
  assert.equal(isTaskAgentToolName("task_edit"), false);
  assert.equal(isTaskAgentToolName("memory_read"), true);
  assert.equal(isTaskAgentToolName("memory_status"), true);
  assert.equal(isTaskAgentToolName("memory_write"), true);
  assert.equal(isTaskAgentToolName("memory_dream"), false);
});

test("a plan job notice never opens a session, and reaches a live one", async () => {
  let opened = 0;
  const sessions = new Map<string, FakeSession>();
  const manager = new TaskAgentManager({
    dataDir: directory,
    cwd: directory,
    models: {} as never,
    model: undefined,
    store,
    publish: () => undefined,
    baseInstructions: "base",
    openSession: async (taskId) => {
      opened += 1;
      const session = new FakeSession(taskId);
      sessions.set(taskId, session);
      return session;
    },
  });
  const task = (await store.create("Job notice routing", null)).tasks.find(
    (item) => item.title === "Job notice routing",
  );
  assert.ok(task);

  assert.equal(await manager.submitJobNotice(task.id, "closed pane"), false);
  assert.equal(opened, 0, "a closed pane is not opened to deliver a notice");

  await manager.ensure(task.id);
  const session = sessions.get(task.id);
  assert.ok(session);
  assert.equal(opened, 1);
  assert.equal(await manager.submitJobNotice(task.id, "live pane"), true);
  assert.deepEqual(session.jobNotices, ["live pane"]);

  await manager.remove(task.id);
  assert.equal(await manager.submitJobNotice(task.id, "closed again"), false);
  await store.remove(task.id);
  await manager.close();
});

test("the plan memory tools share the store the chat agent writes", async () => {
  const memoryStore = new MemoryStore(join(directory, "plan-write-memory"));
  await memoryStore.ensure();
  const marker = `plan-memory-${Date.now()}`;
  const chat = new Map(createMemoryTools(memoryStore).map((tool) => [tool.name, tool]));
  const write = chat.get("memory_write");
  assert.ok(write);
  const result = await write.execute(
    {
      target: "long_term",
      topic: "plan-decision",
      scope: "projects",
      body: `# Plan decision\n\n${marker}`,
    } as never,
    {} as never,
    {} as never,
  );
  assert.equal(result.isError === true, false);

  // The plan registry shares the store and carries memory_write plus the readers.
  const plan = new Map(
    selectTaskAgentTools(createMemoryTools(memoryStore, new SnapshotCache())).map((tool) => [
      tool.name,
      tool,
    ]),
  );
  assert.equal(plan.has("memory_write"), true);
  assert.equal(plan.has("memory_dream"), false);
  const read = plan.get("memory_read");
  assert.ok(read);
  const readResult = await read.execute(
    { path: "topics/projects/plan-decision.md" } as never,
    {} as never,
    {} as never,
  );
  const text = readResult.output?.find((part) => part.type === "text");
  assert.ok(text && text.type === "text");
  assert.match(text.text, new RegExp(marker));

  const status = plan.get("memory_status");
  assert.ok(status);
  const statusResult = await status.execute({} as never, {} as never, {} as never);
  const statusText = statusResult.output?.find((part) => part.type === "text");
  assert.ok(statusText && statusText.type === "text");
  assert.match(statusText.text, /topics: 1/);
});

test("building a fresh plan block leaves the chat snapshot cache alone", async () => {
  const memoryStore = new MemoryStore(join(directory, "plan-cache-isolation"));
  await memoryStore.ensure();
  await memoryStore.atomicWrite(memoryStore.memoryFile, "# MEMORY\n\n- chat block\n");
  const shared = new SnapshotCache();
  const chatBlock = await shared.get(memoryStore, "first_turn");
  await memoryStore.appendScratchpad("plan-only scratchpad item");

  const plan = await taskAgentMemoryBase(
    "BASE INSTRUCTIONS",
    { store: memoryStore, snapshot: shared },
    { fresh: true },
  );
  assert.match(plan, /plan-only scratchpad item/);

  // The plan build reads the files itself; the chat's cached prefix must survive.
  assert.equal(await shared.get(memoryStore, "first_turn"), chatBlock);
  assert.doesNotMatch(chatBlock, /plan-only scratchpad item/);
});

test("the current project guidance replaces the boot-time block and follows override rules", async () => {
  const project = join(directory, "plan-current-agents");
  await mkdir(project, { recursive: true });
  const newMarker = `current-guidance-${Date.now()}`;
  const oldMarker = `stale-guidance-${Date.now()}`;
  const agentsPath = join(project, "AGENTS.md");
  await writeFile(agentsPath, `# AGENTS.md\n\n- ${newMarker}\n`, "utf8");
  const bootBase = `BASE INSTRUCTIONS\n\n<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="${agentsPath}">\n# AGENTS.md\n\n- ${oldMarker}\n</project_instructions>\n</project_context>`;

  const current = await taskAgentMemoryBase(bootBase, undefined, { cwd: project });
  assert.doesNotMatch(current, new RegExp(oldMarker));
  assert.match(current, new RegExp(newMarker));
  assert.equal((current.match(new RegExp(newMarker, "g")) ?? []).length, 1);

  const overrideMarker = `override-guidance-${Date.now()}`;
  await writeFile(
    join(project, "AGENTS.override.md"),
    `# AGENTS.override.md\n\n- ${overrideMarker}\n`,
    "utf8",
  );
  const overridden = await taskAgentMemoryBase(bootBase, undefined, { cwd: project });
  assert.match(overridden, new RegExp(overrideMarker));
  assert.doesNotMatch(overridden, new RegExp(newMarker));
});

test("the chat agent keeps its own memory tools and plain instructions", async () => {
  const names = createMemoryTools({} as never).map((tool) => tool.name);
  assert.deepEqual(names, [
    "memory_write",
    "memory_read",
    "memory_grep",
    "memory_find",
    "memory_dream",
    "memory_status",
  ]);

  const chatBase = "You are the main chat agent for pi-ui.";
  assert.equal(await taskAgentMemoryBase(chatBase, undefined), chatBase);
  assert.doesNotMatch(chatBase, /plan mode/i);
  assert.match(
    taskAgentInstructions(chatBase, {
      id: "chat",
      title: "Only the plan prompt changes",
      project: "pi-ui",
      body: "",
    }),
    /plan mode/i,
  );
});

test("a new plan session reads current memory and the project AGENTS.md", async () => {
  const memoryStore = new MemoryStore(join(directory, "plan-current-memory"));
  await memoryStore.ensure();
  const project = join(directory, "plan-current-project");
  await mkdir(project, { recursive: true });
  const projectMarker = `project-guidance-${Date.now()}`;
  await writeFile(join(project, "AGENTS.md"), `# AGENTS.md\n\n- ${projectMarker}\n`, "utf8");

  // Prime the cache the way boot does, then prove a session does not trust it.
  const cache = new SnapshotCache();
  await memoryStore.atomicWrite(memoryStore.memoryFile, "# MEMORY\n\n- old note\n");
  await cache.get(memoryStore, "first_turn");

  const task = {
    id: "mem2",
    title: "Use current memory",
    project: "pi-ui",
    body: "Plan with today's note.",
  };
  const before = await taskAgentMemoryBase(
    "BASE INSTRUCTIONS",
    { store: memoryStore, snapshot: cache },
    { cwd: project },
  );
  assert.doesNotMatch(before, /new note after boot/);
  assert.match(before, new RegExp(projectMarker));

  const marker = "new note after boot";
  await memoryStore.appendScratchpad(marker);

  // A session that existed before the write still sees the old block until its
  // refresh runs; a session created afterwards reads the files as they are now.
  const stale = await taskAgentMemoryBase(
    "BASE INSTRUCTIONS",
    { store: memoryStore, snapshot: cache },
    { cwd: project, fresh: false },
  );
  assert.doesNotMatch(stale, new RegExp(marker));
  const after = await taskAgentMemoryBase(
    "BASE INSTRUCTIONS",
    { store: memoryStore, snapshot: cache },
    { cwd: project },
  );
  assert.match(after, new RegExp(marker));
  assert.match(taskAgentInstructions(after, task), new RegExp(marker));
});

test("the current project AGENTS.md is optional and included", async () => {
  const project = join(directory, "plan-agents-only");
  await mkdir(project, { recursive: true });
  assert.equal(await taskAgentProjectInstructions(project), undefined);
  const marker = `agents-guidance-${Date.now()}`;
  await writeFile(join(project, "AGENTS.md"), `# AGENTS.md\n\n- ${marker}\n`, "utf8");
  const loaded = await taskAgentProjectInstructions(project);
  assert.ok(loaded);
  assert.match(loaded, new RegExp(marker));

  const base = await taskAgentMemoryBase("BASE INSTRUCTIONS", undefined, { cwd: project });
  assert.match(base, new RegExp(marker));
  assert.match(base, /<project_instructions/);
  assert.match(
    taskAgentInstructions(base, { id: "a1", title: "AGENTS", project: "pi-ui", body: "" }),
    /AGENTS\.md/,
  );
});

test("a plan refresh rebuilds the existing session without touching the chat cache", async () => {
  const memoryStore = new MemoryStore(join(directory, "plan-refresh-memory"));
  await memoryStore.ensure();
  const beforeMarker = `before-plan-refresh-${Date.now()}`;
  await memoryStore.atomicWrite(
    memoryStore.memoryFile,
    `# MEMORY\n\n- ${beforeMarker} is already known.\n`,
  );
  const shared = new SnapshotCache();
  const chatBlock = await shared.get(memoryStore, "first_turn");

  const fakes = new Map<string, FakeSession>();
  const manager = new TaskAgentManager({
    dataDir: directory,
    cwd: directory,
    models: {} as never,
    model: undefined,
    store,
    publish: () => undefined,
    baseInstructions: "BASE",
    memory: { store: memoryStore, snapshot: shared },
    openSession: async (taskId) => {
      const session = new FakeSession(taskId);
      fakes.set(taskId, session);
      return session;
    },
  });

  const task = (await store.create("Refresh the plan prompt", null)).tasks.find(
    (item) => item.title === "Refresh the plan prompt",
  );
  assert.ok(task);
  await manager.ensure(task.id);
  const session = fakes.get(task.id);
  assert.ok(session);

  // The session starts with the block as it was before the write.
  await manager.refreshInstructions(task.id, true);
  const initial = session.instructions.at(-1);
  assert.ok(initial);
  assert.match(initial, new RegExp(beforeMarker));

  const marker = `after-plan-refresh-${Date.now()}`;
  await memoryStore.appendScratchpad(marker);
  assert.deepEqual(
    manager
      .planMemoryTools(task.id)
      .map((tool) => tool.name)
      .sort(),
    [...TASK_AGENT_MEMORY_TOOL_NAMES].sort(),
  );
  await manager.refreshInstructions(task.id, true);

  // The same session was refreshed, while the chat cache stayed put.
  assert.equal(session.instructions.length, 2);
  const refreshed = session.instructions.at(-1);
  assert.ok(refreshed);
  assert.match(refreshed, new RegExp(marker));
  assert.equal(await shared.get(memoryStore, "first_turn"), chatBlock);
  assert.doesNotMatch(chatBlock, new RegExp(marker));

  await manager.close();
});

test("a plan write refreshes the existing session without touching the chat cache", async () => {
  const memoryStore = new MemoryStore(join(directory, "plan-refresh-memory"));
  await memoryStore.ensure();
  const beforeMarker = `before-plan-write-${Date.now()}`;
  await memoryStore.atomicWrite(
    memoryStore.memoryFile,
    `# MEMORY\n\n- ${beforeMarker} is already known.\n`,
  );
  const shared = new SnapshotCache();
  const chatBlock = await shared.get(memoryStore, "first_turn");

  const fakes = new Map<string, FakeSession>();
  const manager = new TaskAgentManager({
    dataDir: directory,
    cwd: directory,
    models: {} as never,
    model: undefined,
    store,
    publish: () => undefined,
    baseInstructions: "BASE",
    memory: { store: memoryStore, snapshot: shared },
    openSession: async (taskId) => {
      const session = new FakeSession(taskId);
      fakes.set(taskId, session);
      return session;
    },
  });

  const task = (await store.create("Refresh the plan prompt", null)).tasks.find(
    (item) => item.title === "Refresh the plan prompt",
  );
  assert.ok(task);
  await manager.ensure(task.id);
  const session = fakes.get(task.id);
  assert.ok(session);

  // The session starts with the block as it was before the write.
  await manager.refreshInstructions(task.id, true);
  const initial = session.instructions.at(-1);
  assert.ok(initial);
  assert.match(initial, new RegExp(beforeMarker));

  const marker = `after-plan-write-${Date.now()}`;
  const tools = new Map(manager.planMemoryTools(task.id).map((tool) => [tool.name, tool]));
  const write = tools.get("memory_write");
  assert.ok(write);
  await write.execute({ target: "scratchpad", body: marker } as never, {} as never, {} as never);

  // The same session was refreshed by the write, while the chat cache stayed put.
  assert.equal(session.instructions.length, 2);
  const refreshed = session.instructions.at(-1);
  assert.ok(refreshed);
  assert.match(refreshed, new RegExp(marker));
  assert.equal(await shared.get(memoryStore, "first_turn"), chatBlock);
  assert.doesNotMatch(chatBlock, new RegExp(marker));

  await manager.close();
});

test("a long-term plan write invalidates the shared cache and reaches the main instructions", async () => {
  const memoryStore = new MemoryStore(join(directory, "plan-long-term-memory"));
  await memoryStore.ensure();
  await memoryStore.atomicWrite(memoryStore.memoryFile, "# MEMORY\n\n- main rule\n");
  const shared = new SnapshotCache();
  const applied: string[] = [];
  const mainMemory = new SnapshotController(
    memoryStore,
    "MAIN BASE",
    async (next) => {
      applied.push(next);
    },
    shared,
  );
  await mainMemory.refresh("first_turn");
  assert.equal(applied.length, 1);
  const before = memoryStore.checkpoint;

  const fakes = new Map<string, FakeSession>();
  const manager = new TaskAgentManager({
    dataDir: directory,
    cwd: directory,
    models: {} as never,
    model: undefined,
    store,
    publish: () => undefined,
    baseInstructions: "BASE",
    memory: { store: memoryStore, snapshot: shared },
    openSession: async (taskId) => {
      const session = new FakeSession(taskId);
      fakes.set(taskId, session);
      return session;
    },
  });
  const task = (await store.create("Plan a long-term memory write", null)).tasks.find(
    (item) => item.title === "Plan a long-term memory write",
  );
  assert.ok(task);
  await manager.ensure(task.id);
  const tools = new Map(manager.planMemoryTools(task.id).map((tool) => [tool.name, tool]));
  const write = tools.get("memory_write");
  assert.ok(write);
  const marker = `plan-long-term-${Date.now()}`;
  const result = await write.execute(
    {
      target: "long_term",
      topic: "plan-long-term",
      scope: "projects",
      body: `# Plan long-term decision\n\n${marker}`,
    } as never,
    {} as never,
    {} as never,
  );
  assert.equal(result.isError === true, false);
  assert.equal(memoryStore.checkpoint, before + 1);
  assert.equal(shared.built, false, "the shared snapshot must be invalidated");

  // The main conversation gets the written topic body on its next turn, without a chip.
  const next = await mainMemory.refresh();
  assert.match(next, new RegExp(marker));
  assert.match(applied.at(-1) ?? "", new RegExp(marker));
  await manager.close();
});

test("the plan prompt carries the same snapshot block as the main chat", async () => {
  const memoryStore = new MemoryStore(join(directory, "plan-memory"));
  await memoryStore.ensure();
  const marker = `plan-snapshot-${Date.now()}`;
  await memoryStore.atomicWrite(
    memoryStore.memoryFile,
    `# MEMORY\n\n## Standing rules\n\n- ${marker} is the known trap.\n`,
  );
  const base = await taskAgentMemoryBase("BASE INSTRUCTIONS", {
    store: memoryStore,
    snapshot: new SnapshotCache(),
  });
  const prompt = taskAgentInstructions(base, {
    id: "mem1",
    title: "Use memory",
    project: "pi-ui",
    body: "Plan with the trap in mind.",
  });
  assert.match(prompt, new RegExp(marker));
  assert.ok(prompt.indexOf("BASE INSTRUCTIONS") < prompt.indexOf(marker));
  assert.match(prompt, /Memory snapshot \(first_turn\)/);
  assert.match(prompt, /memory_find.*memory_grep.*memory_read.*memory_status/s);
  assert.match(prompt, /memory_write/);
  assert.doesNotMatch(prompt, /memory_dream/);
  assert.match(prompt, /Memory and skills/);
  assert.match(prompt, /one write you may make/);
  assert.match(prompt, /skills-meta/);
  assert.match(prompt, /\/home\/pi\/\.agents\/skills/);
  assert.match(prompt, /AGENTS\.md/);
});

test("the plan prompt fingerprint rebuilds when a skill is added", async () => {
  const home = join(directory, "plan-fingerprint-home");
  const agent = join(directory, "plan-fingerprint-agent");
  const project = join(directory, "plan-fingerprint-project");
  await mkdir(join(home, ".agents", "skills"), { recursive: true });
  await mkdir(agent, { recursive: true });
  await mkdir(project, { recursive: true });
  let builds = 0;
  const builder = createPlanPromptBuilder({
    cwd: project,
    buildBase: async () => `BASE ${++builds}`,
    memoryEnabled: false,
    fingerprint: () => planPromptFingerprint(project, { homeDir: home, agentDir: agent }),
  });

  assert.match(await builder(), /BASE 1$/);
  assert.match(await builder(), /BASE 1$/);
  assert.equal(builds, 1);

  const skillDir = join(home, ".agents", "skills", "inbox");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    "---\nname: inbox\ndescription: Handle the inbox.\n---\n\n# Inbox\n",
    "utf8",
  );

  assert.match(await builder(), /BASE 2/);
  assert.match(await builder(), /BASE 2/);
  assert.equal(builds, 2);
});

test("the plan prompt builder picks up memory written after the first session", async () => {
  const memoryStore = new MemoryStore(join(directory, "plan-builder-memory"));
  await memoryStore.ensure();
  const beforeMarker = `builder-before-${Date.now()}`;
  const afterMarker = `builder-after-${Date.now()}`;
  await memoryStore.atomicWrite(memoryStore.memoryFile, `# MEMORY\n\n- ${beforeMarker}\n`);
  const builder = createPlanPromptBuilder({
    cwd: directory,
    buildBase: async () => "BASE INSTRUCTIONS",
    memory: { store: memoryStore },
    memoryEnabled: true,
    fingerprint: async () => "stable",
  });

  const first = await builder();
  assert.match(first, new RegExp(beforeMarker));
  assert.doesNotMatch(first, new RegExp(afterMarker));

  await memoryStore.appendScratchpad(afterMarker);
  const second = await builder();
  assert.match(second, new RegExp(afterMarker));
});

test("the plan prompt fingerprint follows skill and guidance changes", async () => {
  const project = join(directory, "fingerprint-project");
  const agentDir = join(directory, "fingerprint-agent");
  const homeDir = join(directory, "fingerprint-home");
  await mkdir(project, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await writeFile(join(project, "AGENTS.md"), "# AGENTS.md\n\n- first rule\n", "utf8");

  const baseline = await planPromptFingerprint(project, { agentDir, homeDir });
  let builds = 0;
  const builder = createPlanPromptBuilder({
    cwd: project,
    buildBase: async () => `BASE ${++builds}`,
    memoryEnabled: false,
    fingerprint: () => planPromptFingerprint(project, { agentDir, homeDir }),
  });
  assert.match(await builder(), /BASE 1/);
  assert.match(await builder(), /BASE 1/);
  assert.equal(builds, 1);

  const skillDir = join(homeDir, ".agents", "skills", "demo");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "# Demo\n\n- one line\n", "utf8");
  const added = await planPromptFingerprint(project, { agentDir, homeDir });
  assert.notEqual(added, baseline);
  assert.match(await builder(), /BASE 2/);
  assert.equal(builds, 2);

  await writeFile(join(skillDir, "SKILL.md"), "# Demo\n\n- a changed, longer line\n", "utf8");
  const edited = await planPromptFingerprint(project, { agentDir, homeDir });
  assert.notEqual(edited, added);

  await writeFile(join(project, "AGENTS.md"), "# AGENTS.md\n\n- a newer rule\n", "utf8");
  const guidance = await planPromptFingerprint(project, { agentDir, homeDir });
  assert.notEqual(guidance, edited);
});

test("PI_PLAN_MEMORY=0 drops the snapshot and every memory tool", async () => {
  const memoryStore = new MemoryStore(join(directory, "plan-memory-off"));
  await memoryStore.ensure();
  await memoryStore.atomicWrite(memoryStore.memoryFile, "# MEMORY\n\n- hidden while off\n");
  const fakes = new Map<string, FakeSession>();
  const manager = new TaskAgentManager({
    dataDir: directory,
    cwd: directory,
    models: {} as never,
    model: undefined,
    store,
    publish: () => undefined,
    baseInstructions: "BASE",
    memory: { store: memoryStore, snapshot: new SnapshotCache() },
    openSession: async (taskId) => {
      const session = new FakeSession(taskId);
      fakes.set(taskId, session);
      return session;
    },
  });
  const task = (await store.create("Plan without memory", null)).tasks.find(
    (item) => item.title === "Plan without memory",
  );
  assert.ok(task);
  const previous = process.env.PI_PLAN_MEMORY;
  process.env.PI_PLAN_MEMORY = "0";
  try {
    assert.deepEqual(manager.planMemoryTools(task.id), []);
    await manager.ensure(task.id);
    await manager.refreshInstructions(task.id, true);
    const instructions = fakes.get(task.id)?.instructions.at(-1);
    assert.ok(instructions);
    assert.doesNotMatch(instructions, /Memory snapshot/);
    assert.doesNotMatch(instructions, /hidden while off/);
    assert.doesNotMatch(
      instructions,
      /memory_read|memory_grep|memory_find|memory_status|memory_write/,
    );
    assert.match(instructions, /Memory is disabled/);
  } finally {
    if (previous === undefined) delete process.env.PI_PLAN_MEMORY;
    else process.env.PI_PLAN_MEMORY = previous;
    await manager.close();
  }
});

test("the manager awaits a lazy base prompt on every refresh", async () => {
  const fakes = new Map<string, FakeSession>();
  let builds = 0;
  const manager = new TaskAgentManager({
    dataDir: directory,
    cwd: directory,
    models: {} as never,
    model: undefined,
    store,
    publish: () => undefined,
    baseInstructions: async () => `BASE ${++builds}`,
    openSession: async (taskId) => {
      const session = new FakeSession(taskId);
      fakes.set(taskId, session);
      return session;
    },
  });
  const task = (await store.create("Lazy base prompt", null)).tasks.find(
    (item) => item.title === "Lazy base prompt",
  );
  assert.ok(task);
  await manager.ensure(task.id);
  await manager.refreshInstructions(task.id, true);
  assert.match(fakes.get(task.id)?.instructions.at(-1) ?? "", /BASE 1/);
  await manager.refreshInstructions(task.id, true);
  assert.match(fakes.get(task.id)?.instructions.at(-1) ?? "", /BASE 2/);
  await manager.close();
});

test("a settled model failure becomes one dismissible run error", () => {
  const detail =
    '400: {"code":null,"message":"model \\"group/auto-deepseek-v4-1-flash\\" does not support image input; no model in the group DeepSeek V4.1 Flash is marked as taking images: turn on Accepts images for one that does"}';
  const error = runErrorFromUnanswered("model_error", detail, "p36a:9");
  assert.ok(error);
  assert.equal(error.id, "p36a:9");
  assert.equal(error.class, "ModelError");
  assert.match(error.message, /does not support image input/);
  assert.equal(error.detail, detail);
  assert.ok(error.message.length <= 160);
  assert.ok(Number.isFinite(Date.parse(error.at)));

  const noModel = runErrorFromUnanswered("no_model", "No model is configured", "7tfa:9");
  assert.equal(noModel?.class, "NoModelError");
  assert.equal(noModel?.message, "No model is configured");
  for (const reason of ["restart_limit", "turn_limit", "overflow", "threw", "missing_result"]) {
    const fallback = runErrorFromUnanswered(reason, "the run was cut off", "t:1");
    assert.equal(fallback?.class, "RunError");
    assert.equal(fallback?.message, "the run was cut off");
  }
  assert.equal(runErrorFromUnanswered("aborted", "stopped"), null);
  assert.equal(runErrorFromUnanswered("reset"), null);
});

test("only an explicit matching id dismisses the run error", () => {
  const error = runErrorFromUnanswered("model_error", "boom", "task:1");
  assert.ok(error);
  assert.equal(runErrorMatchesDismissal(undefined, error), false);
  assert.equal(runErrorMatchesDismissal("task:2", error), false);
  assert.equal(runErrorMatchesDismissal("task:1", error), true);
  assert.equal(runErrorMatchesDismissal("task:1", null), false);
});

test("the plan harness opens with the main chat retry policy", () => {
  const settings = taskAgentHarnessSettings({
    PI_RETRY_MAX: "4",
    PI_RETRY_BASE_MS: "125",
    PI_RETRY_MAX_DELAY_MS: "750",
  } as NodeJS.ProcessEnv);
  assert.deepEqual(settings.retry, {
    enabled: true,
    maxRetries: 4,
    baseDelayMs: 125,
    maxAgentDelayMs: 750,
  });
  assert.deepEqual(settings.compaction, { enabled: false });
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
  assert.match(prompt, /propose_task/);
  assert.match(prompt, /planning draft/i);
  assert.match(prompt, /starts its own plan agent/i);
  assert.match(prompt, /no rationale or flag/i);
  assert.match(prompt, /duplicate of the task/i);
  assert.match(prompt, /abcd/);
  assert.match(prompt, /Ship the release/);
  assert.doesNotMatch(prompt, /task_working/);
});

test("the plan prompt fixes the body shape, Gherkin and architecture rules", () => {
  const prompt = taskAgentInstructions("base prompt", {
    id: "shape1",
    title: "Shape the body",
    project: "pi-ui",
    body: "Plan it.",
  });
  const headings = ["## Goal", "## Requirements", "## Scenarios", "## Architecture"];
  for (const heading of headings) assert.match(prompt, new RegExp(heading));
  const order = headings.map((heading) => prompt.indexOf(heading));
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
  );
  assert.match(prompt, /one sentence/);
  assert.match(prompt, /\*\.feature/);
  assert.match(prompt, /gherkin/);
  assert.match(prompt, /invariant/i);
  assert.match(prompt, /one bullet per module/i);
  assert.match(prompt, /its path and what changes in it/);
  assert.doesNotMatch(prompt, /the problem and the proposed design/);
  const shape = prompt.slice(
    prompt.indexOf("- Write the body as a specification"),
    prompt.indexOf("Current task:"),
  );
  assert.ok(shape.length > 0, "the body-shape block is missing");
  assert.ok(shape.length <= 2_000, `the body-shape block costs ${shape.length} characters`);
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

test("the planning agent's propose_task creates a planning draft and starts its plan run", async () => {
  published = [];
  const sessions = new Map<string, FakeSession>();
  const manager = new TaskAgentManager({
    dataDir: directory,
    cwd: directory,
    models: {} as never,
    model: undefined,
    store,
    publish: (ledger) => {
      published.push(ledger);
    },
    baseInstructions: "base",
    openSession: async (taskId) => {
      const session = new FakeSession(taskId);
      sessions.set(taskId, session);
      return session;
    },
  });
  const prompt = `Follow up the ledger ${Date.now()}`;
  const result = await manager
    .proposeTool()
    .execute({ prompt, project: "pi-ui" } as never, {} as never, {} as never);
  assert.equal(result.isError === true, false);

  const draft = store.ledger().tasks.find((task) => task.title === prompt);
  assert.ok(draft);
  assert.equal(draft.status, "planning");
  assert.equal(draft.body, prompt);
  assert.equal(draft.project, "pi-ui");
  assert.equal(draft.createdBy, "agent");
  assert.equal(draft.rationale, undefined);

  const session = sessions.get(draft.id);
  assert.ok(session, "the plan runner opened the new draft's plan session");
  assert.deepEqual(session.submitted, [prompt]);
  assert.equal(published.length, 1);
  const text = result.output?.find((part) => part.type === "text");
  assert.ok(text && text.type === "text");
  assert.match(text.text, /plan run started/i);

  await manager.remove(draft.id);
  await store.remove(draft.id);
  await manager.close();
});

test("the planning agent's propose_task rejects a blank prompt without creating anything", async () => {
  let opened = 0;
  const manager = new TaskAgentManager({
    dataDir: directory,
    cwd: directory,
    models: {} as never,
    model: undefined,
    store,
    publish: () => undefined,
    baseInstructions: "base",
    openSession: async (taskId) => {
      opened += 1;
      return new FakeSession(taskId);
    },
  });
  const propose = manager.proposeTool();
  const tasksBefore = store.ledger().tasks.length;

  const blank = await propose.execute({ prompt: "   " } as never, {} as never, {} as never);
  assert.equal(blank.isError, true);
  assert.equal(store.ledger().tasks.length, tasksBefore);
  assert.equal(opened, 0, "a refused prompt never starts a plan run");
  await manager.close();
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

test("visible task chat rows keep system notices and omit user ones", () => {
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
    {
      id: "q",
      role: "system",
      text: "Answers sent",
      timestamp: "",
      order: 4,
      notice: { kind: "questions", setId: "s", count: 1, text: "", summary: "Answers sent" },
    } as ChatMessage,
  ];
  assert.deepEqual(
    visibleTaskAgentMessages(rows).map((item) => item.id),
    ["u", "a", "q"],
  );
});

class FakeSession implements TaskAgentSession {
  closed = false;
  stopped = 0;
  shutdowns = 0;
  closes = 0;
  submitted: string[] = [];
  attachments: string[][] = [];
  instructions: string[] = [];
  jobNotices: string[] = [];
  readonly hub = new StreamHub();
  run: RunState = "idle";

  constructor(readonly taskId: string) {}

  running(): boolean {
    return this.run === "running";
  }

  async applyInstructions(instructions: string) {
    this.instructions.push(instructions);
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
      activity: [],
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

  async submitJobNotice(text: string) {
    this.jobNotices.push(text);
  }

  async stop() {
    this.stopped += 1;
    this.run = "idle";
  }

  async shutdown() {
    this.shutdowns += 1;
    this.closed = true;
    this.run = "idle";
  }

  async close() {
    this.closes += 1;
    this.closed = true;
    this.run = "idle";
  }
}

type FakeSettlement = {
  status: "done" | "unanswered";
  reason?: string;
  detail?: string;
};

/** Records passive writes as entries, so the attachment seed can be inspected. */
class FakeAttachmentConversation {
  readonly entries: EntryRecord[] = [];
  readonly writes: SubmissionDraft[] = [];
  private nextId = 1;

  async context() {
    return { entries: this.entries, docs: {} };
  }

  async submit(submission: SubmissionDraft) {
    this.writes.push(submission);
    assert.equal(submission.type, "write");
    const entry = submission.entry;
    this.entries.push({
      id: this.nextId as never,
      conversationId: 1 as never,
      kind: entry.kind,
      ...(entry.model === undefined ? {} : { model: entry.model }),
      ...(entry.data === undefined ? {} : { data: entry.data }),
    });
    this.nextId += 1;
    return { id: this.nextId } as never;
  }
}

/** A busy conversation: writes stay queued and its context gains nothing yet. */
class FakeQueuedAttachmentConversation {
  readonly writes: SubmissionDraft[] = [];

  async context() {
    return { entries: [], docs: {} };
  }

  async submit(submission: SubmissionDraft) {
    this.writes.push(submission);
    return {
      id: this.writes.length as never,
      status: async () => ({ type: "write", status: "queued" }) as never,
    } as never;
  }
}

class FakePlanConversation {
  private calls = 0;

  constructor(private readonly settlements: FakeSettlement[]) {}

  async submit() {
    const id = ++this.calls;
    const settlement: FakeSettlement = this.settlements[id - 1] ?? { status: "done" };
    return {
      id,
      wait: async () => ({ ...settlement, id }),
    };
  }

  async context() {
    return { entries: [], docs: {} };
  }
}

async function nextRunState(
  frames: readonly SseFrame[],
  matches: (data: StreamRunState) => boolean,
): Promise<StreamRunState> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const frame = frames.find(
      (item) => item.event === "run.state" && matches(item.data as StreamRunState),
    );
    if (frame !== undefined) return frame.data as StreamRunState;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("no matching run.state frame");
}

class FakeCancelConversation {
  private calls = 0;
  private readonly waiters = new Map<number, (value: unknown) => void>();

  async submit() {
    const id = ++this.calls;
    const wait = new Promise((resolve) => this.waiters.set(id, resolve));
    return {
      id,
      status: async () =>
        id === 1
          ? { type: "input", status: "placed", entry: 1 }
          : { type: "input", status: "queued" },
      wait: async () => wait,
      abort: async () => "aborted",
    };
  }

  async context() {
    return { entries: [], docs: {} };
  }

  settle(id: number, value: unknown) {
    this.waiters.get(id)?.(value);
  }

  get submissionCount() {
    return this.calls;
  }
}

test("cancelling a queued follow-up does not end the live plan run", async () => {
  const conversation = new FakeCancelConversation();
  const session = new DurableTaskAgentSession(
    "taskcancel",
    { abortSubmission: async () => "aborted" } as never,
    conversation as never,
  );

  await session.send("start the run");
  assert.equal(session.running(), true);

  const queued = await session.send("follow up");
  assert.equal(queued.queued, true);
  const queueId = (await session.snapshot()).queue?.[0]?.id;
  assert.ok(queueId);
  assert.equal(await session.cancelQueued(queueId), true);

  // The cancelled submission settles `unanswered`/`aborted` after the abort.
  conversation.settle(2, { type: "input", status: "unanswered", reason: "aborted" });
  await new Promise((resolve) => setTimeout(resolve, 20));

  // The earlier submission still owns the live run, so its status must stay running.
  assert.equal(session.running(), true);
});

test("a busy plan keeps job notices as chips and merges consecutive ones", async () => {
  const conversation = new FakeCancelConversation();
  const session = new DurableTaskAgentSession(
    "taskjobnotices",
    { abortSubmission: async () => "aborted" } as never,
    conversation as never,
  );

  await session.send("start the run");
  await session.submitJobNotice("job one finished");
  await session.submitJobNotice("job two finished");
  const queue = (await session.snapshot()).queue ?? [];
  assert.equal(queue.length, 2);
  for (const item of queue) {
    assert.deepEqual(item.notice, {
      kind: JOB_NOTICE_ENTRY_KIND,
      label: "Background job",
      glyph: "job",
    });
  }
  const groups = mergeQueuedNotices(queue);
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.count, 2);

  conversation.settle(2, { type: "input", status: "done", entry: 2 });
  conversation.settle(3, { type: "input", status: "done", entry: 3 });
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test("moving a queued follow-up to a steer does not resend one already placed", async () => {
  const conversation = new FakeCancelConversation();
  const session = new DurableTaskAgentSession(
    "tasksteerqueue",
    { abortSubmission: async () => "already_placed" } as never,
    conversation as never,
  );

  await session.send("start the run");
  const queued = await session.send("queued to steer");
  assert.equal(queued.queued, true);
  const queueId = (await session.snapshot()).queue?.[0]?.id;
  assert.ok(queueId);
  assert.equal(conversation.submissionCount, 2);

  // Durable already placed it: resending would duplicate the transcript row.
  assert.equal(await session.steerQueued(queueId), null);
  assert.equal(conversation.submissionCount, 2);
  assert.equal((await session.snapshot()).queue?.length, 0);
});

test("an undelivered plan steer leaves a dropped bubble instead of vanishing", async () => {
  const conversation = new FakeCancelConversation();
  const session = new DurableTaskAgentSession(
    "tasksteer",
    { abortSubmission: async () => "aborted" } as never,
    conversation as never,
  );
  const frames: SseFrame[] = [];
  session.hub.add({
    send: async (frame) => {
      frames.push(frame);
    },
  });

  await session.send("start the run");
  const steer = await session.send("steer while busy", [], "steer");
  assert.equal(steer.queued, false);
  assert.equal((await session.snapshot()).steers?.length, 1);

  // A done submission whose entry never carried the steer must not delete it silently.
  conversation.settle(2, { type: "input", status: "done", entry: 2 });
  await new Promise((resolve) => setTimeout(resolve, 20));

  const dropped = frames.find((frame) => frame.event === "steer.dropped");
  assert.ok(dropped);
  assert.match((dropped.data as { reason: string }).reason, /run ended before/i);
  assert.equal((await session.snapshot()).steers?.length, 0);
});

test("a settled failure frames an error, clears on submit, and dismisses without a submit", async () => {
  const detail =
    '400: {"code":null,"message":"model \\"group/auto-deepseek-v4-1-flash\\" does not support image input; no model in the group DeepSeek V4.1 Flash is marked as taking images: turn on Accepts images for one that does"}';
  const conversation = new FakePlanConversation([
    { status: "unanswered", reason: "model_error", detail },
    { status: "done" },
    { status: "unanswered", reason: "restart_limit", detail: "the host kept cutting off the run" },
  ]);
  const session = new DurableTaskAgentSession("taskframe", {} as never, conversation as never);
  const frames: SseFrame[] = [];
  session.hub.add({
    send: async (frame) => {
      frames.push(frame);
    },
  });

  await session.submit("look at the screenshot");
  const failed = await nextRunState(frames, (data) => data.runError?.class === "ModelError");
  assert.equal(failed.state, "idle");
  assert.equal(failed.runError?.id, "taskframe:1");
  assert.match(failed.runError?.message ?? "", /does not support image input/);
  assert.equal(failed.runError?.detail, detail);
  assert.equal((await session.snapshot()).runError?.class, "ModelError");

  // The next accepted submit starts clean before its own run settles.
  const retried = await session.submit("try again");
  assert.equal(retried.runError, null);
  assert.equal((await session.snapshot()).runError, null);

  await session.submit("let the host cut it off");
  const fallback = await nextRunState(frames, (data) => data.runError?.class === "RunError");
  assert.equal(fallback.runError?.message, "the host kept cutting off the run");
  const current = await session.snapshot();
  assert.ok(current.runError);
  await session.dismissError(current.runError.id);
  assert.equal((await session.snapshot()).runError, null);
  const last = [...frames].reverse().find((frame) => frame.event === "run.state");
  assert.equal((last?.data as StreamRunState | undefined)?.runError, null);
});

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

test("a plan session nobody is using is closed and reopened on demand", async () => {
  let now = 1_000_000;
  const opened: FakeSession[] = [];
  const manager = new TaskAgentManager({
    dataDir: directory,
    cwd: directory,
    models: {} as never,
    model: undefined,
    store,
    publish: () => undefined,
    baseInstructions: "base",
    now: () => now,
    openSession: async (taskId) => {
      const session = new FakeSession(taskId);
      opened.push(session);
      return session;
    },
  });

  const ids: string[] = [];
  for (let index = 0; index < 10; index++) {
    const title = `Idle session ${index}`;
    const task = (await store.create(title, null)).tasks.find((item) => item.title === title);
    assert.ok(task);
    ids.push(task.id);
    await manager.ensure(task.id);
  }
  assert.equal(opened.length, 10);
  const [firstId, secondId] = ids;
  assert.ok(firstId && secondId);

  // One session is planning: the pool must not close it whatever its age.
  const busy = opened[3];
  assert.ok(busy);
  busy.run = "running";

  // Nine are idle; the pool keeps eight, so the one touched longest ago goes.
  const closed = await manager.evictIdle();
  assert.deepEqual(closed, [firstId]);
  assert.equal(opened[0]?.closed, true);
  assert.equal(busy.closed, false);

  // Asking for the closed task again opens a fresh session instead of handing out a dead one.
  const reopened = await manager.ensure(firstId);
  assert.notEqual(reopened, opened[0]);

  // Ten minutes on, every idle session has expired — the one reopened above included,
  // since it was opened before the clock moved — and the live run is still untouched.
  now += 10 * 60_000;
  const expired = await manager.evictIdle();
  assert.equal(expired.length, 9);
  assert.equal(expired.includes(firstId), true);
  assert.equal(expired.includes(secondId), true);
  assert.equal(expired.includes(busy.taskId), false);
  assert.equal(reopened.closed, true);
  assert.equal(busy.closed, false);

  busy.run = "idle";
  await manager.close();
  assert.equal(busy.closed, true);
});

test("planning reports only live plan runs on active tasks", async () => {
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

  const open = (await store.create("Plan the live task", null)).tasks.find(
    (item) => item.title === "Plan the live task",
  );
  const parked = (
    await store.create("Plan the parked task", null, [], undefined, undefined, "backlog")
  ).tasks.find((item) => item.title === "Plan the parked task");
  const done = (await store.create("Plan the done task", null)).tasks.find(
    (item) => item.title === "Plan the done task",
  );
  assert.ok(open);
  assert.ok(parked);
  assert.ok(done);
  await store.update(done.id, { status: "done" });

  for (const task of [open, parked, done]) {
    await manager.ensure(task.id);
    const fake = fakes.get(task.id);
    assert.ok(fake);
    fake.run = "running";
  }

  // Backlog and done sessions may exist, but they are never planning work.
  assert.deepEqual(manager.planningTaskIds(), [open.id]);
  assert.deepEqual(
    derivePlanningTaskIds(
      [
        { id: "open", status: "open" },
        { id: "working", status: "working" },
        { id: "backlog", status: "backlog" },
        { id: "proposed", status: "proposed" },
        { id: "done", status: "done" },
      ],
      ["open", "working", "backlog", "proposed", "done"],
    ),
    ["open", "working"],
  );

  // The same task stops planning as soon as its run is no longer live.
  const live = fakes.get(open.id);
  assert.ok(live);
  live.run = "idle";
  assert.deepEqual(manager.planningTaskIds(), []);

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

test("a task's images enter the plan context once and never become a chat row", async () => {
  const media = new MediaStore(join(directory, "plan-attachment-media"));
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const first = await media.save(png, "image/png");
  const second = await media.save(Buffer.concat([png, Buffer.from([1])]), "image/png");
  const third = await media.save(Buffer.concat([png, Buffer.from([2])]), "image/png");
  const conversation = new FakeAttachmentConversation();
  const task = {
    id: "attachments-one",
    title: "Look at the screenshots",
    attachments: [first.id, second.id],
  };

  await syncTaskAttachments(conversation as never, task, media);

  const seeded = conversation.entries.filter((entry) => entry.kind === TASK_ATTACHMENTS_ENTRY_KIND);
  assert.equal(seeded.length, 1);
  const seededEntry = seeded[0];
  assert.ok(seededEntry);
  const content = seededEntry.model?.[0]?.content;
  assert.ok(Array.isArray(content));
  assert.equal(content.filter((block) => block.type === "image").length, 2);
  assert.deepEqual((seededEntry.data as { ids: string[] }).ids, [first.id, second.id]);
  assert.equal(conversation.writes.length, 1);
  assert.equal(visibleTaskAgentMessages(buildTranscript(conversation.entries).messages).length, 0);

  // Reopening with the same ids is a diff of nothing.
  await syncTaskAttachments(conversation as never, task, media);
  assert.equal(conversation.writes.length, 1);
  assert.equal(
    conversation.entries.filter((entry) => entry.kind === TASK_ATTACHMENTS_ENTRY_KIND).length,
    1,
  );

  // A third image is one image block in a delta entry.
  await syncTaskAttachments(
    conversation as never,
    { ...task, attachments: [first.id, second.id, third.id] },
    media,
  );
  const delta = conversation.entries.at(-1);
  assert.ok(delta);
  assert.equal(delta.kind, TASK_ATTACHMENTS_ENTRY_KIND);
  const deltaContent = delta.model?.[0]?.content;
  assert.ok(Array.isArray(deltaContent));
  assert.equal(deltaContent.filter((block) => block.type === "image").length, 1);
  assert.deepEqual((delta.data as { ids: string[] }).ids, [first.id, second.id, third.id]);
  const preamble = deltaContent.find((block) => block.type === "text");
  assert.ok(preamble !== undefined && preamble.type === "text");
  assert.match(preamble.text, /3 attached images/);

  // No attachments writes nothing at all.
  const empty = new FakeAttachmentConversation();
  await syncTaskAttachments(
    empty as never,
    { id: "attachments-none", title: "No images", attachments: [] },
    media,
  );
  assert.equal(empty.writes.length, 0);
  assert.equal(empty.entries.length, 0);

  // One missing file becomes a text block, not a reason to drop the other images.
  const missing = `${"f".repeat(32)}.png`;
  const partial = new FakeAttachmentConversation();
  await syncTaskAttachments(
    partial as never,
    {
      id: "attachments-missing",
      title: "One image is gone",
      attachments: [first.id, missing, second.id],
    },
    media,
  );
  assert.equal(partial.writes.length, 1);
  const partialEntry = partial.entries[0];
  assert.ok(partialEntry);
  const partialContent = partialEntry.model?.[0]?.content;
  assert.ok(Array.isArray(partialContent));
  assert.equal(partialContent.filter((block) => block.type === "image").length, 2);
  assert.ok(
    partialContent.some(
      (block) => block.type === "text" && block.text.includes(`image ${missing} is missing`),
    ),
  );
  assert.deepEqual((partialEntry.data as { ids: string[] }).ids, [first.id, missing, second.id]);
});

test("the plan prompt names the attachment count and asks the agent to look first", () => {
  const prompt = taskAgentInstructions("base prompt", {
    id: "attachments-prompt",
    title: "Read the screenshots",
    project: "pi-ui",
    body: "",
    attachments: ["first", "second"],
  });
  assert.match(prompt, /- attachments: 2 images \(in your context\)/);
  assert.ok(prompt.indexOf("Look before you ask") < prompt.indexOf("ask_questions"));

  // A task without images gets neither the count nor the image-specific instruction.
  const plain = taskAgentInstructions("base prompt", {
    id: "attachments-none-prompt",
    title: "No screenshots here",
    project: "pi-ui",
    body: "",
  });
  assert.doesNotMatch(plain, /Look before you ask/);
  assert.doesNotMatch(plain, /- attachments:/);
  assert.match(plain, /ask_questions/);
});

test("a text-only plan model gets attachment text instead of image blocks", () => {
  const prompt = taskAgentInstructions(
    "base prompt",
    {
      id: "attachments-text-only",
      title: "Read the screenshots",
      project: "pi-ui",
      body: "",
      attachments: ["first", "second"],
    },
    { attachmentCount: 2, imagesInContext: false },
  );
  assert.match(prompt, /- attachments: 2 images \(this plan model cannot view images/);
  assert.doesNotMatch(prompt, /Look before you ask/);
});

test("concurrent syncs on a busy plan conversation append one image write", async () => {
  const media = new MediaStore(join(directory, "plan-attachment-queued-media"));
  const image = await media.save(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
    "image/png",
  );
  const conversation = new FakeQueuedAttachmentConversation();
  const task = { id: "attachments-queued", title: "Busy plan", attachments: [image.id] };

  await Promise.all([
    syncTaskAttachments(conversation as never, task, media),
    syncTaskAttachments(conversation as never, task, media),
  ]);

  assert.equal(conversation.writes.length, 1);
  const write = conversation.writes[0];
  assert.equal(write?.type, "write");
  const content = write?.type === "write" ? write.entry.model?.[0]?.content : undefined;
  assert.ok(Array.isArray(content));
  assert.equal(content.filter((block) => block.type === "image").length, 1);
});

test("a text-only plan session opens and live-syncs attachments as text", async () => {
  const media = new MediaStore(join(directory, "plan-text-only-media"));
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  const first = await media.save(png, "image/png");
  const second = await media.save(Buffer.concat([png, Buffer.from([1])]), "image/png");
  const third = await media.save(Buffer.concat([png, Buffer.from([2])]), "image/png");
  const task = (await store.create("Plan with a text-only model", null)).tasks.find(
    (item) => item.title === "Plan with a text-only model",
  );
  assert.ok(task);
  await store.update(task.id, { attachments: [first.id, second.id] });

  const manager = new TaskAgentManager({
    dataDir: join(directory, "plan-text-only-sessions"),
    cwd: directory,
    models: createModels() as never,
    model: { provider: "e2e", id: "text-only", input: ["text"] } as never,
    store,
    publish: () => undefined,
    baseInstructions: "base",
    media,
  });

  try {
    const session = await manager.ensure(task.id);
    const conversation = (
      session as unknown as {
        conversation: { context: (context: never) => Promise<{ entries: EntryRecord[] }> };
      }
    ).conversation;
    const entries = async () =>
      (await conversation.context(SESSION_CONTEXT as never)).entries.filter(
        (entry) => entry.kind === TASK_ATTACHMENTS_ENTRY_KIND,
      );

    const seeded = await entries();
    assert.equal(seeded.length, 1);
    const content = seeded[0]?.model?.[0]?.content;
    assert.ok(Array.isArray(content));
    assert.equal(content.filter((block) => block.type === "image").length, 0);
    const preamble = content.find((block) => block.type === "text");
    assert.ok(preamble !== undefined && preamble.type === "text");
    assert.match(preamble.text, /2 attached images/);
    assert.match(preamble.text, /cannot view images/);

    // The live PATCH path uses the same gate.
    await store.update(task.id, { attachments: [first.id, second.id, third.id] });
    await manager.syncTaskAttachments(task.id);
    const synced = await entries();
    assert.equal(synced.length, 2);
    const delta = synced.at(-1);
    assert.ok(delta);
    const deltaContent = delta.model?.[0]?.content;
    assert.ok(Array.isArray(deltaContent));
    assert.equal(deltaContent.filter((block) => block.type === "image").length, 0);
    const deltaText = deltaContent.find((block) => block.type === "text");
    assert.ok(deltaText !== undefined && deltaText.type === "text");
    assert.match(deltaText.text, /3 attached images/);
    assert.match(deltaText.text, /cannot view images/);
  } finally {
    await manager.close();
  }
});

test("a restart restores only plan turns whose marker was live", async () => {
  const dataDir = join(directory, "plan-restart");
  const tasksRoot = join(dataDir, "task-agents");
  const titles = {
    live: "Resume the live plan",
    other: "Resume the other live plan",
    stopped: "Leave the stopped plan idle",
    done: "Leave the finished plan idle",
    unmarked: "Leave the markerless plan closed",
    broken: "Skip the plan whose harness fails",
    corrupt: "Skip the plan with a corrupt marker",
    deleted: "Forget the plan whose task is gone",
  };
  const found = new Map<string, string>();
  for (const title of Object.values(titles)) {
    const task = (await store.create(title, null)).tasks.find((item) => item.title === title);
    assert.ok(task);
    found.set(title, task.id);
  }
  const id = (title: string): string => {
    const value = found.get(title);
    assert.ok(value);
    return value;
  };
  const dir = (taskId: string) => join(tasksRoot, taskId);
  const writeMarker = async (
    taskId: string,
    overrides: { stopRequested?: boolean } = {},
  ): Promise<RunMarkerStore> => {
    const taskDir = dir(taskId);
    await mkdir(taskDir, { recursive: true });
    const markerStore = new RunMarkerStore(taskDir, "run.json");
    await markerStore.write({
      version: 1,
      userMessage: "keep planning",
      startedAt: new Date().toISOString(),
      mode: "queue",
      stopRequested: overrides.stopRequested ?? false,
      idempotencyKey: `key-${taskId}`,
      queue: [],
      partialEntryId: null,
      updatedAt: new Date().toISOString(),
    });
    return markerStore;
  };

  await writeMarker(id(titles.live));
  await writeMarker(id(titles.other));
  const stopped = await writeMarker(id(titles.stopped), { stopRequested: true });
  const done = await writeMarker(id(titles.done));
  await store.update(id(titles.done), { status: "done" });
  await mkdir(dir(id(titles.unmarked)), { recursive: true });
  await writeMarker(id(titles.broken));
  const corruptDir = dir(id(titles.corrupt));
  await mkdir(corruptDir, { recursive: true });
  await writeFile(join(corruptDir, "run.json"), "{not a marker");
  const deleted = await writeMarker("deleted-task");

  const opened: string[] = [];
  const manager = new TaskAgentManager({
    dataDir,
    cwd: directory,
    models: {} as never,
    model: undefined,
    store,
    publish: () => undefined,
    baseInstructions: "BASE",
    openSession: async (taskId) => {
      if (taskId === id(titles.broken)) throw new Error("harness unavailable");
      opened.push(taskId);
      const session = new FakeSession(taskId);
      session.run = "running";
      return session;
    },
  });
  try {
    const resumed = await manager.restore();
    assert.deepEqual(resumed.sort(), [id(titles.live), id(titles.other)].sort());
    assert.deepEqual(opened.sort(), [id(titles.live), id(titles.other)].sort());
    assert.equal(opened.includes(id(titles.stopped)), false);
    assert.equal(opened.includes(id(titles.done)), false);
    assert.equal(opened.includes(id(titles.unmarked)), false);
    assert.equal(opened.includes("deleted-task"), false);
    assert.equal(await stopped.read(), undefined);
    assert.equal(await done.read(), undefined);
    assert.equal(await deleted.read(), undefined);
  } finally {
    await manager.close();
  }
});

test("manager shutdown keeps a live plan turn while remove still closes it", async () => {
  const dataDir = join(directory, "plan-shutdown");
  const first = (await store.create("Keep this plan through shutdown", null)).tasks.find(
    (item) => item.title === "Keep this plan through shutdown",
  );
  const second = (await store.create("Remove this plan session", null)).tasks.find(
    (item) => item.title === "Remove this plan session",
  );
  assert.ok(first);
  assert.ok(second);

  const fakes = new Map<string, FakeSession>();
  const manager = new TaskAgentManager({
    dataDir,
    cwd: directory,
    models: {} as never,
    model: undefined,
    store,
    publish: () => undefined,
    baseInstructions: "BASE",
    openSession: async (taskId) => {
      const session = new FakeSession(taskId);
      fakes.set(taskId, session);
      return session;
    },
  });

  await manager.ensure(first.id);
  await manager.ensure(second.id);
  const kept = fakes.get(first.id);
  const removed = fakes.get(second.id);
  assert.ok(kept);
  assert.ok(removed);
  kept.run = "running";

  await manager.remove(second.id);
  assert.equal(removed.closes, 1);
  assert.equal(removed.shutdowns, 0);

  await manager.close();
  assert.equal(kept.shutdowns, 1);
  assert.equal(kept.closes, 0);
});
