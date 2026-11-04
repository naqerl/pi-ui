import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createRegistry, Harness, LiveDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
  type DurableDocumentKind,
  durableDoctor,
  formatDoctorReport,
  materializeStoredDocument,
} from "../src/server/durable-doctor.ts";

async function makeDatabase(): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-durable-doctor-"));
  const path = join(dir, "pi.sqlite3");
  const storage = await openNodeSqliteStorage(path);
  await storage.close(BACKGROUND_CONTEXT);
  return { dir, path };
}

function addDocument(
  path: string,
  input: {
    id: number;
    kind: DurableDocumentKind;
    conversationId: number;
    revisions: readonly { seq: number; kind: "base" | "delta"; content: string }[];
    version?: number;
  },
): void {
  const db = new DatabaseSync(path);
  try {
    const record = {
      id: input.id,
      kind: input.kind,
      scope: { kind: "conversation", conversationId: input.conversationId },
      history: "latest",
      fork: "initial",
      createdAt: 1,
    };
    db.prepare(
      `INSERT INTO documents
        (id, kind, family, key_value, scope_kind, owner_id, created_at, retired_at, record)
       VALUES (?, ?, 0, '""', 'conversation', ?, 1, NULL, ?)`,
    ).run(input.id, JSON.stringify(input.kind), input.conversationId, JSON.stringify(record));
    const insert = db.prepare(
      `INSERT INTO document_revisions (document_id, seq, kind, version, content)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const revision of input.revisions) {
      insert.run(input.id, revision.seq, revision.kind, input.version ?? 1, revision.content);
    }
  } finally {
    db.close();
  }
}

const OBSERVED_SLOT = {
  callId: "chatcmpl-tool-8c5e0ccddd763a82",
  name: "bash",
  taskId: 30666,
  status: "pending",
};

test("a base and a replayed delta for the same tool slot materialise once", () => {
  const base = { tools: [OBSERVED_SLOT] };
  const delta = JSON.stringify([["s", ["tools", 0, "status"], "running"]]);
  const result = materializeStoredDocument("pi.live", [
    { seq: 10, kind: "base", version: 3, content: JSON.stringify(base) },
    { seq: 11, kind: "delta", version: 3, content: delta },
    { seq: 12, kind: "delta", version: 3, content: delta },
  ]);

  assert.equal(result.torn, false);
  assert.equal(result.skippedDeltas, 1);
  assert.deepEqual(result.value, {
    tools: [{ ...OBSERVED_SLOT, status: "running" }],
  });
});

test("a delta that cannot be applied falls back to the newest valid base", () => {
  const base = { tools: [] };
  const result = materializeStoredDocument("pi.live", [
    { seq: 20, kind: "base", version: 3, content: JSON.stringify(base) },
    { seq: 21, kind: "delta", version: 3, content: "{this is not json" },
  ]);

  assert.equal(result.torn, true);
  assert.equal(result.baseRevision, 20);
  assert.equal(result.droppedDeltas, 1);
  assert.deepEqual(result.value, base);
  assert.match(result.reason ?? "", /revision 21/);
});

test("a late failing delta reports every discarded delta", () => {
  const result = materializeStoredDocument("pi.live", [
    { seq: 1, kind: "base", version: 3, content: JSON.stringify({ tools: [] }) },
    {
      seq: 2,
      kind: "delta",
      version: 3,
      content: JSON.stringify([
        ["p", ["tools"], 0, 0, [{ callId: "c1", name: "bash", status: "pending" }]],
      ]),
    },
    {
      seq: 3,
      kind: "delta",
      version: 3,
      content: JSON.stringify([["s", ["missing", "slot"], true]]),
    },
  ]);
  assert.equal(result.torn, true);
  assert.equal(result.droppedDeltas, 2);
  assert.deepEqual(result.value, { tools: [] });
});

test("durableDoctor reads a real Harness-created JSON-encoded live document", async () => {
  const { dir, path } = await makeDatabase();
  try {
    const storage = await openNodeSqliteStorage(path);
    const harness = await Harness.open(
      storage,
      { models: createModels() as never, registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    const conversation = await harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { cwd: dir, instructions: "test" } },
      BACKGROUND_CONTEXT,
    );
    await conversation.commit(async (tx) => {
      await tx.doc(LiveDoc, conversation.id);
    }, BACKGROUND_CONTEXT);
    await harness.close(BACKGROUND_CONTEXT);

    const db = new DatabaseSync(path);
    let liveId = 0;
    try {
      const row = db
        .prepare("SELECT id, kind FROM documents WHERE kind = ? AND owner_id = ?")
        .get(JSON.stringify("pi.live"), conversation.id) as
        | { id: number; kind: string }
        | undefined;
      assert.ok(row !== undefined, "the package stores the kind JSON-encoded");
      assert.equal(row.kind, JSON.stringify("pi.live"));
      liveId = Number(row.id);
      const max = db
        .prepare("SELECT MAX(seq) AS seq FROM document_revisions WHERE document_id = ?")
        .get(liveId) as { seq: number };
      db.prepare(
        "INSERT INTO document_revisions (document_id, seq, kind, version, content) VALUES (?, ?, 'delta', 3, ?)",
      ).run(liveId, Number(max.seq) + 1, JSON.stringify([["s", ["missing", "slot"], true]]));
    } finally {
      db.close();
    }

    const report = await durableDoctor({ databasePath: path, repair: true });
    const liveReport = report.documents.find((document) => document.documentId === liveId);
    assert.ok(liveReport !== undefined, "the real encoded kind is found");
    assert.equal(liveReport.kind, "pi.live");
    assert.equal(liveReport.status, "torn");
    assert.equal(liveReport.repaired, true);
    assert.equal(report.repaired, true);
    const reopened = await openNodeSqliteStorage(path);
    try {
      const document = await reopened.document(liveId as never, "current", BACKGROUND_CONTEXT);
      assert.ok(document !== undefined);
      assert.deepEqual(document.value, {});
    } finally {
      await reopened.close(BACKGROUND_CONTEXT);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a done slot without an entry is valid, and a failing delta still repairs the view", async () => {
  const { dir, path } = await makeDatabase();
  try {
    const done = { callId: "c1", name: "bash", taskId: 3, status: "done" };
    const clean = materializeStoredDocument("pi.live", [
      { seq: 1, kind: "base", version: 3, content: JSON.stringify({ tools: [done] }) },
    ]);
    assert.equal(clean.torn, false, "a faulted/orphaned done slot is a healthy shape");

    addDocument(path, {
      id: 1,
      kind: "pi.live",
      conversationId: 2,
      revisions: [
        { seq: 1, kind: "base", content: JSON.stringify({ tools: [done] }) },
        { seq: 2, kind: "delta", content: JSON.stringify([["s", ["missing", "slot"], true]]) },
      ],
    });

    const report = await durableDoctor({ databasePath: path, repair: true });
    assert.equal(report.repaired, true);
    assert.equal(report.documents[0]?.baseRevision, 1);
    assert.match(report.documents[0]?.reason ?? "", /revision 2/);

    const storage = await openNodeSqliteStorage(path);
    try {
      const document = await storage.document(1 as never, "current", BACKGROUND_CONTEXT);
      assert.ok(document !== undefined);
      assert.deepEqual(
        (document.value as { tools: unknown[] }).tools,
        [done],
        "the valid base was kept instead of being rejected",
      );
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tracker-shaped index-0 appends repair to one interrupted tool slot", async () => {
  const running = { callId: "c1", name: "bash", taskId: 3, status: "running" };
  const interrupted = { ...running, status: "interrupted", interrupted: true };
  const append = JSON.stringify([["p", ["tools"], 0, 0, [running]]]);
  const replayedNewSlot = materializeStoredDocument("pi.live", [
    { seq: 1, kind: "base", version: 3, content: JSON.stringify({ tools: [] }) },
    { seq: 2, kind: "delta", version: 3, content: append },
    { seq: 3, kind: "delta", version: 3, content: append },
  ]);
  assert.equal(replayedNewSlot.torn, true, "the package would append c1 twice");
  assert.deepEqual(
    (replayedNewSlot.value as { tools: unknown[] }).tools,
    [interrupted],
    "the repaired value keeps one c1 and marks its residue",
  );
  assert.deepEqual(replayedNewSlot.residueDropped, ["c1"]);
  assert.match(replayedNewSlot.reason ?? "", /dedup|duplicate/i);

  const { dir, path } = await makeDatabase();
  try {
    addDocument(path, {
      id: 1,
      kind: "pi.live",
      conversationId: 2,
      revisions: [
        {
          seq: 1,
          kind: "base",
          content: JSON.stringify({
            tools: [{ callId: "c1", name: "bash", taskId: 3, status: "pending" }],
          }),
        },
        { seq: 2, kind: "delta", content: append },
      ],
    });

    const report = await durableDoctor({ databasePath: path, repair: true });
    assert.equal(report.torn, true);
    assert.equal(report.repaired, true);
    assert.deepEqual(report.documents[0]?.residueDropped, ["c1"]);

    const storage = await openNodeSqliteStorage(path);
    try {
      const document = await storage.document(1 as never, "current", BACKGROUND_CONTEXT);
      assert.ok(document !== undefined);
      assert.deepEqual((document.value as { tools: unknown[] }).tools, [interrupted]);
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a replayed inbox removal is applied once and repaired", () => {
  const removal = JSON.stringify([["p", ["items"], 0, 1, []]]);
  const result = materializeStoredDocument("pi.inbox", [
    {
      seq: 1,
      kind: "base",
      version: 1,
      content: JSON.stringify({ items: [{ id: "a" }, { id: "b" }] }),
    },
    { seq: 2, kind: "delta", version: 1, content: removal },
    { seq: 3, kind: "delta", version: 1, content: removal },
  ]);
  assert.equal(result.torn, true);
  assert.deepEqual(result.value, { items: [{ id: "b" }] });
  assert.match(result.reason ?? "", /destructive delta was replayed/);
});

test("a duplicate snapshot falls back and counts the discarded deltas", () => {
  const duplicate = { callId: "c1", name: "bash", taskId: 3, status: "done" };
  const result = materializeStoredDocument("pi.live", [
    { seq: 1, kind: "base", version: 3, content: JSON.stringify({ tools: [] }) },
    {
      seq: 2,
      kind: "delta",
      version: 3,
      content: JSON.stringify([["r", { tools: [duplicate, duplicate] }]]),
    },
  ]);
  assert.equal(result.torn, true);
  assert.equal(result.droppedDeltas, 1);
  assert.deepEqual(result.value, { tools: [] });
});

test("durableDoctor is a no-op on healthy documents and prints ok for each", async () => {
  const { dir, path } = await makeDatabase();
  try {
    addDocument(path, {
      id: 1,
      kind: "pi.live",
      conversationId: 2,
      revisions: [
        {
          seq: 1,
          kind: "base",
          content: JSON.stringify({ tools: [{ ...OBSERVED_SLOT, status: "done", entry: 9 }] }),
        },
      ],
    });
    addDocument(path, {
      id: 2,
      kind: "pi.agent",
      conversationId: 2,
      revisions: [{ seq: 2, kind: "base", content: JSON.stringify({ model: "test/model" }) }],
    });
    addDocument(path, {
      id: 3,
      kind: "pi.inbox",
      conversationId: 2,
      revisions: [{ seq: 3, kind: "base", content: JSON.stringify({ items: [] }) }],
    });

    const report = await durableDoctor({ databasePath: path });
    assert.equal(report.torn, false);
    assert.equal(report.repaired, false);
    assert.equal(report.documents.length, 3);
    assert.ok(report.documents.every((document) => document.status === "ok"));
    const text = formatDoctorReport(report);
    assert.equal(text.match(/: ok/g)?.length, 3);
    assert.equal(report.backupPath, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("--repair marks a non-result tool call interrupted, keeps messages, and writes a backup", async () => {
  const { dir, path } = await makeDatabase();
  try {
    const base = {
      messages: [{ id: 7, text: "the surrounding message" }],
      tools: [OBSERVED_SLOT],
    };
    addDocument(path, {
      id: 1,
      kind: "pi.live",
      conversationId: 2,
      revisions: [
        { seq: 5, kind: "base", content: JSON.stringify(base) },
        { seq: 6, kind: "delta", content: JSON.stringify([["s", ["missing", "slot"], true]]) },
      ],
    });

    const dry = await durableDoctor({ databasePath: path });
    assert.equal(dry.torn, true);
    assert.equal(dry.repaired, false);
    assert.equal(dry.documents[0]?.residueDropped.length, 1);

    const repaired = await durableDoctor({ databasePath: path, repair: true });
    assert.equal(repaired.repaired, true);
    assert.ok(repaired.backupPath !== undefined);
    assert.ok((await stat(repaired.backupPath)).isFile());

    const db = new DatabaseSync(path);
    try {
      const row = db
        .prepare(
          "SELECT content FROM document_revisions WHERE document_id = 1 ORDER BY seq DESC LIMIT 1",
        )
        .get() as { content: string };
      const value = JSON.parse(row.content) as {
        messages: { id: number; text: string }[];
        tools: { status: string; interrupted?: boolean }[];
      };
      assert.deepEqual(value.messages, base.messages);
      assert.equal(value.tools[0]?.status, "interrupted");
      assert.equal(value.tools[0]?.interrupted, true);
    } finally {
      db.close();
    }

    const storage = await openNodeSqliteStorage(path);
    try {
      const document = await storage.document(1 as never, "current", BACKGROUND_CONTEXT);
      assert.ok(document !== undefined);
      assert.equal(document.version, 1);
      assert.equal(
        (document.value as { tools: { status: string }[] }).tools[0]?.status,
        "interrupted",
      );
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a view read through the package store succeeds after repair", async () => {
  const { dir, path } = await makeDatabase();
  try {
    addDocument(path, {
      id: 1,
      kind: "pi.live",
      conversationId: 2,
      revisions: [
        { seq: 1, kind: "base", content: JSON.stringify({ tools: [OBSERVED_SLOT] }) },
        {
          seq: 2,
          kind: "delta",
          content: JSON.stringify([["s", ["tools", 0, "status"], "running"]]),
        },
        {
          seq: 3,
          kind: "delta",
          content: JSON.stringify([["s", ["tools", 0, "status"], "running"]]),
        },
        { seq: 4, kind: "delta", content: JSON.stringify([["s", ["not", "there"], true]]) },
      ],
    });

    const report = await durableDoctor({ databasePath: path, repair: true });
    assert.equal(report.repaired, true);

    const storage = await openNodeSqliteStorage(path);
    try {
      const document = await storage.document(1 as never, "current", BACKGROUND_CONTEXT);
      assert.ok(document !== undefined);
      const tools = (document.value as { tools: { callId: string; status: string }[] }).tools;
      assert.equal(tools.length, 1);
      assert.equal(tools[0]?.callId, OBSERVED_SLOT.callId);
      assert.equal(tools[0]?.status, "interrupted");
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

interface FakeModelServer {
  readonly origin: string;
  readonly server: Server;
  readonly firstCall: Promise<void>;
  hits(): number;
  close(): Promise<void>;
}

async function startFakeModelServer(): Promise<FakeModelServer> {
  let hits = 0;
  let resolveFirst: (() => void) | undefined;
  const firstCall = new Promise<void>((resolve) => {
    resolveFirst = resolve;
  });
  const server = createServer((req, res) => {
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404).end();
      return;
    }
    hits += 1;
    resolveFirst?.();
    resolveFirst = undefined;
    req.resume();
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const event = (
      delta: Record<string, unknown>,
      finish: string | null = null,
      usage?: Record<string, number>,
    ) => {
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-doctor",
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: "e2e-model",
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(usage === undefined ? {} : { usage }),
        })}\n\n`,
      );
    };
    event({ role: "assistant", content: "repaired view answered" });
    event({}, "stop");
    event({}, null, { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 });
    res.write("data: [DONE]\n\n");
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== "string");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    server,
    firstCall,
    hits: () => hits,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the repaired turn");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function run(
  command: string,
  args: readonly string[],
  options: { cwd: string; env?: Record<string, string> },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`${command} ${args.join(" ")} timed out`));
    }, 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

