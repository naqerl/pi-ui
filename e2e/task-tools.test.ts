import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { MediaStore } from "../src/server/media.js";
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
    media: new MediaStore(join(directory, "media")),
    plan: async () => {},
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
    [
      "task_list",
      "task_proposals",
      "task_view",
      "task_depends",
      "task_done",
      "task_reopen",
      "task_working",
      "task_release",
      "task_edit",
      "propose_task",
      "task_block",
    ],
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
  assert.match(blocked.text, new RegExp(`${parent.id} open depends-on=${blockerId}`));

  const again = text(await call("task_block", { id: parent.id, title: "Check the types" }));
  assert.equal(again.isError, false);
  assert.match(again.text, new RegExp(`${parent.id} open depends-on=${blockerId},`));

  const missing = text(await call("task_block", { id: "missing", title: "Nope" }));
  assert.equal(missing.isError, true);
  const blank = text(await call("task_block", { id: parent.id, title: "   " }));
  assert.equal(blank.isError, true);

  const completion = { evidence: "e2e/task-tools.test.ts" };
  const tooSoon = text(await call("task_done", { id: parent.id, ...completion }));
  assert.equal(tooSoon.isError, true);
  assert.match(tooSoon.text, /subtask/i);

  const finishedChild = text(await call("task_done", { id: child.id, ...completion }));
  assert.equal(finishedChild.isError, false);
  assert.match(finishedChild.text, new RegExp(`${child.id} done`));
  const finishedParent = text(await call("task_done", { id: parent.id, ...completion }));
  assert.equal(finishedParent.isError, false);
  assert.match(finishedParent.text, new RegExp(`${parent.id} done`));

  assert.ok(published.length > 0);
  assert.equal(published.at(-1)?.revision, bridge.store.ledger().revision);
});

test("planning drafts are hidden unless asked for and cannot be claimed as work", async () => {
  const created = (
    await bridge.store.create(
      "Draft the launch plan",
      null,
      [],
      "pi-ui",
      "The composer text becomes the draft body.",
      { status: "planning" },
    )
  ).tasks.find((task) => task.title === "Draft the launch plan");
  assert.ok(created);
  assert.equal(created.status, "planning");
  assert.equal(created.body, "The composer text becomes the draft body.");

  const hidden = text(await call("task_list", {}));
  assert.doesNotMatch(hidden.text, /Draft the launch plan/);
  assert.doesNotMatch(hidden.text, /planning:/);

  const included = text(await call("task_list", { includePlanning: true }));
  assert.match(included.text, new RegExp(`${created.id} planning @pi-ui Draft the launch plan`));
  assert.match(included.text, /planning: 1 draft\(s\).*do not execute them yet/);

  const listTool = tools().get("task_list");
  assert.ok(listTool);
  assert.match(listTool.description ?? "", /still being specified.*must not be executed/i);
  const schema = listTool.parameters as {
    properties?: Record<string, { type?: string }>;
  };
  assert.equal(schema.properties?.includePlanning?.type, "boolean");

  const refused = text(await call("task_working", { id: created.id, note: "start" }));
  assert.equal(refused.isError, true);
  assert.match(refused.text, /still being planned/i);
  assert.equal(
    bridge.store.ledger().tasks.find((task) => task.id === created.id)?.status,
    "planning",
  );

  const refusedDone = text(
    await call("task_done", { id: created.id, evidence: "e2e/task-tools.test.ts draft" }),
  );
  assert.equal(refusedDone.isError, true);
  assert.match(refusedDone.text, /still being planned/i);

  const approved = await bridge.store.update(created.id, { status: "open" });
  assert.equal(approved.tasks.find((task) => task.id === created.id)?.status, "open");
  assert.equal(
    text(await call("task_working", { id: created.id, note: "approved" })).isError,
    false,
  );
});

test("task_view returns a task's images", async () => {
  const media = bridge.media;
  assert.ok(media);
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const ref = await media.save(png, "image/png");
  await assert.rejects(media.save(Uint8Array.from([1, 2, 3]), "image/png"));
  const created = (await bridge.store.create("Look at this", null, [ref.id])).tasks.find(
    (task) => task.title === "Look at this",
  );
  assert.ok(created);
  assert.match(text(await call("task_list", {})).text, new RegExp(`${created.id} open images=1`));
  const viewed = await call("task_view", { id: created.id });
  assert.equal(viewed.isError === true, false);
  const image = viewed.output?.find((item) => item.type === "image");
  assert.ok(image && image.type === "image");
  assert.equal(image.mimeType, "image/png");
  assert.equal(image.data, Buffer.from(png).toString("base64"));
});

