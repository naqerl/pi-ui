import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import { createTaskQuestionTools } from "../src/server/task-agent.js";
import {
  MAX_PENDING_QUESTIONS,
  questionAnswerPrompt,
  questionDismissPrompt,
  TaskQuestionsStore,
} from "../src/server/task-questions.js";
import type { TaskQuestion } from "../src/shared/types.js";

let directory = "";
let path = "";
let store: TaskQuestionsStore;
let tools: ReturnType<typeof createTaskQuestionTools>;

const context = {} as never;

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

function question(id: string): TaskQuestion {
  return { id, prompt: `Question ${id}?`, kind: "text" };
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

test("ask_questions returns without an answer and the set stays pending", async () => {
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
  // No answer is submitted: the call itself must resolve.
  const result = text(await call("ask_questions", questions, "tool-ask"));
  assert.equal(result.isError, false);
  assert.match(result.text, /Registered 3 questions/);
  assert.match(result.text, /Do not wait/);
  const set = await pending();
  assert.ok(set);
  assert.deepEqual(
    set.questions.map((question) => question.id),
    ["layout", "parts", "notes"],
  );
  assert.match(result.text, new RegExp(set.id));

  const answers = [
    { id: "layout", values: ["split"], text: "" },
    { id: "parts", values: ["sidebar", "timeline"], text: "" },
    { id: "notes", values: [], text: "Keep the phone width in mind." },
  ];
  const answered = await store.answer(set.id, answers);
  assert.equal(await pending(), null);
  assert.match(answered.summary, /Answered 3 questions/);
  assert.match(answered.summary, /Split/);
  assert.deepEqual(answered.record.answers, answers);

  // A fresh store reads the same cleared state, as after a server restart.
  const reloaded = new TaskQuestionsStore(path);
  await reloaded.load();
  assert.equal(await reloaded.pending(), null);

  // A replayed tool call still returns the recorded answers instead of asking again.
  const replay = text(await call("ask_questions", questions, "tool-ask"));
  assert.equal(replay.isError, false);
  assert.match(replay.text, /Answered 3 questions/);
  assert.equal(await pending(), null);

  const prompt = questionAnswerPrompt(answered);
  assert.match(prompt, new RegExp(`set ${set.id}`));
  assert.match(prompt, /Which layout\?: Split/);
  assert.match(prompt, /Keep the phone width in mind/);
  assert.match(prompt, /Do not ask them again/);
});

test("a question set is capped and the over-cap call is refused", async () => {
  const tooMany = Array.from({ length: MAX_PENDING_QUESTIONS + 1 }, (_, index) =>
    question(`q${index}`),
  );
  const refused = text(await call("ask_questions", tooMany));
  assert.equal(refused.isError, true);
  assert.match(refused.text, new RegExp(`at most ${MAX_PENDING_QUESTIONS}`));
  assert.equal(await pending(), null);

  const allowed = Array.from({ length: MAX_PENDING_QUESTIONS }, (_, index) =>
    question(`q${index}`),
  );
  const registered = text(await call("ask_questions", allowed));
  assert.equal(registered.isError, false);
  const set = await pending();
  assert.ok(set);
  assert.equal(set.questions.length, MAX_PENDING_QUESTIONS);

  const over = text(await call("append_questions", [question("q-extra")]));
  assert.equal(over.isError, true);
  assert.match(over.text, new RegExp(`at most ${MAX_PENDING_QUESTIONS}`));
  assert.equal((await pending())?.questions.length, MAX_PENDING_QUESTIONS);
});

test("dismiss clears the pending set and tells the agent to decide itself", async () => {
  const added = await store.add("task-1", [question("scope")]);
  assert.equal((await store.pending())?.id, added.set.id);
  const dismissed = await store.dismiss(added.set.id);
  assert.equal(dismissed.id, added.set.id);
  assert.equal(await pending(), null);
  await assert.rejects(store.dismiss(added.set.id), /no longer waiting/i);
  const prompt = questionDismissPrompt(dismissed);
  assert.match(prompt, /dismissed your questions/);
  assert.match(prompt, /Decide these yourself/);
});

test("the store reports every add and answer through onChange", async () => {
  let changes = 0;
  const watched = new TaskQuestionsStore(path, () => {
    changes += 1;
  });
  const added = await watched.add("task-1", [question("scope")]);
  assert.equal(changes, 1);
  await watched.answer(added.set.id, [{ id: "scope", values: [], text: "Ship it" }]);
  assert.equal(changes, 2);
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

  // Re-posting the same set after it was answered is a conflict, not a new record.
  await store.answer(added.set.id, [{ id: "layout", values: ["split"], text: "" }]);
  await assert.rejects(
    store.answer(added.set.id, [{ id: "layout", values: ["split"], text: "" }]),
    /no longer waiting/i,
  );
});
