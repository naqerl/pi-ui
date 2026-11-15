import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { startMcpRuntime } from "../src/server/mcp-runtime.js";
import { composeInstructions, SnapshotCache } from "../src/server/memory/snapshot.js";
import { MemoryStore } from "../src/server/memory/store.js";
import { reloadModelCatalog } from "../src/server/models.js";
import { createReloadTool, type ReloadHooks } from "../src/server/reload-tools.js";

interface Summary {
  target: string;
  ok: boolean;
  details: Record<string, unknown>;
  errors: string[];
}

async function runTool(
  tool: ToolRegistration,
  args: Record<string, unknown>,
): Promise<{ summary: Summary; result: Awaited<ReturnType<ToolRegistration["execute"]>> }> {
  const result = await tool.execute(args, {} as never, {} as never);
  const details = result.details as unknown;
  assert.ok(typeof details === "object" && details !== null, "the reload result has details");
  return { summary: details as Summary, result };
}

async function tempDir(t: { after: (fn: () => Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-reload-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function writeMcpConfig(agentDir: string, servers: Record<string, unknown>): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await writeFile(
    join(agentDir, "mcp.json"),
    JSON.stringify({
      mcpServers: { ...servers, web: { command: process.execPath, disabled: true } },
    }),
  );
}

interface FakeProtocolConnection {
  server: string;
  client: { close(): Promise<void> };
  transport: { close(): Promise<void> };
  controller: AbortController;
}

interface RuntimeInternals {
  channels: Map<string, { failTransport(error: unknown, reason: string): Promise<void> }>;
  protocolConnections: Set<FakeProtocolConnection>;
  pollSessions: Map<string, { close(): void }>;
}

function internals(runtime: Awaited<ReturnType<typeof startMcpRuntime>>): RuntimeInternals {
  return runtime as unknown as RuntimeInternals;
}

test("mcp reload reconnects changed servers, adds and drops servers, and keeps the old connection on failure", async (t) => {
  const root = await tempDir(t);
  const agentDir = join(root, "agent");
  const stub = resolve("e2e/stub-mcp.mjs");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });

  await writeMcpConfig(agentDir, {
    stub: { command: process.execPath, args: [stub] },
  });
  const runtime = await startMcpRuntime();
  try {
    assert.ok(runtime.toolNames.includes("stub__echo"));
    const before = await runtime.shim.callTool("stub__echo", { text: "one" });
    assert.equal(before.content[0]?.type, "text");

    const state = internals(runtime);
    const closed: string[] = [];
    state.protocolConnections.add({
      server: "stub",
      client: { close: async () => void closed.push("client") },
      transport: { close: async () => void closed.push("transport") },
      controller: new AbortController(),
    });
    state.pollSessions.set("stub", { close: () => void closed.push("poll") });

    await writeMcpConfig(agentDir, {
      stub: { command: process.execPath, args: [stub, "--changed"] },
    });
    const configBefore = await readFile(join(agentDir, "mcp.json"), "utf8");
    let result = await runtime.reload();
    assert.equal(await readFile(join(agentDir, "mcp.json"), "utf8"), configBefore);
    assert.deepEqual(result, {
      ok: true,
      added: 0,
      removed: 0,
      changed: 1,
      unchanged: 0,
      errors: [],
    });
    const afterChange = await runtime.shim.callTool("stub__echo", { text: "two" });
    assert.equal(afterChange.content[0]?.type, "text");
    assert.deepEqual(closed.sort(), ["client", "poll", "transport"]);
    assert.equal(state.pollSessions.has("stub"), false);
    assert.equal(
      [...state.protocolConnections].some((connection) => connection.server === "stub"),
      false,
    );

    const held: string[] = [];
    const heldProtocol: FakeProtocolConnection = {
      server: "stub",
      client: { close: async () => void held.push("client") },
      transport: { close: async () => void held.push("transport") },
      controller: new AbortController(),
    };
    state.protocolConnections.add(heldProtocol);
    state.pollSessions.set("stub", { close: () => void held.push("poll") });

    await writeMcpConfig(agentDir, {
      stub: { command: "/nonexistent/pi-ui-reload-server" },
    });
    result = await runtime.reload();
    assert.equal(result.ok, false);
    assert.equal(result.changed, 1);
    assert.match(result.errors.join("\n"), /previous connection kept/);
    const afterFailure = await runtime.shim.callTool("stub__echo", { text: "three" });
    assert.equal(afterFailure.isError, undefined);
    assert.deepEqual(held, []);
    assert.ok(state.pollSessions.has("stub"));
    assert.ok(state.protocolConnections.has(heldProtocol));

    await writeFile(join(agentDir, "mcp.json"), "{not json");
    result = await runtime.reload();
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /previous connections kept/);
    const afterParseFailure = await runtime.shim.callTool("stub__echo", { text: "four" });
    assert.equal(afterParseFailure.isError, undefined);

    await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: null }));
    result = await runtime.reload();
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /mcpServers must be an object/);
    const afterNestedFailure = await runtime.shim.callTool("stub__echo", { text: "five" });
    assert.equal(afterNestedFailure.isError, undefined);
    assert.deepEqual(held, []);
    assert.ok(state.protocolConnections.has(heldProtocol));

    await writeMcpConfig(agentDir, {
      stub: { command: process.execPath, args: [stub] },
      extra: { command: process.execPath, args: [stub] },
    });
    result = await runtime.reload();
    assert.equal(result.ok, true);
    assert.equal(result.added, 1);
    assert.equal(result.changed, 1, "stub moves from the broken config back to the original one");
    assert.equal(result.unchanged, 0);
    assert.ok(runtime.toolNames.includes("extra__echo"));

    await writeMcpConfig(agentDir, {
      extra: { command: process.execPath, args: [stub] },
    });
    result = await runtime.reload();
    assert.equal(result.ok, true);
    assert.equal(result.removed, 1);
    assert.equal(result.unchanged, 1);
    assert.ok(!runtime.toolNames.includes("stub__echo"));
    assert.ok(runtime.toolNames.includes("extra__echo"));
  } finally {
    await runtime.close();
  }
});

