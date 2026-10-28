import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { installBillionContextInline } from "./billion-context.js";
import { ChatService } from "./chat-service.js";
import { createModelCatalog } from "./models.js";
import { buildPiSystemPrompt } from "./pi.js";
import { type DurableSessionOptions, openDurableSession, SESSION_CONTEXT } from "./session.js";
import { StreamHub } from "./stream-hub.js";

const here = dirname(fileURLToPath(import.meta.url));
const builtClientDir = resolve(here, "../client");
const fallbackClientDir = resolve(process.cwd(), "dist/client");
const clientDir = existsSync(resolve(builtClientDir, "index.html"))
  ? builtClientDir
  : fallbackClientDir;

const cwd = resolve(process.env.PI_CWD?.trim() || process.cwd());
if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
  throw new Error(`PI_CWD is not a directory: ${cwd}`);
}

const port = Number(process.env.PORT || 8787);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

// Install billion-context before the durable harness exists, so the first
// provider request already goes through the in-process wire engine.
process.env.BILI_PI_INLINE ??= "1";
const bili = await installBillionContextInline({
  currentPath: resolve(cwd, process.env.DATA_DIR?.trim() || "data", "current.json"),
});

const catalog = await createModelCatalog();
if (catalog.model !== undefined) {
  bili.setModelMetadata({
    model: catalog.model.id,
    contextWindow: catalog.model.contextWindow,
    maxOutput: catalog.model.maxTokens,
  });
}
const instructions = await buildPiSystemPrompt(cwd, catalog.runtime);
const boot = await openDurableSession({
  cwd,
  models: catalog.runtime as unknown as DurableSessionOptions["models"],
  instructions,
  model:
    catalog.model === undefined
      ? undefined
      : { provider: catalog.model.provider, modelId: catalog.model.id },
  bili,
});
const hub = new StreamHub();
const chat = new ChatService(
  boot.harness,
  boot.conversation,
  hub,
  catalog.model?.contextWindow,
  boot.interrupted,
  boot.runMarkerStore,
  boot.runMarker,
);
await chat.start();
boot.mcp.setSubmit((text, options) => {
  void chat
    .submit(text, options.deliverAs === "steer" ? "steer" : "queue")
    .catch((error: unknown) => {
      console.error("[pi] MCP event message failed", error);
    });
});

void bili
  .registerIdentity(String(boot.conversation.id))
  .then((registered) => {
    if (registered) {
      console.log(`billion-context: registered conversation ${boot.conversation.id}`);
    }
  })
  .catch((error: unknown) => {
    console.warn(`billion-context: identity registration failed: ${String(error)}`);
  });

const app = new Hono();

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/state", async (c) => c.json(await chat.getSnapshot()));

app.post("/api/message", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.text("Expected a JSON body", 400);
  }
  const text =
    typeof body === "object" && body !== null && "text" in body && typeof body.text === "string"
      ? body.text.trim()
      : "";
  if (text.length === 0) return c.text("Message text is required", 400);
  const rawMode =
    typeof body === "object" && body !== null && "mode" in body ? body.mode : undefined;
  if (rawMode !== undefined && rawMode !== "queue" && rawMode !== "steer") {
    return c.text('Mode must be "queue" or "steer"', 400);
  }
  const mode = rawMode === "steer" ? "steer" : "queue";

  return c.json(await chat.submit(text, mode), 202);
});

app.post("/api/queue/:id", async (c) => {
  const id = c.req.param("id");
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.text("Expected a JSON body", 400);
  }
  const action =
    typeof body === "object" && body !== null && "action" in body ? body.action : undefined;
  if (action === "cancel") {
    const ok = await chat.cancelQueued(id);
    if (!ok) return c.notFound();
    return c.json({ ok: true, queue: (await chat.getSnapshot()).queue });
  }
  if (action === "steer") {
    const result = await chat.steerQueued(id);
    if (result === null) return c.notFound();
    return c.json(result, 202);
  }
  return c.text('Action must be "cancel" or "steer"', 400);
});

app.post("/api/stop", async (c) => {
  await chat.stop();
  return c.json({ ok: true, queue: (await chat.getSnapshot()).queue });
});

