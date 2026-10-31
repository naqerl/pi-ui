import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTaskTools } from "../src/server/task-tools.js";
import { TaskStore } from "../src/server/tasks.js";
import {
  acceptMention,
  defaultProject,
  matchProjects,
  mentionAt,
  normalizeProject,
  parseProjectToken,
  projectsOf,
} from "../src/shared/project.js";
import type { TaskLedger } from "../src/shared/types.js";

test("project names are short words; @, spaces and trailing punctuation are dropped", () => {
  assert.equal(normalizeProject(" pi-ui "), "pi-ui");
  assert.equal(normalizeProject("@citydiff"), "citydiff");
  assert.equal(normalizeProject("pi-ui."), "pi-ui");
  assert.equal(normalizeProject("two words"), null);
  assert.equal(normalizeProject(""), null);
  assert.equal(normalizeProject("x".repeat(41)), null);
  assert.equal(normalizeProject(3), null);
});

test("an @project token is stripped from the title and the last one wins", () => {
  assert.deepEqual(parseProjectToken("Fix scroll @pi-ui"), {
    title: "Fix scroll",
    project: "pi-ui",
  });
  assert.deepEqual(parseProjectToken("@citydiff Ship the map"), {
    title: "Ship the map",
    project: "citydiff",
  });
  assert.deepEqual(parseProjectToken("Move @a things @b"), { title: "Move things", project: "b" });
  assert.deepEqual(parseProjectToken("Mail a@b.com today"), {
    title: "Mail a@b.com today",
    project: null,
  });
  assert.deepEqual(parseProjectToken("Ping @ alone"), { title: "Ping @ alone", project: null });
  assert.deepEqual(parseProjectToken("Fix @PI-UI", ["pi-ui"]), { title: "Fix", project: "pi-ui" });
});

test("the @ token under the caret drives autocomplete and is replaced on accept", () => {
  assert.deepEqual(mentionAt("Fix @pi", 7), { start: 4, end: 7, query: "pi" });
  assert.deepEqual(mentionAt("@", 1), { start: 0, end: 1, query: "" });
  assert.deepEqual(mentionAt("Fix @pi rest", 6), { start: 4, end: 7, query: "p" });
  assert.equal(mentionAt("mail a@b", 8), null);
  assert.equal(mentionAt("Fix @pi done", 12), null);
  assert.deepEqual(acceptMention("Fix @pi", { start: 4, end: 7 }, "pi-ui"), {
    text: "Fix @pi-ui ",
    caret: 11,
  });
  assert.deepEqual(acceptMention("@c rest", { start: 0, end: 2 }, "citydiff"), {
    text: "@citydiff rest",
    caret: 10,
  });
  assert.deepEqual(matchProjects(["zeroshot", "citydiff", "pi-ui", "api"], "pi"), ["pi-ui", "api"]);
  assert.deepEqual(projectsOf([{ project: "pi-ui" }, {}, { project: "PI-UI" }, { project: "b" }]), [
    "b",
    "pi-ui",
  ]);
});

test("the default project: parent, then the filter in view, then the last used", () => {
  const all = { kind: "all" } as const;
  assert.equal(
    defaultProject({ parent: { project: "a" }, filter: { kind: "project", name: "b" } }),
    "a",
  );
  assert.equal(
    defaultProject({ parent: {}, filter: { kind: "project", name: "b" }, lastUsed: "c" }),
    null,
  );
  assert.equal(defaultProject({ filter: { kind: "project", name: "b" }, lastUsed: "c" }), "b");
  assert.equal(defaultProject({ filter: { kind: "none" }, lastUsed: "c" }), null);
  assert.equal(defaultProject({ filter: all, lastUsed: "c" }), "c");
  assert.equal(defaultProject({ filter: all, lastUsed: "bad name" }), null);
  assert.equal(defaultProject({ filter: all }), null);
});

test("the store keeps, inherits, edits and validates projects; old data loads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-ui-projects-"));
  try {
    const file = join(directory, "tasks.json");
    await writeFile(
      file,
      JSON.stringify({
        revision: 1,
        tasks: [
          {
            id: "old1",
            title: "Old task",
            status: "open",
            parentId: null,
            blockedBy: [],
            createdAt: "2026-10-01T10:00:00.000Z",
            completedAt: null,
            completion: null,
          },
        ],
      }),
    );
    const store = new TaskStore(file, { notify: () => {} });
    await store.load();
    assert.equal(store.ledger().tasks[0]?.project, undefined);

    let ledger = await store.create("Root", null, [], "pi-ui");
    const root = ledger.tasks.find((task) => task.title === "Root");
    assert.equal(root?.project, "pi-ui");
    ledger = await store.create("Child", root?.id ?? "", []);
    assert.equal(ledger.tasks.find((task) => task.title === "Child")?.project, "pi-ui");
    ledger = await store.create("Loose", root?.id ?? "", [], null);
    assert.equal(ledger.tasks.find((task) => task.title === "Loose")?.project, undefined);
    ledger = await store.create("Same", null, [], "PI-UI");
    assert.equal(ledger.tasks.find((task) => task.title === "Same")?.project, "pi-ui");
    await assert.rejects(store.create("Bad", null, [], "two words"), /Project must be/);

    ledger = await store.update("old1", { project: "citydiff" });
    assert.equal(ledger.tasks.find((task) => task.id === "old1")?.project, "citydiff");
    ledger = await store.update("old1", { project: null });
    assert.equal(ledger.tasks.find((task) => task.id === "old1")?.project, undefined);

    ledger = await store.addBlocker(root?.id ?? "", "Blocker");
    assert.equal(ledger.tasks.find((task) => task.title === "Blocker")?.project, "pi-ui");

    const reloaded = new TaskStore(file, { notify: () => {} });
    await reloaded.load();
    assert.equal(reloaded.ledger().tasks.find((task) => task.title === "Root")?.project, "pi-ui");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("agent tools take an optional project and show it", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-ui-project-tools-"));
  try {
    const store = new TaskStore(join(directory, "tasks.json"), { notify: () => {} });
    await store.load();
    const published: TaskLedger[] = [];
    const tools = new Map(
      createTaskTools({ store, publish: (ledger) => published.push(ledger) }).map((tool) => [
        tool.name,
        tool,
      ]),
    );
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await tools.get(name)?.execute(args as never, {} as never, {} as never);
      const part = result?.output?.find((item) => item.type === "text");
      return part !== undefined && part.type === "text" ? part.text : "";
    };
    const ledger = await store.create("Ship it", null, [], "citydiff");
    const id = ledger.tasks[0]?.id ?? "";
    assert.match(
      await call("task_block", { id, title: "Fix the build" }),
      /@citydiff Fix the build/,
    );
    assert.match(await call("task_view", { id }), /project=citydiff/);
    await call("propose_task", {
      title: "Trim logs",
      rationale: "Logs fill the disk every week on the box.",
      project: "pi-ui",
    });
    assert.equal(store.ledger().tasks.find((task) => task.title === "Trim logs")?.project, "pi-ui");
    assert.match(await call("task_proposals", {}), /@pi-ui Trim logs/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