test("npm run durable:doctor uses the compiled CLI in the runtime layout", {
  skip: !existsSync("dist/server/durable-doctor-cli.js"),
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-durable-built-cli-"));
  const app = join(root, "app");
  try {
    await mkdir(app, { recursive: true });
    await cp("dist", join(app, "dist"), { recursive: true });
    await cp("package.json", join(app, "package.json"));
    await cp("package-lock.json", join(app, "package-lock.json"));
    await symlink(join(process.cwd(), "node_modules"), join(app, "node_modules"), "dir");
    const result = await run("npm", ["run", "durable:doctor", "--silent"], {
      cwd: app,
      env: {
        DATA_DIR: join(root, "data"),
        HOME: root,
        npm_config_cache: join(root, "npm-cache"),
        npm_config_update_notifier: "false",
      },
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /database not found/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

let tsxReady: Promise<void> | undefined;

function loadTsx(): Promise<void> {
  tsxReady ??= import("tsx/esm/api").then(({ register }) => {
    register();
  });
  return tsxReady;
}

test("the repair line renders as its own carded system row", async () => {
  await loadTsx();
  const [{ MessageBubble }, { createElement }, { renderToStaticMarkup }] = await Promise.all([
    import("../src/client/ChatView.tsx"),
    import("react"),
    import("react-dom/server"),
  ]);
  const markup = renderToStaticMarkup(
    createElement(MessageBubble, {
      message: {
        id: "m-1",
        role: "system",
        text: "repaired live state from revision 1 — dropped 1 pending tool call",
        timestamp: "2026-11-04T04:00:00.000Z",
        order: 10_000,
        repair: { baseRevision: 1 },
      },
    }),
  );
  assert.match(markup, /data-testid="durable-repair"/);
  assert.match(markup, /bg-surface\/90/);
  assert.match(markup, /backdrop-blur-md/);
  assert.doesNotMatch(markup, /⚠/);
});

test("the post-boot view rescue records the repair line", async () => {
  const { dir, path } = await makeDatabase();
  try {
    addDocument(path, {
      id: 1,
      kind: "pi.live",
      conversationId: 2,
      revisions: [
        { seq: 1, kind: "base", content: JSON.stringify({ tools: [OBSERVED_SLOT] }) },
        { seq: 2, kind: "delta", content: JSON.stringify([["s", ["missing", "slot"], true]]) },
      ],
    });
    const report = await durableDoctor({ databasePath: path, repair: true });
    assert.equal(report.repaired, true);

    await loadTsx();
    const { ChatService } = await import("../src/server/chat-service.ts");
    const entries: { id: number; kind: string; data?: unknown }[] = [];
    let watches = 0;
    const conversation = {
      id: 2,
      watch: async () => {
        watches += 1;
        if (watches === 1) throw new Error("torn view");
        return { value: { conversation: {}, entries: [], docs: {} } };
      },
      context: async () => ({ entries }),
      commit: async (write: (tx: unknown) => Promise<unknown>) =>
        write({
          appendEntry: async (
            definition: { kind: string },
            _conversationId: number,
            payload: { data: unknown },
          ) => {
            const entry = {
              id: entries.length + 1,
              conversationId: 2,
              kind: definition.kind,
              ...payload,
            };
            entries.push(entry);
            return entry;
          },
        }),
    };
    const chat = new ChatService(
      {} as never,
      conversation as never,
      { broadcast() {} } as never,
      undefined,
      false,
      { clear: async () => undefined, write: async () => undefined } as never,
      undefined,
      { servers: [], unavailable: [] },
      {} as never,
      undefined,
      {} as never,
      {} as never,
      async () => undefined,
      () => undefined,
      () => [],
      dir,
      async () => report,
    );
    const watch = await (
      chat as unknown as { watchConversation(): Promise<unknown> }
    ).watchConversation();
    assert.ok(watch !== undefined);
    assert.equal(watches, 2, "the failed watch is retried after the repair");
    const repairs = entries.filter((entry) => entry.kind === "ui.durable-repair");
    assert.equal(repairs.length, 1, "the rescue path records exactly one repair line");
    assert.match(
      String((repairs[0]?.data as { text?: unknown } | undefined)?.text),
      /^repaired live state/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a turn started on a repaired view reaches the first model call with one repair line", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-durable-turn-"));
  const dataDir = join(root, "data");
  const agentDir = join(root, "agent");
  await mkdir(dataDir, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  const fake = await startFakeModelServer();
  const saved = {
    agentDir: process.env.PI_CODING_AGENT_DIR,
    model: process.env.PI_MODEL,
    offline: process.env.PI_OFFLINE,
  };
  let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>> | undefined;
  let harness: Awaited<ReturnType<typeof Harness.open>> | undefined;
  let chat:
    | {
        start(): Promise<void>;
        submit(text: string): Promise<unknown>;
        close(): Promise<void>;
        getState(): string;
        getSnapshot(): Promise<{ activeTools?: { id: string }[] }>;
      }
    | undefined;
  try {
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          e2e: {
            baseUrl: `${fake.origin}/v1`,
            api: "openai-completions",
            apiKey: "e2e",
            models: [
              {
                id: "e2e-model",
                name: "E2E Model",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 100_000,
                maxTokens: 1_024,
              },
            ],
          },
        },
      }),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_MODEL = "e2e/e2e-model";
    process.env.PI_OFFLINE = "1";

    const runtime = await ModelRuntime.create();
    const model = runtime.getModel("e2e", "e2e-model");
    assert.ok(model !== undefined);

    const path = join(dataDir, "pi.sqlite3");
    storage = await openNodeSqliteStorage(path);
    harness = await Harness.open(
      storage,
      { models: runtime as never, registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    const conversation = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: {
          cwd: root,
          instructions: "test the repaired view",
          model: { provider: "e2e", modelId: "e2e-model" },
        },
      },
      BACKGROUND_CONTEXT,
    );

    // The real package leaves the live document lazy. Seed the exact torn shape: a pending call
    // in a valid base, followed by a delta that cannot be applied.
    addDocument(path, {
      id: 1_000,
      kind: "pi.live",
      conversationId: conversation.id,
      version: 3,
      revisions: [
        { seq: 1, kind: "base", content: JSON.stringify({ tools: [OBSERVED_SLOT] }) },
        { seq: 2, kind: "delta", content: JSON.stringify([["s", ["missing", "slot"], true]]) },
      ],
    });

    await loadTsx();
    const { ChatService } = await import("../src/server/chat-service.ts");
    const { MediaStore } = await import("../src/server/media.ts");
    const { StreamHub } = await import("../src/server/stream-hub.ts");
    chat = new ChatService(
      harness,
      conversation,
      new StreamHub(),
      model.contextWindow,
      false,
      { clear: async () => undefined, write: async () => undefined } as never,
      undefined,
      { servers: [], unavailable: [] },
      runtime as never,
      model,
      {} as never,
      new MediaStore(join(dataDir, "media")),
      async () => undefined,
      () => undefined,
      () => [],
      dataDir,
      () => durableDoctor({ databasePath: path, repair: true }),
    );

    await chat.start();
    const repairedSnapshot = await chat.getSnapshot();
    assert.deepEqual(
      repairedSnapshot.activeTools,
      [],
      "the repaired interrupted slot is not presented as a running tool",
    );
    const repairEntries = (await conversation.context(BACKGROUND_CONTEXT)).entries.filter(
      (entry) => entry.kind === "ui.durable-repair",
    );
    assert.equal(repairEntries.length, 1, "the repair line is emitted once");
    assert.match(
      String((repairEntries[0]?.data as { text?: unknown } | undefined)?.text),
      /^repaired live state from revision 1 — dropped 1 pending tool call$/,
    );

    await chat.submit("start the repaired turn");
    await Promise.race([
      fake.firstCall,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("the repaired turn never reached the model")), 15_000),
      ),
    ]);
    assert.ok(fake.hits() >= 1);
    await waitFor(() => chat?.getState() === "idle");
    const afterTurn = (await conversation.context(BACKGROUND_CONTEXT)).entries.filter(
      (entry) => entry.kind === "ui.durable-repair",
    );
    assert.equal(afterTurn.length, 1, "later requests do not repeat the repair line");

    // A tear that appears after start must be repaired by watchConversation and retried, not thrown.
    const db = new DatabaseSync(path);
    try {
      const max = db
        .prepare("SELECT MAX(seq) AS seq FROM document_revisions WHERE document_id = 1")
        .get() as { seq: number };
      db.prepare(
        "INSERT INTO document_revisions (document_id, seq, kind, version, content) VALUES (1, ?, 'delta', 3, ?)",
      ).run(Number(max.seq) + 1, JSON.stringify([["s", ["another", "missing"], true]]));
    } finally {
      db.close();
    }
    const driven = chat as unknown as { readView(): Promise<unknown> };
    await driven.readView();
  } finally {
    await chat?.close().catch(() => undefined);
    if (harness !== undefined) await harness.close(BACKGROUND_CONTEXT).catch(() => undefined);
    else if (storage !== undefined) await storage.close(BACKGROUND_CONTEXT).catch(() => undefined);
    await fake.close();
    if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
    if (saved.model === undefined) delete process.env.PI_MODEL;
    else process.env.PI_MODEL = saved.model;
    if (saved.offline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = saved.offline;
    await rm(root, { recursive: true, force: true });
  }
});
