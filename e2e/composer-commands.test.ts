import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ComposerCommandContext,
  composerCommands,
  matchCommands,
} from "../src/client/composer-commands.js";

const task = { id: "t1", title: "Ship the ledger" };

function build(overrides: Partial<ComposerCommandContext> = {}) {
  const calls: string[] = [];
  const context: ComposerCommandContext = {
    task: null,
    desktop: true,
    fullscreen: false,
    remove: async () => {
      calls.push("remove");
      return null;
    },
    toggleFullscreen: () => {
      calls.push("fullscreen");
    },
    ...overrides,
  };
  return { context, calls };
}

function find(name: string, overrides: Partial<ComposerCommandContext> = {}) {
  const built = build(overrides);
  const command = composerCommands(built.context).find((item) => item.name === name);
  assert.ok(command !== undefined, `no /${name} command`);
  return { command, calls: built.calls, context: built.context };
}

test("full screen needs a wide viewport before it needs a task", () => {
  assert.equal(find("fullscreen", { task, desktop: false }).command.unavailable, "desktop only");
  assert.equal(find("fullscreen", { task: null }).command.unavailable, "no task open");
  assert.equal(find("fullscreen", { task }).command.unavailable, null);
});

test("an unavailable full screen runs nothing", async () => {
  const blocked: Array<Partial<ComposerCommandContext>> = [
    { desktop: false, task },
    { desktop: true, task: null },
  ];
  for (const overrides of blocked) {
    const { command, calls } = find("fullscreen", overrides);
    assert.equal(await command.run(), null);
    assert.deepEqual(calls, []);
  }
});

test("the summary reads as the way back once the body fills the page", () => {
  assert.equal(find("fullscreen", { task }).command.summary, "read the task body at full width");
  assert.equal(
    find("fullscreen", { task, fullscreen: true }).command.summary,
    "show the list and chat again",
  );
});

test("running full screen toggles through the caller", async () => {
  const { command, calls } = find("fullscreen", { task });
  await command.run();
  await command.run();
  assert.deepEqual(calls, ["fullscreen", "fullscreen"]);

  const { matches, index } = matchCommands(composerCommands(build({ task }).context), "full");
  assert.deepEqual(
    matches.map((match) => match.command.name),
    ["fullscreen"],
  );
  assert.equal(index, 0);
});

test("the palette still defaults to the first available command", () => {
  const { matches, index } = matchCommands(composerCommands(build({ task: null }).context), "");
  assert.deepEqual(
    matches.map((match) => match.command.name),
    ["remove", "fullscreen"],
  );
  assert.equal(index, 0);
});

test("remove keeps its own reason and still calls the remover", async () => {
  assert.equal(find("remove", { task: null }).command.unavailable, "no task open");
  const ready = find("remove", { task });
  assert.equal(ready.command.unavailable, null);
  assert.equal(await ready.command.run(), null);
  assert.deepEqual(ready.calls, ["remove"]);
});
