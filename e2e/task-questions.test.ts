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

async function call(name: string, questions: unknown, callId = "call-1") {
  return tool(name).execute({ questions } as never, { taskId: 42, callId } as never, context);
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

  const reloaded = new TaskQuestionsStore(path);
  await reloaded.load();
  assert.deepEqual(await reloaded.pending(), merged);
});

test("ask_questions returns immediately and leaves the set pending for the Plan tab", async () => {
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
  const result = text(await call("ask_questions", questions, "tool-ask"));
  assert.equal(result.isError, false);
  assert.match(result.text, /Registered 3 questions/);
  assert.match(result.text, /layout, parts, notes/);
  assert.match(result.text, /Do not wait/);

  const set = await pending();
  assert.ok(set);
  assert.deepEqual(
    set.questions.map((question) => question.id),
    ["layout", "parts", "notes"],
  );

  const reloaded = new TaskQuestionsStore(path);
  await reloaded.load();
  assert.deepEqual(await reloaded.pending(), set);

  const answers = [
    { id: "layout", values: ["split"], text: "" },
    { id: "parts", values: ["sidebar", "timeline"], text: "" },
    { id: "notes", values: [], text: "Keep the phone width in mind." },
  ];
  await store.answer(set.id, answers);
  assert.equal(await pending(), null);

  const replay = text(await call("ask_questions", questions, "tool-ask"));
  assert.equal(replay.isError, false);
  assert.match(replay.text, /Answered 3 questions/);
  assert.match(replay.text, /Split/);
  assert.equal(await pending(), null);

  const fresh = text(
    await call(
      "ask_questions",
      [{ id: "later", prompt: "Anything else?", kind: "text" }],
      "tool-later",
    ),
  );
  assert.match(fresh.text, /Registered 1 question/);
  assert.deepEqual(
    (await pending())?.questions.map((question) => question.id),
    ["later"],
  );
});

test("a pending set is capped and refuses questions over the limit", async () => {
  const five: TaskQuestion[] = Array.from({ length: 5 }, (_, index) => ({
    id: `q${index}`,
    prompt: `Question ${index}?`,
    kind: "text" as const,
  }));
  const accepted = text(await call("ask_questions", five));
  assert.equal(accepted.isError, false);
  assert.equal((await pending())?.questions.length, 5);

  const over = text(
    await call("append_questions", [{ id: "q5", prompt: "One too many?", kind: "text" }]),
  );
  assert.equal(over.isError, true);
  assert.match(over.text, /at most 5 questions/i);
  assert.equal((await pending())?.questions.length, 5);

  const tooMany = text(
    await call(
      "ask_questions",
      Array.from({ length: 6 }, (_, index) => ({
        id: `n${index}`,
        prompt: `Question ${index}?`,
        kind: "text",
      })),
    ),
  );
  assert.equal(tooMany.isError, true);
  assert.match(tooMany.text, /at most 5 questions/i);
});

test("clearPending drops a saved set when the task leaves planning", async () => {
  await call("ask_questions", [{ id: "layout", prompt: "Which layout?", kind: "text" }]);
  assert.ok(await pending());

  assert.equal(await store.clearPending(), true);
  assert.equal(await pending(), null);

  const reloaded = new TaskQuestionsStore(path);
  await reloaded.load();
  assert.equal(await reloaded.pending(), null);
  assert.equal(await store.clearPending(), false);
});

test("free text answers a choice question and overrides its choices", async () => {
  const added = await store.add("task-1", [
    {
      id: "layout",
      prompt: "Which layout?",
      kind: "single",
      options: [{ value: "split", label: "Split" }],
    },
    {
      id: "parts",
      prompt: "Which parts?",
      kind: "multi",
      options: [{ value: "sidebar", label: "Sidebar" }],
    },
  ]);
  const answered = await store.answer(added.set.id, [
    { id: "layout", values: ["split"], text: "A new layout of my own" },
    { id: "parts", values: [], text: "Only the footer" },
  ]);
  assert.deepEqual(
    answered.items.map((item) => ({ id: item.id, values: item.values, text: item.text })),
    [
      { id: "layout", values: [], text: "A new layout of my own" },
      { id: "parts", values: [], text: "Only the footer" },
    ],
  );
  assert.equal(await pending(), null);
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
