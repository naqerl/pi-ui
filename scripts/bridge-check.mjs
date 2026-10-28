#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const unregister = register({ tsconfig: resolve(root, "tsconfig.json") });

const WEB_TOOL_NAMES = ["web_search", "fetch_content", "get_search_content", "source_check"];
const BILI_HEADER = "x-bili-plugin-conversation";

function usage() {
  console.error(
    "usage: node scripts/bridge-check.mjs [--bili] [--web] [--all] [--conversation-id <id>]",
  );
  console.error("  --all is the default; --bili and --web select one bridge");
}

function parseArgs(args) {
  const selected = new Set();
  let conversationId;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--all") selected.add("all");
    else if (arg === "--bili") selected.add("bili");
    else if (arg === "--web") selected.add("web");
    else if (arg === "--conversation-id") {
      conversationId = args[++index];
      if (conversationId === undefined || conversationId.length === 0) {
        console.error("--conversation-id needs a value");
        return undefined;
      }
    } else if (arg === "--help" || arg === "-h") {
      usage();
      return { help: true };
    } else {
      console.error(`unknown argument: ${arg}`);
      usage();
      return undefined;
    }
  }

  const all = selected.size === 0 || selected.has("all");
  return {
    conversationId,
    bili: all || selected.has("bili"),
    web: all || selected.has("web"),
  };
}

function readConversationId(path) {
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (typeof value.conversationId === "string" && value.conversationId.length > 0) {
      return value.conversationId;
    }
    if (typeof value.conversationId === "number" && Number.isSafeInteger(value.conversationId)) {
      return String(value.conversationId);
    }
  } catch {
    // No durable conversation yet.
  }
  return undefined;
}

function writeConversationId(path, conversationId) {
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify({ conversationId })}\n`, "utf8");
  renameSync(temporary, path);
}

async function checkModels() {
  const { createModelCatalog } = await import(
    new URL("../src/server/models.ts", import.meta.url).href
  );
  try {
    const catalog = await createModelCatalog();
    const model = catalog.model;
    const provider = model?.provider ?? "none";
    const modelId = model?.id ?? "none";
    const credentials =
      model !== undefined && catalog.runtime.hasConfiguredAuth(model.provider)
        ? "found"
        : "missing";
    return {
      runtime: catalog.runtime,
      provider,
      model: modelId,
      credentials,
      ok: model !== undefined,
    };
  } catch (error) {
    console.error(`[bridge-check] model catalog failed: ${errorMessage(error)}`);
    return {
      runtime: undefined,
      provider: "none",
      model: "none",
      credentials: "missing",
      ok: false,
    };
  }
}

async function checkDurable(cwd, dataDir, models) {
  if (models === undefined) return { ok: false };
  const { Harness, createRegistry } = await import("@earendil-works/pi-durable");
  const { openNodeSqliteStorage } = await import("@earendil-works/pi-durable/storage/sqlite/node");
  const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");

  const currentPath = join(dataDir, "current.json");
  const storage = await openNodeSqliteStorage(join(dataDir, "pi.sqlite3"));
  let harness;
  try {
    harness = await Harness.open(
      storage,
      { models, registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );

    const savedId = readConversationId(currentPath);
    let conversation;
    let resumed = false;
    if (savedId !== undefined) {
      conversation = await harness.conversation(Number(savedId), BACKGROUND_CONTEXT);
      resumed = conversation !== undefined;
    }
    if (conversation === undefined) {
      conversation = await harness.createConversation(
        {
          ownership: { kind: "ownerless" },
          agent: { cwd, instructions: "pi-ui bridge check" },
        },
        BACKGROUND_CONTEXT,
      );
      writeConversationId(currentPath, String(conversation.id));
    }

    const view = await conversation.context(BACKGROUND_CONTEXT);
    return {
      ok: true,
      id: String(conversation.id),
      entries: view.entries.length,
      resumed,
    };
  } catch (error) {
    console.error(`[bridge-check] durable check failed: ${errorMessage(error)}`);
    return { ok: false };
  } finally {
    await harness?.close(BACKGROUND_CONTEXT).catch(() => undefined);
  }
}

async function startModelStub() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        id: "msg_bridge_check",
        type: "message",
        role: "assistant",
        model: "bridge-check",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/v1/messages`,
    close: () => new Promise((resolveClose) => server.close(() => resolveClose())),
  };
}

