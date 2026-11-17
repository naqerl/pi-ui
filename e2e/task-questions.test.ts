import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { buildChatTimeline } from "../src/client/chat-timeline.js";
import { buildTranscript, TASK_QUESTION_PROMPT_ENTRY_KIND } from "../src/server/session.js";
import {
  createTaskQuestionTools,
  DurableTaskAgentSession,
  TaskAgentError,
  TaskAgentManager,
} from "../src/server/task-agent.js";
import { TaskQuestionsStore } from "../src/server/task-questions.js";
import { TaskStore } from "../src/server/tasks.js";
import { pendingQueuedMessage } from "../src/shared/queue.js";
import type { QueuedMessage, TaskQuestion } from "../src/shared/types.js";

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

test("both question tools carry the investigate, decide, cap and never-wait rules", () => {
  for (const name of ["ask_questions", "append_questions"]) {
    const description = tool(name).description ?? "";
    assert.match(description, /investigate first/i);
    assert.match(description, /decide/i);
    assert.match(description, /3/);
    assert.match(description, /never wait/i);
  }
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

  // A fresh store reads the same pending set, as after a page reload or server restart.
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

  // A replayed tool call still returns the recorded answers instead of re-asking.
  const replay = text(await call("ask_questions", questions, "tool-ask"));
  assert.equal(replay.isError, false);
  assert.match(replay.text, /Answered 3 questions/);
  assert.match(replay.text, /Split/);
  assert.equal(await pending(), null);
});

test("a pending set is capped and refuses questions over the limit", async () => {
  const eight: TaskQuestion[] = Array.from({ length: 8 }, (_, index) => ({
    id: `q${index}`,
    prompt: `Question ${index}?`,
    kind: "text" as const,
  }));
  const accepted = text(await call("ask_questions", eight));
  assert.equal(accepted.isError, false);
  assert.equal((await pending())?.questions.length, 8);

  const over = text(
    await call("append_questions", [{ id: "q8", prompt: "One too many?", kind: "text" }]),
  );
  assert.equal(over.isError, true);
  assert.match(over.text, /at most 8 questions/i);
  assert.equal((await pending())?.questions.length, 8);

  const tooMany = text(
    await call(
      "ask_questions",
      Array.from({ length: 9 }, (_, index) => ({
        id: `n${index}`,
        prompt: `Question ${index}?`,
        kind: "text",
      })),
    ),
  );
  assert.equal(tooMany.isError, true);
  assert.match(tooMany.text, /at most 8 questions/i);
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

test("a queued answer nudge keeps one questions chip when its notice is placed", async () => {
  class CaptureConversation {
    drafts: Array<{
      content: string;
      whenBusy?: string;
      requestId?: string;
      entry?: { kind: string; data?: Record<string, unknown> };
    }> = [];

    async submit(draft: (typeof this.drafts)[number]) {
      this.drafts.push(draft);
      return {
        id: this.drafts.length,
        status: async () => ({ type: "input", status: "queued" }),
        wait: async () => new Promise(() => undefined),
      };
    }

    async context() {
      return { entries: [], docs: {} };
    }
  }

  const conversation = new CaptureConversation();
  const session = new DurableTaskAgentSession("task-1", {} as never, conversation as never, store);
  const added = await store.add("task-1", [
    { id: "layout", prompt: "Which layout?", kind: "text" },
  ]);
  await session.answerQuestions(added.set.id, [{ id: "layout", values: [], text: "Split layout" }]);

  const draft = conversation.drafts[0];
  assert.ok(draft);
  assert.equal(draft.whenBusy, "followUp");
  assert.equal(draft.requestId, `questions:${added.set.id}`);
  assert.equal(draft.entry?.kind, TASK_QUESTION_PROMPT_ENTRY_KIND);
  assert.equal(draft.entry?.data?.queueKey, draft.requestId);

  const placed = buildTranscript([
    {
      id: 7,
      conversationId: 1,
      kind: draft.entry?.kind,
      data: draft.entry?.data,
    } as unknown as EntryRecord,
  ]).messages[0];
  assert.ok(placed);
  assert.equal(placed.id, `m-${draft.requestId}`);
  assert.equal(placed.notice?.kind, "questions");

  const queued: QueuedMessage = {
    id: "1",
    key: draft.requestId,
    text: draft.content,
    createdAt: new Date().toISOString(),
    notice: { kind: "questions", label: "Answers sent", glyph: "questions" },
  };
  assert.equal(pendingQueuedMessage(queued).id, placed.id);

  const timeline = buildChatTimeline({
    messages: [placed],
    activity: [],
    liveTools: [],
    draftText: "",
    draftThinking: "",
    draftThinkingAt: null,
    steers: [],
    queue: [queued],
    optimistic: [],
  });
  assert.equal(
    timeline.filter((item) => item.kind === "message" && item.message.notice?.kind === "questions")
      .length,
    1,
  );
});

test("a done task refuses answers and dismissals, and clearPending drops the set", async () => {
  const doneDir = await mkdtemp(join(tmpdir(), "pi-ui-task-questions-done-"));
  try {
    const tasks = new TaskStore(join(doneDir, "tasks.json"));
    await tasks.load();
    const task = (await tasks.create("Closed question task", null)).tasks.find(
      (item) => item.title === "Closed question task",
    );
    assert.ok(task);
    await tasks.update(task.id, { status: "done" });

    const manager = new TaskAgentManager({
      dataDir: doneDir,
      cwd: doneDir,
      models: {} as never,
      model: undefined,
      store: tasks,
      publish: () => undefined,
      baseInstructions: "BASE",
      openSession: async (taskId) =>
        ({
          taskId,
          closed: false,
          running: () => false,
          close: async () => undefined,
        }) as never,
    });
    try {
      await assert.rejects(
        manager.answerQuestions(task.id, "set-1", []),
        (error: unknown) => error instanceof TaskAgentError && error.status === 409,
      );
      await assert.rejects(
        manager.dismissQuestions(task.id, "set-1"),
        (error: unknown) => error instanceof TaskAgentError && error.status === 409,
      );

      await manager.ensure(task.id);
      const pendingStore = new TaskQuestionsStore(join(manager.taskDir(task.id), "questions.json"));
      await pendingStore.load();
      await pendingStore.add(task.id, [{ id: "layout", prompt: "Which layout?", kind: "text" }]);
      await manager.clearQuestions(task.id);
      const reread = new TaskQuestionsStore(join(manager.taskDir(task.id), "questions.json"));
      await reread.load();
      assert.equal(await reread.pending(), null);
    } finally {
      await manager.close();
    }
  } finally {
    await rm(doneDir, { recursive: true, force: true });
  }
});
