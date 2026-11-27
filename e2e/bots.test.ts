import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BotInput } from "../src/server/bot-body.js";
import {
  BOT_TOOL_CATALOG,
  botChatPaths,
  DEFAULT_BOTS,
  JOB_HUNTER_TOOLS,
} from "../src/server/bot-defaults.js";
import {
  assertBotToolAllowed,
  BotError,
  BotToolNotAllowedError,
  DuplicateBotIdError,
} from "../src/server/bot-error.js";
import { BotToolAllowance } from "../src/server/bot-guard.js";
import { botTools } from "../src/server/bot-tools.js";
import { BotStore } from "../src/server/bots.js";
import type { TaskBridge } from "../src/server/task-tools.js";

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-ui-bots-"));
}

function input(id: string, overrides: Partial<BotInput> = {}): BotInput {
  return {
    id: overrides.id ?? id,
    name: overrides.name ?? id,
    systemPrompt: overrides.systemPrompt ?? `Prompt for ${id}`,
    tools: overrides.tools ?? ["task_list"],
    ...(overrides.model === undefined ? {} : { model: overrides.model }),
  };
}

test("a fresh store seeds the Job hunter with the smallest ledger allowance", async () => {
  const dir = await scratch();
  try {
    const file = join(dir, "bots.json");
    const store = new BotStore(file);
    await store.load();
    const hunter = store.get("job-hunter");
    assert.ok(hunter !== undefined);
    assert.equal(hunter.name, "Job hunter");
    assert.deepEqual(hunter.tools, [...JOB_HUNTER_TOOLS]);
    assert.deepEqual(hunter.tools, ["propose_task", "task_list", "task_view"]);
    assert.match(hunter.systemPrompt, /propose_task/);
    assert.equal(store.list().length, DEFAULT_BOTS.length);
    const written = JSON.parse(await readFile(file, "utf8")) as {
      bots: { id: string }[];
    };
    assert.deepEqual(
      written.bots.map((bot) => bot.id),
      ["job-hunter"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a duplicate id is a named error and leaves the first definition alone", async () => {
  const dir = await scratch();
  try {
    const store = new BotStore(join(dir, "bots.json"), { seed: [] });
    await store.load();
    const created = await store.create(input("duplicate"));
    await assert.rejects(store.create(input("duplicate", { name: "Second" })), (error: unknown) => {
      assert.ok(error instanceof DuplicateBotIdError);
      assert.equal(error.name, "DuplicateBotIdError");
      assert.equal(error.status, 409);
      assert.equal(error.botId, "duplicate");
      return true;
    });
    assert.deepEqual(store.list(), [created]);

    const race = await Promise.allSettled([
      store.create(input("race")),
      store.create(input("race")),
    ]);
    assert.equal(race.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(store.list().filter((bot) => bot.id === "race").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an interrupted write leaves the previous document and no temporary file", async () => {
  const dir = await scratch();
  try {
    const file = join(dir, "bots.json");
    let fail = false;
    const store = new BotStore(file, {
      seed: [],
      beforeRename: () => {
        if (fail) throw new Error("rename interrupted");
      },
    });
    await store.load();
    await store.create(input("keeper"));
    fail = true;
    await assert.rejects(store.create(input("lost")), /rename interrupted/);
    assert.deepEqual(
      store.list().map((bot) => bot.id),
      ["keeper"],
    );
    const written = JSON.parse(await readFile(file, "utf8")) as {
      bots: { id: string }[];
    };
    assert.deepEqual(
      written.bots.map((bot) => bot.id),
      ["keeper"],
    );
    assert.deepEqual(await readdir(dir), ["bots.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a restart reloads the same definitions from disk", async () => {
  const dir = await scratch();
  try {
    const file = join(dir, "bots.json");
    const first = new BotStore(file, { seed: [] });
    await first.load();
    const created = await first.create(
      input("hunter", {
        name: "Hunter",
        systemPrompt: "Find the next small repair.",
        tools: ["propose_task", "task_view"],
      }),
    );
    const second = new BotStore(file, { seed: [] });
    await second.load();
    assert.deepEqual(second.get("hunter"), created);
    assert.deepEqual(second.list(), [created]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the id is write-once and a PATCH updates the mutable fields", async () => {
  const dir = await scratch();
  try {
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    const store = new BotStore(join(dir, "bots.json"), {
      seed: [],
      now: () => new Date(clock),
    });
    await store.load();
    const created = await store.create(input("hunter"));
    clock += 1_000;
    const updated = await store.update("hunter", {
      id: "hunter",
      name: "Job hunter",
      systemPrompt: "Only propose tasks.",
      tools: ["propose_task"],
      model: "anthropic/example",
    });
    assert.equal(updated.id, "hunter");
    assert.equal(updated.createdAt, created.createdAt);
    assert.notEqual(updated.updatedAt, created.updatedAt);
    assert.equal(updated.name, "Job hunter");
    assert.deepEqual(updated.tools, ["propose_task"]);
    assert.equal(updated.model, "anthropic/example");
    await assert.rejects(store.update("hunter", { id: "renamed" }), (error: unknown) => {
      assert.ok(error instanceof BotError);
      assert.equal(error.code, "id-immutable");
      return true;
    });
    assert.equal(store.get("hunter")?.id, "hunter");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the bot tool catalog is composed once and matches the allowance catalog", () => {
  const names = botTools({} as TaskBridge).map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual([...names].sort(), [...BOT_TOOL_CATALOG].sort());
});

test("a definition may not list a tool outside the catalog", async () => {
  const dir = await scratch();
  try {
    const store = new BotStore(join(dir, "bots.json"), { seed: [] });
    await store.load();
    await assert.rejects(store.create(input("shell", { tools: ["bash"] })), (error: unknown) => {
      assert.ok(error instanceof BotError);
      assert.equal(error.name, "BotError");
      assert.equal(error.code, "unknown-tool");
      return true;
    });
    assert.deepEqual(store.list(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a tool outside the bot's allowance is refused by name", () => {
  const hunter = { id: "job-hunter", tools: [...JOB_HUNTER_TOOLS] };
  assert.doesNotThrow(() => assertBotToolAllowed(hunter, "propose_task"));
  assert.throws(
    () => assertBotToolAllowed(hunter, "task_done"),
    (error: unknown) => {
      assert.ok(error instanceof BotToolNotAllowedError);
      assert.equal(error.name, "BotToolNotAllowedError");
      assert.equal(error.status, 403);
      assert.equal(error.code, "tool-not-allowed");
      assert.equal(error.toolName, "task_done");
      assert.deepEqual(error.allowed, [...JOB_HUNTER_TOOLS]);
      assert.match(error.message, /not allowed to call task_done/);
      return true;
    },
  );

  const allowance = new BotToolAllowance(hunter);
  assert.equal(allowance.beforeTool({ name: "task_list" }), undefined);
  const blocked = allowance.beforeTool({ name: "task_done" });
  assert.ok(blocked !== undefined);
  assert.match(blocked.block, /not allowed to call task_done/);
  assert.match(blocked.block, /propose_task, task_list, task_view/);
  allowance.assert("task_list");
  assert.throws(
    () => allowance.assert("task_done"),
    (error: unknown) => error instanceof BotToolNotAllowedError,
  );
});

test("every bot keeps its conversation and pointer in its own directory", () => {
  const hunter = botChatPaths("/data/pi-ui", "job-hunter");
  const reviewer = botChatPaths("/data/pi-ui", "reviewer");
  assert.equal(hunter.identity, "bot:job-hunter");
  assert.equal(reviewer.identity, "bot:reviewer");
  assert.notEqual(hunter.dir, reviewer.dir);
  assert.notEqual(hunter.databasePath, reviewer.databasePath);
  assert.notEqual(hunter.currentPath, reviewer.currentPath);
  assert.ok(hunter.databasePath.startsWith(hunter.dir));
  assert.ok(hunter.currentPath.startsWith(hunter.dir));
});

test("the catalog is the set of names the chat lane can offer", () => {
  assert.ok(BOT_TOOL_CATALOG.includes("propose_task"));
  assert.ok(BOT_TOOL_CATALOG.includes("task_list"));
  assert.ok(BOT_TOOL_CATALOG.includes("read"));
  assert.ok(!(BOT_TOOL_CATALOG as readonly string[]).includes("bash"));
  assert.equal(new Set(BOT_TOOL_CATALOG).size, BOT_TOOL_CATALOG.length);
});
