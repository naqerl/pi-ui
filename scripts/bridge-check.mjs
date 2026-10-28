#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const unregister = register({ tsconfig: resolve(root, "tsconfig.json") });
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function usage() {
  console.error("usage: node scripts/bridge-check.mjs --bili [--conversation-id <id>]");
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
    // No durable conversation yet; the check still exercises the wire identity.
  }
  return undefined;
}

function hasProviderCredentials() {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim();
  const authDir = agentDir && agentDir.length > 0 ? agentDir : join(homedir(), ".pi", "agent");
  const authPath = join(authDir, "auth.json");
  try {
    const auth = JSON.parse(readFileSync(authPath, "utf8"));
    if (auth !== null && typeof auth === "object" && Object.keys(auth).length > 0) return true;
  } catch {
    // Fall through to environment credentials.
  }
  const envNames = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "OPENROUTER_API_KEY",
    "ZEROSHOT_API_KEY",
  ];
  return envNames.some((name) => (process.env[name]?.trim().length ?? 0) > 0);
}

function statusNumbers(status) {
  if (status === undefined) return "unavailable";
  const keys = ["requests", "contextTokens", "inputTokens", "outputTokens", "cachedTokens"];
  return keys
    .filter((key) => typeof status[key] === "number")
    .map((key) => `${key}=${status[key]}`)
    .join(" ");
}

async function runModelTurn(bili, cwd) {
  const { createModelCatalog } = await import(
    new URL("../src/server/models.ts", import.meta.url).href
  );
  const { buildPiSystemPrompt } = await import(
    new URL("../src/server/pi.ts", import.meta.url).href
  );
  const { openDurableSession, SESSION_CONTEXT } = await import(
    new URL("../src/server/session.ts", import.meta.url).href
  );
  const { ChatService } = await import(
    new URL("../src/server/chat-service.ts", import.meta.url).href
  );
  const { StreamHub } = await import(new URL("../src/server/stream-hub.ts", import.meta.url).href);

  const catalog = await createModelCatalog();
  const model = catalog.model;
  if (model === undefined || !catalog.runtime.hasConfiguredAuth(model.provider)) {
    console.log("model turn: skipped: no provider credentials");
    return true;
  }

  bili.setModelMetadata({
    model: model.id,
    contextWindow: model.contextWindow,
    maxOutput: model.maxTokens,
  });
  const instructions = await buildPiSystemPrompt(cwd, catalog.runtime);
  const boot = await openDurableSession({
    cwd,
    models: catalog.runtime,
    instructions,
    model: { provider: model.provider, modelId: model.id },
    bili,
  });
  const id = String(boot.conversation.id);
  await bili.registerIdentity(id);

  const hub = new StreamHub();
  const chat = new ChatService(boot.harness, boot.conversation, hub, model.contextWindow, false);
  try {
    const before = await bili.status(id);
    await chat.start();
    await chat.submit("Reply with the single word: ok");
    const deadline = Date.now() + 120_000;
    while (chat.getState() === "running" && Date.now() < deadline) await sleep(200);
    const after = await bili.status(id);
    console.log(`status before: ${statusNumbers(before)}`);
    console.log(`status after: ${statusNumbers(after)}`);
    if (chat.getState() === "running") {
      console.log("model turn: failed: timed out");
      return false;
    }
    const snapshot = await chat.getSnapshot();
    const last = snapshot.messages.at(-1);
    const ok = last?.role === "assistant" && last.text.trim().length > 0;
    console.log(`model turn: ${ok ? "ok" : "failed: no assistant output"}`);
    return ok;
  } finally {
    await chat.close();
    await boot.webTools?.close();
    await boot.harness.close(SESSION_CONTEXT);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.includes("--bili")) {
    usage();
    return 1;
  }
  const flagIndex = args.indexOf("--conversation-id");
  const explicitId = flagIndex >= 0 ? args[flagIndex + 1] : undefined;

  const cwd = resolve(process.env.PI_CWD?.trim() || process.cwd());
  const dataDir = resolve(cwd, process.env.DATA_DIR?.trim() || "data");
  const currentPath = join(dataDir, "current.json");
  const conversationId = explicitId ?? readConversationId(currentPath) ?? "bridge-check";

  if (!existsSync(currentPath)) {
    console.warn(`[bridge-check] ${currentPath} does not exist; using ${conversationId}`);
  }

  // Keep the engine's sqlite index out of the checked-out repository. The
  // production server uses the real XDG/HOME paths documented in the README.
  const stateRoot = mkdtempSync(join(tmpdir(), "pi-ui-bridge-check-"));
  process.env.XDG_CONFIG_HOME = join(stateRoot, "config");
  process.env.XDG_DATA_HOME = join(stateRoot, "data");
  process.env.XDG_STATE_HOME = join(stateRoot, "state");
  process.env.BILI_PI_INLINE = "1";

  const { installBillionContextInline } = await import(
    new URL("../src/server/billion-context.ts", import.meta.url).href
  );
  const bili = await installBillionContextInline({ currentPath });
  console.log(`origin: ${bili.origin}`);

  const registered = await bili.registerIdentity(conversationId);
  console.log(`registered: ${registered ? conversationId : "failed"}`);
  if (!registered) return 1;

  const manifest = await bili.manifest();

  // Prove the model-URL rewrite without credentials: the wrapper records the
  // proxied URL before the engine attempts (and here fails) the upstream call.
  // Use globalThis.fetch so this also proves the wrapper is outermost.
  try {
    await globalThis.fetch("http://127.0.0.1:9/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    // Expected: nothing is listening on port 9.
  }
  const observed = bili.observed.at(-1);
  console.log(`observed request: ${observed?.url ?? "none"}`);
  console.log(
    `header applied: x-bili-plugin-conversation=${observed?.conversationHeader ?? "missing"}`,
  );

  const originOk = observed?.url.startsWith(`${bili.origin}/`) === true;
  const headerOk = observed?.conversationHeader === conversationId;
  if (!originOk || !headerOk) return 1;

  if (manifest === undefined) {
    console.log("model turn: failed: manifest unavailable");
    return 1;
  }

  if (!hasProviderCredentials()) {
    console.log("model turn: skipped: no provider credentials");
    return 0;
  }
  return (await runModelTurn(bili, cwd)) ? 0 : 1;
}

try {
  process.exitCode = await main();
} finally {
  await unregister();
}
