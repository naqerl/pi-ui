import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { createTaskQuestionTools } from "../src/server/task-agent.js";
import { TaskQuestionsStore } from "../src/server/task-questions.js";
import type { TaskQuestion } from "../src/shared/types.js";

let directory = "";
let path = "";
let store: TaskQuestionsStore;
let tools: ReturnType<typeof createTaskQuestionTools>;

const context = { abortSignal: undefined } as never;

function tool(name: string) {
  const found = tools.find((item) => item.name === name);
  assert.ok(found, `missing ${name}`);
  return found;
}

async function call(name: string, questions: unknown, taskId = "tool-1") {
  return tool(name).execute({ questions } as never, { taskId } as never, context);
}

function text(result: Awaited<ReturnType<typeof call>>) {
  const part = result.output?.find((item) => item.type === "text");
  return {
    text: part !== undefined && part.type === "text" ? part.text : "",
    isError: result.isError === true,
  };
}

async function pending() {
  return store.pending();
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "pi-ui-task-questions-"));
  path = join(directory, "questions.json");
  store = new TaskQuestionsStore(path);
  await store.load();
  tools = createTaskQuestionTools({ taskId: "task-1", questions: store });
});

beforeEach(async () => {
  await rm(path, { force: true });
  store = new TaskQuestionsStore(path);
  await store.load();
  tools = createTaskQuestionTools({ taskId: "task-1", questions: store });
});

after(async () => {
  await rm(directory, { recursive: true, force: true });
});

test("ask_questions rejects an unknown kind, a choice without options, and a duplicate id", async () => {
  const unknown = text(
    await call("ask_questions", [
      { id: "layout", prompt: "Which layout?", kind: "chips", options: [] },
    ]),
  );
  assert.equal(unknown.isError, true);
  assert.match(unknown.text, /unknown kind/i);

  const single = text(
    await call("ask_questions", [{ id: "layout", prompt: "Which layout?", kind: "single" }]),
  );
  assert.equal(single.isError, true);
  assert.match(single.text, /needs at least one option/i);

  const multi = text(
    await call("ask_questions", [{ id: "parts", prompt: "Which parts?", kind: "multi" }]),
  );
  assert.equal(multi.isError, true);
  assert.match(multi.text, /needs at least one option/i);

  const duplicate = text(
    await call("ask_questions", [
      { id: "layout", prompt: "Which layout?", kind: "text" },
      { id: "layout", prompt: "Same id again", kind: "text" },
    ]),
  );
  assert.equal(duplicate.isError, true);
  assert.match(duplicate.text, /Duplicate question id/i);
  assert.equal(await pending(), null);
});

test("append_questions merges into the same persisted pending set", async () => {
  const first = text(
    await call("append_questions", [
      {
        id: "layout",
        prompt: "Which layout?",
        kind: "single",
        options: [
          { value: "split", label: "Split" },
          { value: "stack", label: "Stack" },
        ],
      },
    ]),
  );
  assert.equal(first.isError, false);
  const initial = await pending();
  assert.ok(initial);
  assert.deepEqual(
    initial.questions.map((question) => question.id),
    ["layout"],
  );

  const second = text(
    await call("append_questions", [
      { id: "notes", prompt: "Anything else?", kind: "text", allowOther: true },
    ]),
  );
  assert.equal(second.isError, false);
  const merged = await pending();
  assert.ok(merged);
  assert.equal(merged.id, initial.id);
  assert.deepEqual(
    merged.questions.map((question) => question.id),
    ["layout", "notes"],
  );

  const duplicate = text(
    await call("append_questions", [{ id: "layout", prompt: "Again?", kind: "text" }]),
  );
  assert.equal(duplicate.isError, true);
  assert.match(duplicate.text, /already waiting/i);

  // A fresh store reads the same pending set, as after a server restart.
  const reloaded = new TaskQuestionsStore(path);
  await reloaded.load();
  assert.deepEqual(await reloaded.pending(), merged);
});

test("ask_questions returns the same ids and clears the pending set after answering", async () => {
  const questions: TaskQuestion[] = [
    {
      id: "layout",
      prompt: "Which layout?",
      kind: "single",
      options: [
        { value: "split", label: "Split" },
        { value: "stack", label: "Stack" },
      ],
    },
    {
      id: "parts",
      prompt: "Which parts?",
      kind: "multi",
      options: [
        { value: "sidebar", label: "Sidebar" },
        { value: "timeline", label: "Timeline" },
      ],
    },
    {
      id: "notes",
      prompt: "Anything else?",
      kind: "text",
      allowOther: true,
    },
  ];
  const running = call("ask_questions", questions, "tool-ask");
  let set = await pending();
  for (let attempt = 0; attempt < 50 && set === null; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    set = await pending();
  }
  assert.ok(set);
  assert.deepEqual(
    set.questions.map((question) => question.id),
    ["layout", "parts", "notes"],
  );

  const answers = [
    { id: "layout", values: ["split"], text: "" },
    { id: "parts", values: ["sidebar", "timeline"], text: "" },
    { id: "notes", values: [], text: "Keep the phone width in mind." },
  ];
  const answered = await store.answer(set.id, answers);
  store.resolve(set.id, answered);
  const result = text(await running);
  assert.equal(result.isError, false);
  const [summary, json] = result.text.split("\n");
  assert.match(summary ?? "", /Answered 3 questions/);
  assert.match(summary ?? "", /Split/);
  const payload = JSON.parse(json ?? "{}") as {
    answers: Array<{ id: string; values: string[]; text: string }>;
  };
  assert.deepEqual(payload.answers, answers);
  assert.equal(await pending(), null);
  const reloaded = new TaskQuestionsStore(path);
  await reloaded.load();
  assert.equal(await reloaded.pending(), null);
});

test("answers are validated against the waiting questions", async () => {
  const added = await store.add("task-1", [
    {
      id: "layout",
      prompt: "Which layout?",
      kind: "single",
      options: [{ value: "split", label: "Split" }],
    },
  ]);
  await assert.rejects(
    store.answer(added.set.id, [{ id: "layout", values: ["missing"], text: "" }]),
    /unknown option/i,
  );
  await assert.rejects(
    store.answer(added.set.id, [{ id: "other", values: [], text: "no" }]),
    /does not match/i,
  );
  assert.ok(await pending());
});
