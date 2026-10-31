import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { dreamMemory, prepareDream } from "../src/server/memory/dream.js";
import { findMemory } from "../src/server/memory/find.js";
import { buildIndexMap } from "../src/server/memory/index-map.js";
import { MAX_TOPIC_CHARS, migrateMemory, planMigration } from "../src/server/memory/migrate.js";
import {
  buildSnapshot,
  middleTruncate,
  SnapshotCache,
  SnapshotController,
  tailTruncate,
} from "../src/server/memory/snapshot.js";
import { MemoryStore, todayIso } from "../src/server/memory/store.js";
import { createMemoryTools } from "../src/server/memory/tools.js";

async function freshStore(t: { after: (fn: () => Promise<void>) => void }): Promise<MemoryStore> {
  const root = await mkdtemp(join(tmpdir(), "pi-memory-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const store = new MemoryStore(root);
  await store.ensure();
  return store;
}

const FIXTURE = `# MEMORY

Operator notes for example.test. Invented fixture, no live install data.

## Standing rules

- Never store credentials in memory.
- Prefer exact values over summaries.

## Project: widget-service

widget-service serves the widget API on example.test. It verifies requests with a local
verifier and reports aggregate counts every minute.

## Machine: build-box-01

build-box-01 has 4 cpus and 8 GB of memory. The build directory is /srv/example-build.

## Pi harness

The harness loads three explicit extensions and records a run marker for every turn.

## Working style

Short answers first, then a compact rationale. Prefer measured values over adjectives.

## Loose note

The widget-service queue is drained by a single worker in this fixture.
`;

async function writeMemory(store: MemoryStore, contents: string): Promise<void> {
  await store.atomicWrite(store.memoryFile, contents);
}

function nonWhitespace(value: string): string {
  return value.replace(/\s+/g, "");
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

test("migrate dry-runs without writing and --apply produces one topic per section", async (t) => {
  const store = await freshStore(t);
  await writeMemory(store, FIXTURE);
  const dry = await migrateMemory(store);
  assert.equal(dry.applied, false);
  assert.equal(dry.plan.topics.length, 5);
  await assert.rejects(readFile(join(store.topicsDir, "INDEX.md"), "utf8"));

  const applied = await migrateMemory(store, { apply: true });
  assert.equal(applied.applied, true);
  assert.equal(applied.plan.topics.length, 5);
  const files: string[] = [];
  for (const scope of await readdir(store.topicsDir)) {
    if (scope === "INDEX.md") continue;
    for (const name of await readdir(join(store.topicsDir, scope))) {
      if (name !== "INDEX.md") files.push(`${scope}/${name}`);
    }
  }
  assert.equal(files.length, 5);
  const memory = await readFile(store.memoryFile, "utf8");
  assert.match(memory, /## Standing rules/);
  assert.match(memory, /<!-- MAP:BEGIN -->/);
  assert.doesNotMatch(memory, /widget API on example\.test/);
  assert.doesNotMatch(memory, /build-box-01 has 4 cpus/);
});

test("migrate loses no non-whitespace character from the source", async (t) => {
  const store = await freshStore(t);
  await writeMemory(store, FIXTURE);
  const result = await migrateMemory(store, { apply: true });
  const plan = result.plan;
  const reconstructed =
    plan.preamble +
    plan.inline.map((section) => section.body).join("") +
    plan.topics.map((topic) => topic.body).join("");
  assert.equal(
    nonWhitespace(reconstructed).split("").sort().join(""),
    nonWhitespace(FIXTURE).split("").sort().join(""),
  );
  const read: string[] = [];
  for (const topic of plan.topics) {
    read.push((await store.readTopic(`topics/${topic.scope}/${topic.file}`)).body);
  }
  assert.equal(
    nonWhitespace(read.join("")),
    nonWhitespace(plan.topics.map((topic) => topic.body).join("")),
  );
});

test("carve splits an oversized body on headings before paragraph boundaries", async () => {
  let body = "## Project: big-service\n\n";
  for (let index = 0; index < 18; index += 1) {
    body += `Paragraph ${index} ${"detail ".repeat(30)}\n\n`;
  }
  body += `### Section one\n\n${"heading detail ".repeat(260)}\n\n`;
  body += `### Section two\n\n${"other detail ".repeat(260)}\n\n`;
  const root = await mkdtemp(join(tmpdir(), "pi-memory-carve-"));
  try {
    const plan = planMigration(`# MEMORY\n\n## Standing rules\n\n- one\n\n${body}`);
    assert.ok(body.length > MAX_TOPIC_CHARS);
    assert.ok(plan.topics.length >= 2);
    assert.ok(plan.topics.some((topic) => topic.title.includes("— Section")));
    assert.ok(plan.topics.every((topic) => topic.body.length <= MAX_TOPIC_CHARS));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("carve falls back to paragraph boundaries when headings alone cannot split", () => {
  let body = "## Project: paragraph-service\n\n";
  for (let index = 0; index < 40; index += 1) {
    body += `Paragraph ${index} ${"paragraph detail ".repeat(30)}\n\n`;
  }
  const plan = planMigration(`# MEMORY\n\n## Standing rules\n\n- one\n\n${body}`);
  assert.ok(plan.topics.length > 1);
  assert.ok(plan.topics.every((topic) => topic.body.length <= MAX_TOPIC_CHARS));
});

test("two index builds are byte-identical and leave the standing rules untouched", async (t) => {
  const store = await freshStore(t);
  await writeMemory(store, FIXTURE);
  await migrateMemory(store, { apply: true });
  const before = await readFile(store.memoryFile, "utf8");
  const rulesBefore = before.slice(
    before.indexOf("## Standing rules"),
    before.indexOf("<!-- MAP:BEGIN -->"),
  );
  await buildIndexMap(store);
  const once = await readFile(store.memoryFile, "utf8");
  await buildIndexMap(store);
  const twice = await readFile(store.memoryFile, "utf8");
  assert.equal(once, twice);
  const rulesAfter = twice.slice(
    twice.indexOf("## Standing rules"),
    twice.indexOf("<!-- MAP:BEGIN -->"),
  );
  assert.equal(rulesAfter, rulesBefore);
  assert.match(twice, /topics\/projects\/INDEX\.md/);
  assert.match(twice, /topics\/machines\/INDEX\.md/);
  assert.ok(twice.length < 4000);
});

test("find ranks an exact token above a prefix-only match and excludes INDEX.md", async (t) => {
  const store = await freshStore(t);
  await writeMemory(store, "# MEMORY\n\n## Standing rules\n\n- none\n");
  await store.createTopic({
    title: "Alpha",
    body: "# Alpha\n\nverify verify the exact token appears twice.",
    scope: "projects",
  });
  await store.createTopic({
    title: "Beta",
    body: "# Beta\n\nverifier verifier is a prefix-only match here.",
    scope: "projects",
  });
  await store.createTopic({
    title: "Gamma",
    body: "# Gamma\n\nunrelated content about queues.",
    scope: "projects",
  });
  const exact = await findMemory(store, "verify", { record: false });
  assert.equal(exact[0]?.title, "Alpha");
  assert.ok(exact[0]?.snippet.length);
  const prefix = await findMemory(store, "verif", { record: false });
  assert.ok(prefix.some((result) => result.title === "Alpha"));
  assert.ok(prefix.some((result) => result.title === "Beta"));

  const usage = await store.readUsage();
  await findMemory(store, "unrelated queues");
  const recorded = await store.readUsage();
  assert.ok(Object.keys(recorded.hits).length >= Object.keys(usage.hits).length);

  const index = join(store.topicsDir, "projects", "INDEX.md");
  await writeFile(index, `${await readFile(index, "utf8")}\n- [verify](fake.md) — verify\n`);
  const all = await findMemory(store, "verify", { record: false, limit: 20 });
  assert.ok(all.every((result) => !result.rel.endsWith("INDEX.md")));
});

test("dream attaches a journal block to its best topic", async (t) => {
  const store = await freshStore(t);
  await seedDreamTree(store);
  await writeFile(
    join(store.dailyDir, "2026-10-28.md"),
    `<!-- 2026-10-28T10:00:00.000Z [s1] -->
## widget-service verifier rollout

The widget-service verifier now rejects unsigned requests at the edge before the API handler runs.
Operators should watch the widget-service verifier metric during the rollout window today.
`,
  );
  const report = await prepareDream(store);
  const target = [...report.attached.keys()].find((rel) => rel.includes("widget-service"));
  assert.ok(
    target,
    `expected widget-service target, got ${[...report.attached.keys()].join(", ")}`,
  );
  assert.equal(report.attached.get(target)?.blocks.length, 1);
});

test("dream flags two near-identical blocks within one target", async (t) => {
  const store = await freshStore(t);
  await seedDreamTree(store);
  await writeFile(
    join(store.dailyDir, "2026-10-28.md"),
    `<!-- 2026-10-28T10:00:00.000Z [s1] -->
## widget-service verifier rollout

The widget-service verifier now rejects unsigned requests at the edge before the handler runs.
Malformed widget-service payloads never reach the widget-service processing queue today.
The rollout window is watched by the widget-service verifier dashboard every minute today.

<!-- 2026-10-28T11:00:00.000Z [s2] -->
## widget-service verifier rollout

The widget-service verifier now rejects unsigned requests at the edge before the handler runs.
Malformed widget-service payloads never reach the widget-service processing queue today.
The rollout window is watched by the widget-service verifier dashboard every minute tomorrow.
`,
  );
  const report = await prepareDream(store);
  assert.ok(report.duplicates.length >= 1);
  assert.ok(report.duplicates[0]?.score >= 0.7);
});

test("dream --emit writes one work item per merge target", async (t) => {
  const store = await freshStore(t);
  await seedDreamTree(store);
  await writeFile(
    join(store.dailyDir, "2026-10-28.md"),
    `<!-- 2026-10-28T10:00:00.000Z [s1] -->
## widget-service verifier rollout

The widget-service verifier now rejects unsigned requests at the edge before the API handler runs.
Operators should watch the widget-service verifier metric during the rollout window today.
`,
  );
  const emitDir = join(store.root, ".dream-emit");
  const outcome = await dreamMemory(store, { emitDir });
  const report = await prepareDream(store);
  assert.equal(outcome.emitted.length, report.attached.size);
  const names = await readdir(emitDir);
  assert.equal(names.length, report.attached.size);
  const first = await readFile(join(emitDir, names[0] as string), "utf8");
  assert.match(first, /## Rules/);
  assert.match(first, /## Current body/);
  assert.match(first, /## Blocks to fold/);
  assert.match(first, /Merge into topics\//);
});

test("dream --commit archives every daily log except today and records consumed", async (t) => {
  const store = await freshStore(t);
  await writeMemory(store, "# MEMORY\n\n## Standing rules\n\n- none\n");
  await store.createTopic({
    title: "Widget service",
    body: "# Widget service\n\nwidget-service notes for the fixture.",
    scope: "projects",
  });
  await buildIndexMap(store);
  const oldOne = isoDaysAgo(3);
  const oldTwo = isoDaysAgo(1);
  const today = todayIso();
  for (const date of [oldOne, oldTwo, today]) {
    await writeFile(
      join(store.dailyDir, `${date}.md`),
      `<!-- ${date}T10:00:00.000Z [s1] -->\n## note\n\nA line long enough to be a journalled block for the fixture.\n`,
    );
  }
  const outcome = await dreamMemory(store, { commit: true });
  assert.equal(outcome.archived.length, 2);
  const left = await store.dailyDates();
  assert.deepEqual(left, [today]);
  const state = await store.readDreamState();
  assert.ok(state.consumed.includes(`${oldOne}.md`));
  assert.ok(state.consumed.includes(`${oldTwo}.md`));
  assert.ok(!state.consumed.includes(`${today}.md`));
  const archiveDir = join(store.archiveDir, today.slice(0, 7));
  const archived = await readdir(archiveDir);
  assert.ok(archived.includes(`${oldOne}.md`));
  assert.ok(archived.includes(`${oldTwo}.md`));
});

test("a second topic write is a clean overwrite without duplication", async (t) => {
  const store = await freshStore(t);
  const created = await store.createTopic({
    title: "Widget service",
    body: "# Widget service\n\nold body that must disappear.",
    scope: "projects",
  });
  await store.writeTopic(created.rel, "# Widget service\n\nnew body with the current truth.", {
    scope: "projects",
    title: "Widget service",
  });
  const raw = await readFile(join(store.topicsDir, created.rel.replace(/^topics\//, "")), "utf8");
  assert.equal((raw.match(/^---$/gm) ?? []).length, 2);
  assert.doesNotMatch(raw, /old body/);
  assert.match(raw, /new body/);
  const index = await readFile(join(store.topicsDir, "projects", "INDEX.md"), "utf8");
  const lines = index.split("\n").filter((line) => line.includes(`](${created.file})`));
  assert.equal(lines.length, 1);
});

test("the snapshot is byte-identical across calls without a checkpoint", async (t) => {
  const store = await freshStore(t);
  await writeMemory(store, FIXTURE);
  await migrateMemory(store, { apply: true });
  await store.appendDaily("A daily note long enough to appear in the injected tail.", "s1");
  await store.appendScratchpad("first open item");
  const cache = new SnapshotCache();
  const first = await cache.get(store, "first_turn");
  const second = await cache.get(store, "first_turn");
  assert.equal(first, second);
  await store.appendDaily("A newer daily note that must not invalidate the prefix.", "s1");
  await store.appendScratchpad("second open item");
  const third = await cache.get(store, "first_turn");
  assert.equal(third, first);
});

test("the snapshot changes after a long-term write", async (t) => {
  const store = await freshStore(t);
  await writeMemory(store, FIXTURE);
  await migrateMemory(store, { apply: true });
  const cache = new SnapshotCache();
  const before = await cache.get(store, "first_turn");
  await store.createTopic({
    title: "Widget cache",
    body: "# Widget cache\n\nThe widget cache keeps the last 200 responses.",
    scope: "projects",
  });
  const after = await cache.get(store, "long_term_write");
  assert.notEqual(after, before);
  assert.match(after, /long_term_write/);
});

test("the snapshot honours its caps and truncates in the middle", async (t) => {
  const store = await freshStore(t);
  await writeMemory(store, `# MEMORY\n\n${"index line\n".repeat(2000)}`);
  await store.atomicWrite(join(store.dailyDir, `${todayIso()}.md`), "today line\n".repeat(800));
  await store.appendScratchpad("scratch ".repeat(1000));
  const snapshot = await buildSnapshot(store, "first_turn");
  assert.ok(snapshot.length <= 4000);
  assert.match(snapshot, /\.\.\. \(truncated\) \.\.\./);
  assert.ok(middleTruncate("x".repeat(5000), 1800).length <= 1800);
  assert.ok(tailTruncate("y".repeat(5000), 1200).length <= 1200);
});

test("writeTopic rejects a scope that disagrees with the topic path", async (t) => {
  const store = await freshStore(t);
  const created = await store.createTopic({
    title: "Widget service",
    body: "# Widget service\n\nthe original body stays put.",
    scope: "projects",
  });
  await assert.rejects(
    store.writeTopic(created.rel, "# Widget service\n\nthis must not land.", {
      scope: "machines",
      title: "Widget service",
    }),
    /does not match/,
  );
  const unchanged = await store.readTopic(created.rel);
  assert.match(unchanged.body, /original body stays put/);
  assert.deepEqual(await store.scopeIndex("machines"), []);
});

test("concurrent same-title creates keep both bodies and choose distinct files", async (t) => {
  const store = await freshStore(t);
  const [first, second] = await Promise.all([
    store.createTopic({
      title: "Widget service",
      body: "# Widget service\n\nfirst concurrent body.",
      scope: "projects",
    }),
    store.createTopic({
      title: "Widget service",
      body: "# Widget service\n\nsecond concurrent body.",
      scope: "projects",
    }),
  ]);
  assert.notEqual(first.rel, second.rel);
  const bodies = [(await store.readTopic(first.rel)).body, (await store.readTopic(second.rel)).body]
    .map((body) => body.trim())
    .sort();
  assert.deepEqual(bodies, [
    "# Widget service\n\nfirst concurrent body.",
    "# Widget service\n\nsecond concurrent body.",
  ]);
});

test("dream keeps short journal lines and emits the full block text", async (t) => {
  const store = await freshStore(t);
  await seedDreamTree(store);
  const block = `<!-- 2026-10-28T10:00:00.000Z [s1] -->
## widget-service verifier
verifier rejects unsigned.
widget-service queue fine.
`;
  await writeFile(join(store.dailyDir, "2026-10-28.md"), block);
  const report = await prepareDream(store);
  assert.equal(report.blocks.length, 1);
  assert.equal(
    report.blocks[0]?.text,
    "## widget-service verifier\nverifier rejects unsigned.\nwidget-service queue fine.",
  );
  const target = [...report.attached.keys()].find((rel) => rel.includes("widget-service"));
  assert.ok(target, `expected a target, got ${[...report.attached.keys()].join(", ")}`);
  const emitDir = join(store.root, ".dream-short");
  await dreamMemory(store, { emitDir });
  const names = await readdir(emitDir);
  const emitted = await readFile(join(emitDir, names[0] as string), "utf8");
  assert.match(emitted, /verifier rejects unsigned\./);
  assert.match(emitted, /widget-service queue fine\./);
});

test("a snapshot controller reconfigures only at a checkpoint", async (t) => {
  const store = await freshStore(t);
  await writeMemory(store, FIXTURE);
  await migrateMemory(store, { apply: true });
  const applied: string[] = [];
  const controller = new SnapshotController(store, "BASE INSTRUCTIONS", async (next) => {
    applied.push(next);
  });
  const first = await controller.refresh("first_turn");
  assert.equal(applied.length, 1);
  await store.appendDaily("a daily note that must not change the prefix", "s1");
  await store.appendScratchpad("an open item");
  const second = await controller.refresh();
  assert.equal(second, first);
  assert.equal(applied.length, 1);

  await store.createTopic({
    title: "Widget cache",
    body: "# Widget cache\n\nthe cache keeps 200 responses.",
    scope: "projects",
  });
  const third = await controller.refresh();
  assert.notEqual(third, first);
  assert.match(third, /long_term_write/);
  assert.equal(applied.length, 2);
  assert.ok(third.startsWith("BASE INSTRUCTIONS\n\n"));
});

test("a successful memory_write reports its path and written text", async (t) => {
  const store = await freshStore(t);
  const writes: { path: string; text: string }[] = [];
  const tools = new Map(
    createMemoryTools(store, undefined, {
      onWrite: (record) => {
        writes.push(record);
      },
    }).map((tool) => [tool.name, tool]),
  );
  const write = tools.get("memory_write");
  assert.ok(write);
  const run = (args: Record<string, unknown>) =>
    write.execute(args as never, {} as never, {} as never);

  await run({
    target: "long_term",
    topic: "widget-cache",
    scope: "projects",
    body: "# Widget cache\n\nthe cache keeps 200 responses.",
  });
  assert.equal(writes[0]?.path, "topics/projects/widget-cache.md");
  assert.match(writes[0]?.text ?? "", /the cache keeps 200 responses/);

  await run({ target: "daily", body: "a daily note" });
  assert.equal(writes[1]?.path, `daily/${todayIso()}.md`);
  assert.equal(writes[1]?.text, "a daily note");

  await run({ target: "scratchpad", body: "an open item" });
  assert.equal(writes[2]?.path, "SCRATCHPAD.md");
  assert.equal(writes[2]?.text, "an open item");
});

test("the memory tool set is the five documented tools", async (t) => {
  const store = await freshStore(t);
  const names = createMemoryTools(store).map((tool) => tool.name);
  assert.deepEqual(names, [
    "memory_write",
    "memory_read",
    "memory_find",
    "memory_dream",
    "memory_status",
  ]);
});

async function seedDreamTree(store: MemoryStore): Promise<void> {
  await store.createTopic({
    title: "Widget service",
    body: `# Widget service

The widget-service verifier checks every request on example.test. The widget-service API handler
runs after the verifier accepts a request. The widget-service processing queue is drained by one
worker, and the widget-service verifier metric is reported every minute.`,
    scope: "projects",
  });
  const fillers = [
    ["Build box", "# Build box\n\nThe build box compiles artifacts."],
    ["Release steps", "# Release steps\n\nThe release lane tags and publishes artifacts."],
    ["Contact note", "# Contact note\n\nReply in the morning."],
    ["Pi skills", "# Pi skills\n\nSkills are discovered at startup."],
    ["Git forge", "# Git forge\n\nPull requests are stacked for delivery."],
  ];
  for (const [title, body] of fillers) {
    await store.createTopic({ title, body, scope: "misc" });
  }
}