app.get("/api/stream", (c) => {
  return streamSSE(c, async (stream) => {
    const client = {
      send: async (frame: { event: string; data: unknown }) => {
        await stream.writeSSE({ event: frame.event, data: JSON.stringify(frame.data) });
      },
    };
    hub.add(client);

    const heartbeat = setInterval(() => {
      void stream.write(": heartbeat\n\n").catch(() => undefined);
    }, 20_000);

    const closed = new Promise<void>((resolveClosed) => {
      stream.onAbort(resolveClosed);
      if (c.req.raw.signal.aborted) {
        resolveClosed();
      } else {
        c.req.raw.signal.addEventListener("abort", () => resolveClosed(), { once: true });
      }
    });

    try {
      await client.send({ event: "run.state", data: chat.getRunStatus() });
      for (const frame of chat.replayFrames()) {
        await client.send(frame);
      }
      await closed;
    } finally {
      clearInterval(heartbeat);
      hub.remove(client);
    }
  });
});

function sharedText(title: string, text: string, url: string): string {
  const body = text.trim() || title.trim();
  const link = url.trim();
  if (body.length > 0 && link.length > 0) {
    return body.includes(link) ? body : `${body}\n${link}`;
  }
  return body || link;
}

async function submitShared(c: Context, title: string, text: string, url: string) {
  const message = sharedText(title, text, url);
  if (message.length === 0) return c.redirect("/", 303);
  await chat.submit(message);
  return c.redirect("/", 303);
}

app.post("/share", async (c) => {
  const body = await c.req.parseBody();
  return submitShared(
    c,
    typeof body.title === "string" ? body.title : "",
    typeof body.text === "string" ? body.text : "",
    typeof body.url === "string" ? body.url : "",
  );
});

app.get("/share", async (c) => {
  return submitShared(
    c,
    c.req.query("title") ?? "",
    c.req.query("text") ?? "",
    c.req.query("url") ?? "",
  );
});

const indexPath = resolve(clientDir, "index.html");
const serveIndex = async (c: Context) => {
  try {
    const html = await readFile(indexPath, "utf8");
    return c.body(html, 200, {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "no-cache",
    });
  } catch {
    return c.text("Client build not found. Run `npm run build` before starting the server.", 503);
  }
};

app.get("/", serveIndex);
app.get("/activity", serveIndex);
app.get("/activity/", serveIndex);

app.get("/manifest.webmanifest", async (c) => {
  try {
    const manifest = await readFile(resolve(clientDir, "manifest.webmanifest"), "utf8");
    return c.body(manifest, 200, {
      "Content-Type": "application/manifest+json",
      "Cache-Control": "no-cache",
    });
  } catch {
    return c.notFound();
  }
});

app.get("/sw.js", async (c) => {
  try {
    const worker = await readFile(resolve(clientDir, "sw.js"), "utf8");
    return c.body(worker, 200, {
      "Content-Type": "text/javascript; charset=UTF-8",
      "Cache-Control": "no-cache",
    });
  } catch {
    return c.notFound();
  }
});

app.use("/*", serveStatic({ root: clientDir }));

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`pi-ui listening on http://localhost:${info.port}`);
  console.log(`working directory: ${cwd}`);
  console.log(`storage: ${boot.databasePath}`);
  console.log(`conversation: ${boot.conversation.id} (${boot.resumed ? "resumed" : "new"})`);
  console.log(`conversation file: ${boot.currentPath}`);
  if (boot.interrupted) {
    console.log(
      boot.runMarker === undefined || boot.runMarker.stopRequested
        ? "previous run was interrupted; partial output was kept"
        : "previous run was interrupted; the partial output was kept and the turn is continuing",
    );
  }
  const toolParts = ["read", "bash", "edit", "write"];
  if (boot.mcp.toolNames.length > 0) {
    toolParts.push(`${boot.mcp.toolNames.length} MCP tools (${boot.mcp.serverNames.join(", ")})`);
  }
  if (boot.biliTools.length > 0) {
    toolParts.push(`${boot.biliTools.length} billion-context tools (${boot.biliTools.join(", ")})`);
  }
  console.log(`tools: ${toolParts.join(" + ")}`);
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  chat.beginShutdown();
  try {
    await chat.close();
    await boot.mcp.close();
    await boot.harness.close(SESSION_CONTEXT);
  } catch (error) {
    console.error("[pi] shutdown failed", error);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
