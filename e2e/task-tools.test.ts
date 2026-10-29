import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { createTaskTools, type TaskBridge } from "../src/server/task-tools.js";
import { TaskStore } from "../src/server/tasks.js";
import type { TaskLedger } from "../src/shared/types.js";

let directory = "";
let bridge: TaskBridge;
let published: TaskLedger[] = [];

const tools = () => new Map(createTaskTools(bridge).map((tool) => [tool.name, tool]));

async function call(name: string, args: Record<string, unknown>) {
  const tool = tools().get(name);
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

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-ui-tasks-"));
  const store = new TaskStore(join(directory, "tasks.json"));
  await store.load();
  bridge = {
    store,
    publish(ledger) {
      published.push(ledger);
    },
  };
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("task tools list, mark done, and create a blocker", async () => {
  published = [];
  assert.deepEqual(
    createTaskTools(bridge).map((tool) => tool.name),
    ["task_list", "task_done", "task_block"],
  );

  const parent = (await bridge.store.create("Write the ledger", null)).tasks.find(
    (task) => task.title === "Write the ledger",
  );
  assert.ok(parent);
  const child = (await bridge.store.create("Store tasks.json", parent.id)).tasks.find(
    (task) => task.title === "Store tasks.json",
  );
  assert.ok(child);

  const listed = text(await call("task_list", {}));
  assert.equal(listed.isError, false);
  assert.match(listed.text, new RegExp(`${parent.id} open Write the ledger`));
  assert.match(listed.text, /Store tasks.json/);

  const blocked = text(await call("task_block", { id: parent.id, title: "Review the diff" }));
  assert.equal(blocked.isError, false);
  const blockerId = blocked.text
    .split("\n")
    .find((line) => line.includes("Review the diff"))
    ?.trim()
    .split(" ")[0];
  assert.ok(blockerId);
  assert.match(blocked.text, new RegExp(`${parent.id} open blocked-by=${blockerId}`));

  const again = text(await call("task_block", { id: parent.id, title: "Check the types" }));
  assert.equal(again.isError, false);
  assert.match(again.text, new RegExp(`${parent.id} open blocked-by=${blockerId},`));

  const missing = text(await call("task_block", { id: "missing", title: "Nope" }));
  assert.equal(missing.isError, true);
  const blank = text(await call("task_block", { id: parent.id, title: "   " }));
  assert.equal(blank.isError, true);

  const tooSoon = text(await call("task_done", { id: parent.id }));
  assert.equal(tooSoon.isError, true);
  assert.match(tooSoon.text, /subtask/i);

  const finishedChild = text(await call("task_done", { id: child.id }));
  assert.equal(finishedChild.isError, false);
  assert.match(finishedChild.text, new RegExp(`${child.id} done`));
  const finishedParent = text(await call("task_done", { id: parent.id }));
  assert.equal(finishedParent.isError, false);
  assert.match(finishedParent.text, new RegExp(`${parent.id} done`));

  assert.ok(published.length > 0);
  assert.equal(published.at(-1)?.revision, bridge.store.ledger().revision);
});