test("task_edit replaces images with named unknown ids, a cap and an empty clear", async () => {
  const media = bridge.media;
  assert.ok(media);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const refs = await Promise.all(
    Array.from({ length: 13 }, (_, index) =>
      media.save(Uint8Array.from([...signature, index + 1, index + 2]), "image/png"),
    ),
  );
  const first = refs[0];
  const second = refs[1];
  assert.ok(first);
  assert.ok(second);
  const created = (await bridge.store.create("Manage these images", null)).tasks.find(
    (task) => task.title === "Manage these images",
  );
  assert.ok(created);

  const added = text(
    await call("task_edit", { id: created.id, attachments: [first.id, second.id] }),
  );
  assert.equal(added.isError, false);
  assert.match(added.text, new RegExp(`${created.id} open images=2`));
  assert.match(text(await call("task_list", {})).text, new RegExp(`${created.id} open images=2`));
  const viewed = await call("task_view", { id: created.id });
  assert.equal(viewed.output?.filter((item) => item.type === "image").length, 2);

  const unknownId = `${"f".repeat(32)}.png`;
  const unknown = text(await call("task_edit", { id: created.id, attachments: [unknownId] }));
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, new RegExp(`Unknown attachment ${unknownId}`));
  assert.equal(
    bridge.store.ledger().tasks.find((task) => task.id === created.id)?.attachments?.length,
    2,
  );

  const tooMany = text(
    await call("task_edit", { id: created.id, attachments: refs.map((ref) => ref.id) }),
  );
  assert.equal(tooMany.isError, true);
  assert.match(tooMany.text, /At most 12 images can be attached/);
  assert.equal(
    bridge.store.ledger().tasks.find((task) => task.id === created.id)?.attachments?.length,
    2,
  );

  const cleared = text(await call("task_edit", { id: created.id, attachments: [] }));
  assert.equal(cleared.isError, false);
  assert.doesNotMatch(cleared.text, new RegExp(`${created.id} open images=`));
  assert.equal(
    bridge.store.ledger().tasks.find((task) => task.id === created.id)?.attachments,
    undefined,
  );
});

test("agent task tools create a planning draft and edit its body", async () => {
  const prompt = "Write the plan down";
  const staged = text(await call("propose_task", { prompt }));
  assert.equal(staged.isError, false);
  assert.match(staged.text, /plan run started/i);
  const task = bridge.store.ledger().tasks.find((item) => item.title === prompt);
  assert.ok(task);
  assert.equal(task.status, "planning");
  assert.equal(task.body, prompt);
  assert.equal(task.rationale, undefined);
  assert.equal(task.createdBy, "agent");
  assert.match(text(await call("task_view", { id: task.id })).text, /Write the plan down/);

  const edited = text(await call("task_edit", { id: task.id, body: "## Later\n\nSecond step." }));
  assert.equal(edited.isError, false);
  const changed = bridge.store.ledger().tasks.find((item) => item.id === task.id);
  assert.equal(changed?.body, "## Later\n\nSecond step.");
  assert.equal(changed?.rationale, undefined);

  const cleared = text(await call("task_edit", { id: task.id, body: "" }));
  assert.equal(cleared.isError, false);
  assert.equal(bridge.store.ledger().tasks.find((item) => item.id === task.id)?.body, undefined);
  const blankTitle = text(await call("task_edit", { id: task.id, title: "   " }));
  assert.equal(blankTitle.isError, true);
  assert.match(blankTitle.text, /title/i);
});

test("propose_task validates its prompt and attachments", async () => {
  const media = bridge.media;
  assert.ok(media);
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const image = await media.save(Uint8Array.from([...signature, 9, 9]), "image/png");
  const prompt = `Plan the image resize ${Date.now()}`;
  const staged = text(
    await call("propose_task", { prompt, project: "pi-ui", attachments: [image.id] }),
  );
  assert.equal(staged.isError, false);
  const draft = bridge.store.ledger().tasks.find((item) => item.title === prompt);
  assert.ok(draft);
  assert.equal(draft.status, "planning");
  assert.equal(draft.project, "pi-ui");
  assert.deepEqual(draft.attachments, [image.id]);

  const before = bridge.store.ledger().tasks.length;
  const unknownId = `${"e".repeat(32)}.png`;
  const unknown = text(
    await call("propose_task", { prompt: "Unknown image", attachments: [unknownId] }),
  );
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, new RegExp(`Unknown attachment ${unknownId}`));

  const blank = text(await call("propose_task", { prompt: "   " }));
  assert.equal(blank.isError, true);
  assert.match(blank.text, /Task title is required/);
  assert.equal(bridge.store.ledger().tasks.length, before);
});

