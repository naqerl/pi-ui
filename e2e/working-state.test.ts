import assert from "node:assert/strict";
import { test } from "node:test";
import { isThinking, taskStatusWord, workingWord } from "../src/client/working-state.js";

test("a thinking stream says thinking until text, a tool or an idle run takes over", () => {
  assert.equal(isThinking("", ""), false);
  assert.equal(workingWord(isThinking("", "")), "working");

  assert.equal(isThinking("Weighing the options", ""), true);
  assert.equal(workingWord(isThinking("Weighing the options", "")), "thinking");
  assert.equal(isThinking("Weighing the options, then answering", ""), true);

  assert.equal(isThinking("Weighing the options", "Here is the answer"), false);
  assert.equal(workingWord(isThinking("Weighing the options", "Here is the answer")), "working");

  assert.equal(isThinking("", ""), false);
  assert.equal(workingWord(isThinking("", "")), "working");
});

test("the status belongs to the surface, not to the app", () => {
  assert.equal(taskStatusWord(null, false), null);
  assert.equal(taskStatusWord("task-a", true), "planning");
  assert.equal(taskStatusWord("task-a", false), "idle");
  assert.equal(taskStatusWord("task-b", false), "idle");
});