test("removing a server whose adapter already failed still removes its registered tools", async (t) => {
  const root = await tempDir(t);
  const agentDir = join(root, "agent");
  const stub = resolve("e2e/stub-mcp.mjs");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });

  await writeMcpConfig(agentDir, {
    stub: { command: process.execPath, args: [stub] },
  });
  const runtime = await startMcpRuntime();
  try {
    const channel = internals(runtime).channels.get("stub");
    assert.ok(channel);
    await channel.failTransport(new Error("adapter lost"), "server unreachable");
    assert.ok(
      runtime.toolNames.includes("stub__echo"),
      "the passthrough stays registered while down",
    );

    await writeMcpConfig(agentDir, {});
    const result = await runtime.reload();
    assert.equal(result.ok, true);
    assert.equal(result.removed, 1);
    assert.ok(!runtime.toolNames.includes("stub__echo"));
  } finally {
    await runtime.close();
  }
});

test("prompt reload rebuilds the memory snapshot instructions from changed files", async (t) => {
  const root = await tempDir(t);
  const store = new MemoryStore(join(root, "memory"));
  await store.ensure();
  await writeFile(store.memoryFile, "# Rules\n\nUse the first rule.\n");
  const cache = new SnapshotCache();
  const base = "base instructions";
  let instructions = composeInstructions(base, await cache.get(store, "first_turn"));
  const original = instructions;

  const tool = createReloadTool({
    mcp: async () => ({ ok: true, details: {} }),
    prompt: async () => {
      const next = composeInstructions(base, await cache.get(store, "reload"));
      const changed = next !== instructions;
      instructions = next;
      return { ok: true, details: { changed, chars: next.length } };
    },
  });

  await writeFile(store.memoryFile, "# Rules\n\nUse the second rule.\n");
  const { summary } = await runTool(tool, { target: "prompt" });
  assert.equal(summary.ok, true);
  assert.equal(summary.details.changed, true);
  assert.notEqual(instructions, original);
  assert.match(instructions, /Use the second rule/);
});

test("models reload exposes a newly added models.json entry", async (t) => {
  const root = await tempDir(t);
  const modelsPath = join(root, "models.json");
  const authPath = join(root, "auth.json");
  const writeModels = (ids: string[]) =>
    writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: "http://127.0.0.1:9/v1",
            api: "openai-completions",
            apiKey: "fixture",
            models: ids.map((id) => ({
              id,
              name: id,
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 10_000,
              maxTokens: 1_000,
            })),
          },
        },
      }),
    );

  await writeModels(["first-model"]);
  const runtime = await ModelRuntime.create({
    modelsPath,
    authPath,
    allowModelNetwork: false,
  });
  const tool = createReloadTool({
    mcp: async () => ({ ok: true, details: {} }),
    models: async () => {
      const result = await reloadModelCatalog(runtime);
      return {
        ok: result.errors.length === 0,
        details: {
          total: result.models.length,
          added: result.added,
          removed: result.removed,
          models: result.models,
        },
        errors: [...result.errors],
      };
    },
  });

  await writeModels(["first-model", "second-model"]);
  const { summary } = await runTool(tool, { target: "models" });
  assert.equal(summary.ok, true);
  const added = summary.details.added as { provider: string; id: string }[];
  assert.deepEqual(
    added.map((model) => `${model.provider}/${model.id}`),
    ["fixture/second-model"],
  );
  assert.ok(runtime.getModel("fixture", "second-model"));
});

test("all keeps going after one target fails and a concurrent call returns busy", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  const hooks: ReloadHooks = {
    mcp: async () => {
      await gate;
      return { ok: true, details: { changed: 0 } };
    },
    prompt: async () => ({ ok: false, details: {}, errors: ["prompt broke"] }),
    models: async () => ({ ok: true, details: { added: 1 } }),
  };
  const tool = createReloadTool(hooks);

  const first = runTool(tool, { target: "all" });
  const busy = await runTool(tool, { target: "mcp" });
  assert.equal(busy.summary.ok, false);
  assert.equal(busy.summary.details.busy, true);
  assert.match(busy.summary.errors.join("\n"), /already running/);

  release?.();
  const { summary } = await first;
  assert.equal(summary.ok, false);
  const details = summary.details as Record<string, { ok: boolean }>;
  assert.equal(details.mcp?.ok, true);
  assert.equal(details.prompt?.ok, false);
  assert.equal(details.models?.ok, true);
  assert.match(summary.errors.join("\n"), /prompt: prompt broke/);
});