test("task_reopen needs a reason, only reopens done work, and counts each reopen", async () => {
  const created = (await bridge.store.create("Reopen the report", null)).tasks.find(
    (task) => task.title === "Reopen the report",
  );
  assert.ok(created);
  const evidence = { evidence: "e2e/task-tools.test.ts" };
  assert.equal(text(await call("task_done", { id: created.id, ...evidence })).isError, false);

  const blank = text(await call("task_reopen", { id: created.id, reason: "   " }));
  assert.equal(blank.isError, true);
  assert.match(blank.text, /A reopen needs a reason/);

  const first = text(
    await call("task_reopen", { id: created.id, reason: "The report still shows the old total" }),
  );
  assert.equal(first.isError, false);
  assert.match(first.text, new RegExp(`${created.id} open Reopen the report`));
  assert.match(first.text, /reopened: The report still shows the old total/);
  assert.match(first.text, /reopen #1/);
  const reopened = bridge.store.ledger().tasks.find((task) => task.id === created.id);
  assert.equal(reopened?.status, "open");
  assert.equal(reopened?.completedAt, null);
  assert.deepEqual(reopened?.completion, evidence);
  assert.equal(reopened?.reopens?.[0]?.by, "agent");

  assert.equal(text(await call("task_done", { id: created.id, ...evidence })).isError, false);
  const second = text(
    await call("task_reopen", { id: created.id, reason: "It regressed a second time" }),
  );
  assert.equal(second.isError, false);
  assert.match(second.text, /reopen #2/);

  const refused = text(await call("task_reopen", { id: created.id, reason: "Not done any more" }));
  assert.equal(refused.isError, true);
  assert.match(refused.text, /Only a done task can be reopened/);
});

test("task_working refuses a done task and points at task_reopen", async () => {
  const created = (await bridge.store.create("Finished but not reopened", null)).tasks.find(
    (task) => task.title === "Finished but not reopened",
  );
  assert.ok(created);
  const completion = { evidence: "e2e/task-tools.test.ts finished" };
  assert.equal(text(await call("task_done", { id: created.id, ...completion })).isError, false);

  const refused = text(await call("task_working", { id: created.id, note: "keep going" }));
  assert.equal(refused.isError, true);
  assert.match(refused.text, /task_reopen/);
  const task = bridge.store.ledger().tasks.find((item) => item.id === created.id);
  assert.equal(task?.status, "done");
  assert.deepEqual(task?.completion, completion);
  assert.equal(task?.reopens, undefined);
});

test("task_release parks a working task and refuses everything else", async () => {
  const created = (await bridge.store.create("Release the badge", null)).tasks.find(
    (task) => task.title === "Release the badge",
  );
  assert.ok(created);
  assert.equal(text(await call("task_working", { id: created.id, note: "start" })).isError, false);

  const blank = text(await call("task_release", { id: created.id, reason: "   " }));
  assert.equal(blank.isError, true);
  assert.match(blank.text, /A release needs a reason/);
  const short = text(await call("task_release", { id: created.id, reason: "ab" }));
  assert.equal(short.isError, true);
  assert.match(short.text, /at least 3 characters/);
  const long = text(await call("task_release", { id: created.id, reason: "x".repeat(501) }));
  assert.equal(long.isError, true);
  assert.match(long.text, /at most 500 characters/);
  assert.equal(
    bridge.store.ledger().tasks.find((task) => task.id === created.id)?.status,
    "working",
    "a refused release leaves the badge alone",
  );

  const released = text(
    await call("task_release", { id: created.id, reason: "Waiting for the nightly build" }),
  );
  assert.equal(released.isError, false);
  assert.match(released.text, new RegExp(`${created.id} open Release the badge`));
  assert.match(released.text, /released: Waiting for the nightly build/);
  const open = bridge.store.ledger().tasks.find((task) => task.id === created.id);
  assert.equal(open?.status, "open");
  assert.equal(open?.releaseReason, "Waiting for the nightly build");
  assert.equal(typeof open?.releasedAt, "string");
  assert.equal(open?.workingSince, undefined);
  assert.equal(open?.lastWorkedAt, null);

  const again = text(await call("task_release", { id: created.id, reason: "Release it twice" }));
  assert.equal(again.isError, true);
  assert.match(again.text, /Only a working task can be released/);

  assert.equal(
    text(await call("task_working", { id: created.id, note: "actually still working" })).isError,
    false,
  );
  const reclaimed = bridge.store.ledger().tasks.find((task) => task.id === created.id);
  assert.equal(reclaimed?.status, "working");
  assert.equal(reclaimed?.releasedAt, undefined);
  assert.equal(reclaimed?.releaseReason, undefined);

  const finished = (await bridge.store.create("Released after finishing", null)).tasks.find(
    (task) => task.title === "Released after finishing",
  );
  assert.ok(finished);
  assert.equal(
    text(await call("task_done", { id: finished.id, evidence: "e2e/task-tools.test.ts" })).isError,
    false,
  );
  const refusedDone = text(
    await call("task_release", { id: finished.id, reason: "Park the finished task" }),
  );
  assert.equal(refusedDone.isError, true);
  assert.match(refusedDone.text, /Task is done/);
});

test("task_depends records the ordering in both views and a done dependency stops gating", async () => {
  const base = (await bridge.store.create("Implement the base layer", null)).tasks.find(
    (task) => task.title === "Implement the base layer",
  );
  const dependent = (await bridge.store.create("Build on the base layer", null)).tasks.find(
    (task) => task.title === "Build on the base layer",
  );
  assert.ok(base);
  assert.ok(dependent);

  const related = text(await call("task_depends", { id: dependent.id, dependsOn: [base.id] }));
  assert.equal(related.isError, false);
  assert.match(related.text, new RegExp(`${dependent.id} open depends-on=${base.id}`));
  assert.doesNotMatch(related.text, /blocked-by=/);

  const dependentView = text(await call("task_view", { id: dependent.id }));
  assert.match(
    dependentView.text,
    new RegExp(`depends-on=${base.id} open Implement the base layer`),
  );
  const baseView = text(await call("task_view", { id: base.id }));
  assert.match(
    baseView.text,
    new RegExp(`required-by=${dependent.id} open Build on the base layer`),
  );

  const before = bridge.store.ledger().tasks.find((task) => task.id === dependent.id);
  const refused = text(await call("task_working", { id: dependent.id, note: "start" }));
  assert.equal(refused.isError, true);
  assert.match(refused.text, /implemented and marked done/);
  assert.match(refused.text, new RegExp(`${base.id} open Implement the base layer`));
  const untouched = bridge.store.ledger().tasks.find((task) => task.id === dependent.id);
  assert.equal(untouched?.status, "open");
  assert.equal(untouched?.workingSince, before?.workingSince);
  assert.equal(untouched?.lastWorkedAt, before?.lastWorkedAt);

  assert.equal(
    text(await call("task_done", { id: base.id, evidence: "e2e/task-tools.test.ts base" })).isError,
    false,
  );
  const ledger = text(await call("task_list", {}));
  assert.match(ledger.text, new RegExp(`${dependent.id} open depends-on=${base.id}\\(done\\)`));
  assert.equal(
    text(await call("task_working", { id: dependent.id, note: "the base is done" })).isError,
    false,
  );

  const finishing = (await bridge.store.create("Finish despite the ordering", null)).tasks.find(
    (task) => task.title === "Finish despite the ordering",
  );
  const pending = (await bridge.store.create("Still pending work", null)).tasks.find(
    (task) => task.title === "Still pending work",
  );
  assert.ok(finishing);
  assert.ok(pending);
  assert.equal(
    text(await call("task_depends", { id: finishing.id, dependsOn: [pending.id] })).isError,
    false,
  );
  const done = text(
    await call("task_done", { id: finishing.id, evidence: "e2e/task-tools.test.ts ungated" }),
  );
  assert.equal(done.isError, false, "task_done is never gated by a pending dependency");
  assert.match(done.text, new RegExp(`${finishing.id} done`));
});

test("a planning draft still gates and the refusal names it", async () => {
  const draft = (
    await bridge.store.create(
      "Draft the shared importer",
      null,
      [],
      "pi-ui",
      "Plan the importer.",
      { status: "planning" },
    )
  ).tasks.find((task) => task.title === "Draft the shared importer");
  const waiting = (await bridge.store.create("Wire the shared importer", null)).tasks.find(
    (task) => task.title === "Wire the shared importer",
  );
  assert.ok(draft);
  assert.ok(waiting);

  assert.equal(
    text(await call("task_depends", { id: waiting.id, dependsOn: [draft.id] })).isError,
    false,
  );
  const refused = text(await call("task_working", { id: waiting.id, note: "start" }));
  assert.equal(refused.isError, true);
  assert.match(refused.text, new RegExp(`${draft.id} planning Draft the shared importer`));
  assert.match(refused.text, /still being planned and waiting for approval/);
  assert.equal(bridge.store.ledger().tasks.find((task) => task.id === waiting.id)?.status, "open");
});

test("task_depends refuses unknown, self, unapproved and cyclic orderings without a write", async () => {
  const first = (await bridge.store.create("First ordered task", null)).tasks.find(
    (task) => task.title === "First ordered task",
  );
  const second = (await bridge.store.create("Second ordered task", null)).tasks.find(
    (task) => task.title === "Second ordered task",
  );
  assert.ok(first);
  assert.ok(second);
  assert.equal(
    text(await call("task_depends", { id: first.id, dependsOn: [second.id] })).isError,
    false,
  );

  const cycle = text(await call("task_depends", { id: second.id, dependsOn: [first.id] }));
  assert.equal(cycle.isError, true);
  assert.match(cycle.text, new RegExp(`${first.id} → ${second.id} → ${first.id}`));
  assert.deepEqual(
    bridge.store.ledger().tasks.find((task) => task.id === second.id)?.blockedBy,
    [],
  );
  assert.deepEqual(bridge.store.ledger().tasks.find((task) => task.id === first.id)?.blockedBy, [
    second.id,
  ]);

  const self = text(await call("task_depends", { id: first.id, dependsOn: [first.id] }));
  assert.equal(self.isError, true);
  assert.match(self.text, /cycle/i);

  const unknown = text(await call("task_depends", { id: first.id, dependsOn: ["missing-task"] }));
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /Unknown dependency missing-task/);
  assert.deepEqual(bridge.store.ledger().tasks.find((task) => task.id === first.id)?.blockedBy, [
    second.id,
  ]);

  await bridge.store.propose(
    "Maybe a cache",
    "Not approved yet, so it cannot gate another task.",
    [],
    "pi-ui",
  );
  const proposal = bridge.store.ledger().tasks.find((task) => task.title === "Maybe a cache");
  assert.ok(proposal);
  const proposed = text(await call("task_depends", { id: first.id, dependsOn: [proposal.id] }));
  assert.equal(proposed.isError, true);
  assert.match(proposed.text, /proposed and is not approved work/);

  const parked = (
    await bridge.store.create("Parked idea", null, [], undefined, undefined, true)
  ).tasks.find((task) => task.title === "Parked idea");
  assert.ok(parked);
  const backlog = text(await call("task_depends", { id: first.id, dependsOn: [parked.id] }));
  assert.equal(backlog.isError, true);
  assert.match(backlog.text, /backlog and is not approved work/);
  assert.deepEqual(
    bridge.store.ledger().tasks.find((task) => task.id === first.id)?.blockedBy,
    [second.id],
    "no refused call changed the stored dependencies",
  );

  const cleared = text(await call("task_depends", { id: first.id, dependsOn: [] }));
  assert.equal(cleared.isError, false);
  assert.doesNotMatch(cleared.text, new RegExp(`${first.id} open depends-on=`));
  assert.deepEqual(bridge.store.ledger().tasks.find((task) => task.id === first.id)?.blockedBy, []);
});

test("plan-scoped task tools list the project, refuse another project and allow only its ordering", async () => {
  const plan = (
    await bridge.store.create(
      "Plan the scoped relation",
      null,
      [],
      "pi-ui",
      "Plan the shared factory.",
      { status: "planning" },
    )
  ).tasks.find((task) => task.title === "Plan the scoped relation");
  const sameProject = (
    await bridge.store.create("Share the factory", null, [], "pi-ui")
  ).tasks.find((task) => task.title === "Share the factory");
  const sibling = (await bridge.store.create("Another pi-ui task", null, [], "pi-ui")).tasks.find(
    (task) => task.title === "Another pi-ui task",
  );
  const elsewhere = (await bridge.store.create("Website task", null, [], "website")).tasks.find(
    (task) => task.title === "Website task",
  );
  assert.ok(plan);
  assert.ok(sameProject);
  assert.ok(sibling);
  assert.ok(elsewhere);
  await bridge.store.propose("Maybe a scoped draft", "Read it to avoid conflict.", [], "pi-ui");
  const proposal = bridge.store
    .ledger()
    .tasks.find((task) => task.title === "Maybe a scoped draft");
  assert.ok(proposal);

  const scoped = new Map(
    createTaskTools(bridge, { scope: { taskId: plan.id } }).map((tool) => [tool.name, tool]),
  );
  const scopedCall = async (name: string, args: Record<string, unknown>) => {
    const tool = scoped.get(name);
    assert.ok(tool);
    return tool.execute(args as never, {} as never, {} as never);
  };

  const listed = text(await scopedCall("task_list", {}));
  assert.match(listed.text, new RegExp(`${plan.id} planning .*Plan the scoped relation`));
  assert.match(listed.text, new RegExp(`${sameProject.id} open .*Share the factory`));
  assert.match(listed.text, new RegExp(`${proposal.id} proposed .*not approved`));
  assert.doesNotMatch(listed.text, new RegExp(elsewhere.id));

  await bridge.store.update(elsewhere.id, { status: "done" });
  assert.equal(
    text(await scopedCall("task_depends", { id: plan.id, dependsOn: [elsewhere.id] })).isError,
    false,
    "the planned task may depend on a task in another project",
  );
  const crossProject = text(await scopedCall("task_list", {}));
  assert.match(
    crossProject.text,
    new RegExp(`${plan.id} planning depends-on=${elsewhere.id}\\(done\\)`),
    "a satisfied cross-project dependency keeps its done marker in the scoped list",
  );

  const outside = text(await scopedCall("task_view", { id: elsewhere.id }));
  assert.equal(outside.isError, true);
  assert.match(outside.text, /outside this plan's project/);
  assert.equal(text(await scopedCall("task_view", { id: sameProject.id })).isError, false);

  const unrelated = text(
    await scopedCall("task_depends", { id: sibling.id, dependsOn: [sameProject.id] }),
  );
  assert.equal(unrelated.isError, true);
  assert.match(unrelated.text, /may only change an ordering that involves/);
  assert.deepEqual(
    bridge.store.ledger().tasks.find((task) => task.id === sibling.id)?.blockedBy,
    [],
  );

  const mixed = text(
    await scopedCall("task_depends", { id: sibling.id, dependsOn: [plan.id, sameProject.id] }),
  );
  assert.equal(mixed.isError, true);
  assert.match(mixed.text, /may only change an ordering that involves/);
  assert.deepEqual(
    bridge.store.ledger().tasks.find((task) => task.id === sibling.id)?.blockedBy,
    [],
    "an unrelated id bundled with the planned task is still refused",
  );

  assert.equal(
    text(await scopedCall("task_depends", { id: plan.id, dependsOn: [sameProject.id] })).isError,
    false,
  );
  assert.match(
    text(await scopedCall("task_view", { id: sameProject.id })).text,
    new RegExp(`required-by=${plan.id} planning Plan the scoped relation`),
  );
  assert.equal(
    text(await scopedCall("task_depends", { id: sibling.id, dependsOn: [plan.id] })).isError,
    false,
    "the planned task may also be the dependency in the other direction",
  );

  const unprojected = (
    await bridge.store.create("Plan without a project", null, [], undefined, "Pick a project.", {
      status: "planning",
    })
  ).tasks.find((task) => task.title === "Plan without a project");
  assert.ok(unprojected);
  const unscopedProject = createTaskTools(bridge, { scope: { taskId: unprojected.id } });
  const listTool = new Map(unscopedProject.map((tool) => [tool.name, tool])).get("task_list");
  assert.ok(listTool);
  const everyProject = await listTool.execute({} as never, {} as never, {} as never);
  const everyProjectText =
    everyProject.output?.find((part) => part.type === "text")?.type === "text"
      ? (everyProject.output.find((part) => part.type === "text") as { text: string }).text
      : "";
  assert.match(everyProjectText, new RegExp(`${elsewhere.id} done @website Website task`));
});