async function checkBili(dataDir, conversationId) {
  const currentPath = join(dataDir, "current.json");
  const biliCurrentPath =
    conversationId === undefined ? currentPath : join(dataDir, "bili-current.json");
  if (conversationId !== undefined) writeConversationId(biliCurrentPath, conversationId);
  const id = conversationId ?? readConversationId(currentPath);
  if (id === undefined) return { ok: false, origin: "unavailable", id: "missing", rewritten: 0 };

  const { installBillionContextInline } = await import(
    new URL("../src/server/billion-context.ts", import.meta.url).href
  );
  const bili = await installBillionContextInline({ currentPath: biliCurrentPath });
  const registered = await bili.registerIdentity(id);
  const stub = await startModelStub();
  try {
    try {
      const response = await globalThis.fetch(stub.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "bridge-check",
          max_tokens: 1,
          messages: [{ role: "user", content: "ping" }],
        }),
        signal: AbortSignal.timeout(5_000),
      });
      await response.text();
    } catch (error) {
      console.error(`[bridge-check] proxied request failed: ${errorMessage(error)}`);
    }
  } finally {
    await stub.close();
  }

  const rewritten = bili.observed.filter((entry) => entry.url.startsWith(`${bili.origin}/bili/`));
  const observed = rewritten.at(-1);
  const originOk = observed?.url.startsWith(`${bili.origin}/`) === true;
  const headerOk = observed?.conversationHeader === id;
  const manifest = await bili.manifest();
  const status = await bili.status(id);
  const statusOk = registered && status !== undefined;

  return {
    ok: originOk && headerOk && manifest !== undefined && statusOk,
    origin: bili.origin,
    id,
    rewritten: rewritten.length,
    status: statusOk ? "ok" : "unavailable",
  };
}

async function checkWeb() {
  const { startWebTools } = await import(
    new URL("../src/server/web-tools.ts", import.meta.url).href
  );
  const bridge = await startWebTools();
  try {
    const names = (bridge?.tools ?? []).map((tool) => tool.name.replace(/^mcp__web__/, ""));
    const child = bridge?.connected === true ? "alive" : "restarting";
    const expected = WEB_TOOL_NAMES.every((name) => names.includes(name));
    return {
      ok: bridge !== undefined && expected && child === "alive",
      tools: names.length,
      names,
      child,
    };
  } finally {
    await bridge?.close();
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options === undefined) return 1;
  if (options.help === true) return 0;

  const cwd = resolve(process.env.PI_CWD?.trim() || process.cwd());
  const configuredDataDir = process.env.DATA_DIR?.trim();
  const temporaryDataDir = configuredDataDir === undefined || configuredDataDir.length === 0;
  const dataDir = temporaryDataDir
    ? mkdtempSync(join(tmpdir(), "pi-ui-bridge-check-"))
    : resolve(cwd, configuredDataDir);
  mkdirSync(dataDir, { recursive: true });
  process.env.PI_CWD = cwd;
  process.env.DATA_DIR = dataDir;
  process.env.BILI_PI_INLINE = "1";
  process.env.ACP_LOG = "0";
  process.env.XDG_CONFIG_HOME = join(dataDir, "bili", "config");
  process.env.XDG_DATA_HOME = join(dataDir, "bili", "data");
  process.env.XDG_STATE_HOME = join(dataDir, "bili", "state");

  const report = [];
  let requiredMissing = false;
  let credentialsMissing = false;

  try {
    let models;
    if (options.bili) {
      models = await checkModels();
      if (!models.ok || models.credentials === "missing") credentialsMissing = true;
      if (!models.ok) requiredMissing = true;

      const durable = await checkDurable(cwd, dataDir, models.runtime);
      if (!durable.ok) requiredMissing = true;
      if (durable.ok) {
        report.push(
          `durable   conversation=${durable.id} entries=${durable.entries} resumed=${String(durable.resumed)}`,
        );
      }
      report.push(
        `models    provider=${models.provider} model=${models.model} credentials=${models.credentials}`,
      );

      if (durable.ok) {
        const bili = await checkBili(dataDir, options.conversationId);
        if (!bili.ok) requiredMissing = true;
        report.push(
          `bili      origin=${bili.origin} header=${BILI_HEADER}=${bili.id} rewritten=${bili.rewritten} status=${bili.status}`,
        );
      }
    }

    if (options.web) {
      const web = await checkWeb();
      if (!web.ok) requiredMissing = true;
      report.push(`web       tools=${web.tools} [${web.names.join(" ")}] child=${web.child}`);
    }
  } finally {
    if (temporaryDataDir) rmSync(dataDir, { recursive: true, force: true });
  }

  process.stdout.write(`${report.join("\n")}\n`);
  if (requiredMissing) return 1;
  if (credentialsMissing) return 2;
  return 0;
}

try {
  process.exitCode = await main();
} finally {
  await unregister();
}
