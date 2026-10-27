import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context } from "hono";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { BusyError, ChatService } from "./chat-service.js";
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

const catalog = await createModelCatalog();
const instructions = await buildPiSystemPrompt(cwd, catalog.runtime);
const boot = await openDurableSession({
  cwd,
  models: catalog.runtime as unknown as DurableSessionOptions["models"],
  instructions,
  model:
    catalog.model === undefined
      ? undefined
      : { provider: catalog.model.provider, modelId: catalog.model.id },
});
const hub = new StreamHub();
const chat = new ChatService(
  boot.harness,
  boot.conversation,
  hub,
  catalog.model?.contextWindow,
  boot.interrupted,
);
await chat.start();

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

  try {
    const message = await chat.submit(text);
    return c.json({ message }, 202);
  } catch (error) {
    if (error instanceof BusyError) return c.text(error.message, 409);
    throw error;
  }
});

app.post("/api/stop", async (c) => {
  await chat.stop();
  return c.json({ ok: true });
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
      await client.send({ event: "run.state", data: { state: chat.getState() } });
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
  try {
    await chat.submit(message);
    return c.redirect("/", 303);
  } catch (error) {
    if (error instanceof BusyError) return c.text(error.message, 409);
    throw error;
  }
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
    console.log("previous run was interrupted; partial output was kept and the turn is idle");
  }
  console.log("tools: read, bash, edit, write (no extensions or MCP)");
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await chat.close();
    await boot.harness.close(SESSION_CONTEXT);
  } catch (error) {
    console.error("[pi] shutdown failed", error);
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
