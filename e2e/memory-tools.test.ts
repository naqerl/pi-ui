import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryStore } from "../src/server/memory/store.js";
import {
  createMemoryTools,
  type MemoryGrepDetails,
  type MemoryGrepHit,
} from "../src/server/memory/tools.js";

type ToolResult = Awaited<ReturnType<typeof callTool>>;

async function freshStore(t: { after: (fn: () => Promise<void>) => void }): Promise<MemoryStore> {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-tools-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const store = new MemoryStore(root);
  await store.ensure();
  return store;
}

async function callTool(
  store: MemoryStore,
  name: string,
  args: Record<string, unknown>,
): Promise<Awaited<ReturnType<ReturnType<typeof createMemoryTools>[number]["execute"]>>> {
  const tool = createMemoryTools(store).find((item) => item.name === name);
  assert.ok(tool, `${name} is registered`);
  return tool.execute(args as never, {} as never, {} as never);
}

function outputText(result: ToolResult): string {
  const output = Array.isArray(result.output) ? result.output[0] : undefined;
  return output?.type === "text" ? output.text : "";
}

function grepDetails(result: ToolResult): MemoryGrepDetails {
  return result.details as unknown as MemoryGrepDetails;
}

function hitFor(details: MemoryGrepDetails, path: string): MemoryGrepHit | undefined {
  return details.hits.find((hit) => hit.path === path);
}

test("memory_grep finds a literal across topics, an index and a daily with 1-based lines", async (t) => {
  const store = await freshStore(t);
  await store.atomicWrite(
    join(store.topicsDir, "projects", "alpha.md"),
    "# Alpha\n\nfirst line\ncursorDelta lives here\n",
  );
  await store.atomicWrite(
    join(store.topicsDir, "projects", "INDEX.md"),
    "# projects — project notes\n\n- [Alpha](alpha.md) — mentions cursorDelta\n",
  );
  await store.atomicWrite(
    join(store.dailyDir, "2026-11-03.md"),
    "<!-- 2026-11-03T10:00:00.000Z [s1] -->\n## note\n\ncursorDelta in a daily note\n",
  );

  const result = await callTool(store, "memory_grep", { pattern: "cursordelta" });
  const details = grepDetails(result);
  const output = outputText(result);

  assert.equal(result.isError, undefined);
  assert.equal(details.topics, 3);
  assert.equal(details.hits.length, 3);
  assert.deepEqual([...details.paths].sort(), [
    "daily/2026-11-03.md",
    "topics/projects/INDEX.md",
    "topics/projects/alpha.md",
  ]);
  assert.equal(hitFor(details, "topics/projects/alpha.md")?.line, 4);
  assert.equal(hitFor(details, "topics/projects/alpha.md")?.text, "cursorDelta lives here");
  assert.equal(hitFor(details, "topics/projects/INDEX.md")?.line, 3);
  assert.equal(hitFor(details, "daily/2026-11-03.md")?.line, 4);
  assert.ok(details.chars > 0);
  assert.match(output, /topics\/projects\/alpha\.md:4 — cursorDelta lives here/);
  assert.match(output, /3 hits in 3 files/);
});

test("memory_grep regex mode matches an alternation and rejects an invalid regex without throwing", async (t) => {
  const store = await freshStore(t);
  await store.atomicWrite(
    store.memoryFile,
    "# MEMORY\n\ncursorDelta one\ncursorSince two\ncursorOther three\n",
  );

  const result = await callTool(store, "memory_grep", { pattern: "cursor(Delta|Since)" });
  const details = grepDetails(result);
  assert.equal(result.isError, undefined);
  assert.deepEqual(
    details.hits.map((hit) => hit.line),
    [3, 4],
  );

  const invalid = await callTool(store, "memory_grep", { pattern: "cursor(" });
  assert.equal(invalid.isError, true);
  assert.match(outputText(invalid), /invalid regular expression/);
  assert.equal(invalid.details, undefined);
});

test("memory_grep fixed mode treats a dot literally while regex mode matches any character", async (t) => {
  const store = await freshStore(t);
  await store.atomicWrite(store.memoryFile, "# MEMORY\n\na.b literal\naxb regex\n");

  const fixed = await callTool(store, "memory_grep", { pattern: "a.b", fixed: true });
  assert.equal(grepDetails(fixed).hits.length, 1);
  assert.equal(grepDetails(fixed).hits[0]?.text, "a.b literal");

  const regex = await callTool(store, "memory_grep", { pattern: "a.b" });
  assert.equal(grepDetails(regex).hits.length, 2);
  assert.deepEqual(
    grepDetails(regex).hits.map((hit) => hit.text),
    ["a.b literal", "axb regex"],
  );
});

test("memory_grep limits at 40 by default and at the requested count", async (t) => {
  const store = await freshStore(t);
  const lines = Array.from({ length: 50 }, (_, index) => `needle ${index + 1}`);
  await store.atomicWrite(store.memoryFile, `# MEMORY\n\n${lines.join("\n")}\n`);

  const byDefault = await callTool(store, "memory_grep", { pattern: "needle" });
  assert.equal(grepDetails(byDefault).hits.length, 40);
  assert.match(outputText(byDefault), /40 hits in 1 files/);

  const requested = await callTool(store, "memory_grep", { pattern: "needle", limit: 7 });
  assert.equal(grepDetails(requested).hits.length, 7);
  assert.match(outputText(requested), /7 hits in 1 files/);
});

test("memory_read returns a requested line window and an empty past-the-end window", async (t) => {
  const store = await freshStore(t);
  const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
  const content = lines.join("\n");
  await store.atomicWrite(store.memoryFile, content);

  const result = await callTool(store, "memory_read", {
    path: "MEMORY.md",
    offset: 10,
    limit: 5,
  });
  const output = outputText(result);
  assert.equal(result.isError, undefined);
  assert.match(output, /^MEMORY\.md — lines 10–14 of 20\n\n/);
  assert.match(output, /line 10\nline 11\nline 12\nline 13\nline 14/);
  assert.match(output, /6 more lines \(call memory_read with offset=15\)/);
  assert.deepEqual(result.details, {
    kind: "memory",
    operation: "read",
    hits: 0,
    topics: 0,
    paths: [],
    chars: output.length,
    reads: [{ path: "MEMORY.md", from: 10, to: 14 }],
  });

  const past = await callTool(store, "memory_read", {
    path: "MEMORY.md",
    offset: 30,
    limit: 5,
  });
  assert.equal(past.isError, undefined);
  assert.equal(outputText(past), "MEMORY.md — lines 30–34 of 20");
});

test("memory_read without a window still returns the entire file", async (t) => {
  const store = await freshStore(t);
  const content = "line one\nline two\nline three";
  await store.atomicWrite(store.memoryFile, content);

  const result = await callTool(store, "memory_read", { path: "MEMORY.md" });
  assert.equal(result.isError, undefined);
  assert.equal(outputText(result), content);
  assert.equal((result.details as unknown as { chars: number }).chars, content.length);
  assert.deepEqual((result.details as unknown as { reads?: unknown }).reads, [
    { path: "MEMORY.md", from: 1, to: 3 },
  ]);
});
