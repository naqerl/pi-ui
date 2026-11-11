#!/usr/bin/env node
// A real Streamable HTTP MCP server that models the two production incidents:
// a server that forgets our session (drop-once), a server whose tool catalog
// grows (grow), a server that is down during boot (down), plus the two
// failures that must never trigger a re-initialize (method-not-found, 401).
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import {
  METHOD_NOT_FOUND,
  ProtocolError,
  Server,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { z } from "zod";

const mode = process.env.SESSION_DROP_MODE ?? "drop-once";
const statePath = process.env.SESSION_DROP_STATE;
const controlPath = process.env.SESSION_DROP_CONTROL;
const port = Number(process.env.SESSION_DROP_PORT ?? 0);

function log(line) {
  if (statePath !== undefined && statePath.length > 0) appendFileSync(statePath, `${line}\n`);
}

function down() {
  return mode === "down" && (controlPath === undefined || !existsSync(controlPath));
}

const sessions = new Map();
let grown = false;
let firstSessionId;
let dropArmed = false;
let dropped = false;
let droppedStream = false;

function tools() {
  const listed = [
    {
      name: "echo",
      description: "Echoes the supplied text.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  ];
  if (grown) {
    listed.push({
      name: "added",
      description: "A tool that appeared after the first call.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    });
  }
  return listed;
}

function createMcpServer(holder) {
  const server = new Server(
    { name: "session-drop-mcp", version: "1.0.0" },
    { capabilities: { tools: { listChanged: true }, experimental: { events: {} } } },
  );
  holder.server = server;

  server.setRequestHandler("tools/list", async () => ({ tools: tools() }));

  server.setRequestHandler(
    "events/list",
    { params: z.object({ cursor: z.string().optional() }).passthrough() },
    async () => ({
      events: [
        {
          name: "drop-stream",
          delivery: ["push"],
          description: "A stream whose first transport session is dropped mid-run.",
        },
      ],
    }),
  );

  server.setRequestHandler(
    "events/stream",
    {
      params: z
        .object({
          name: z.string(),
          arguments: z.record(z.string(), z.unknown()).optional(),
          cursor: z.string().nullable().optional(),
        })
        .passthrough(),
    },
    async (params, ctx) => {
      const cursor = typeof params.cursor === "string" ? params.cursor : null;
      log(`stream:${params.name}:${cursor ?? "null"}`);
      const meta = { "io.modelcontextprotocol/subscriptionId": String(ctx.mcpReq.id) };
      const notify = (method, extra) =>
        holder.server.notification({ method, params: { _meta: meta, ...extra } });
      const closed = new Promise((resolve) => {
        if (ctx.mcpReq.signal.aborted) {
          resolve();
          return;
        }
        ctx.mcpReq.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      const resumed = cursor ?? "drop:1";
      if (mode === "event-drop" && params.name === "drop-stream" && !droppedStream) {
        droppedStream = true;
        log("drop-stream");
        setTimeout(() => {
          void notify("notifications/events/active", { cursor: resumed });
        }, 10);
        // Stay silent: the extension's 65 s heartbeat timeout starts the
        // reconnect, which must carry this same cursor back to the server.
        await closed;
        return {};
      }
      setTimeout(() => {
        void notify("notifications/events/active", { cursor: resumed });
      }, 10);
      setTimeout(() => {
        void notify("notifications/events/heartbeat", { cursor: resumed });
      }, 100);
      const heartbeat = setInterval(() => {
        void notify("notifications/events/heartbeat", { cursor: resumed });
      }, 5_000);
      heartbeat.unref?.();
      await closed;
      clearInterval(heartbeat);
      return {};
    },
  );

  server.setRequestHandler("tools/call", async (request) => {
    if (mode === "method-not-found") {
      throw new ProtocolError(METHOD_NOT_FOUND, "Method not found");
    }
    const name = request.params?.name;
    const args = request.params?.arguments ?? {};
    if (name === "echo") {
      return { content: [{ type: "text", text: `echo: ${String(args.text ?? "")}` }] };
    }
    if (name === "added" && grown) {
      return { content: [{ type: "text", text: "added: ok" }] };
    }
    return { content: [{ type: "text", text: `unknown tool: ${String(name)}` }], isError: true };
  });

  return server;
}

async function createSession(id) {
  const holder = {};
  const server = createMcpServer(holder);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => id,
    enableJsonResponse: true,
    onsessionclosed: () => {
      sessions.delete(id);
    },
  });
  holder.transport = transport;
  await server.connect(transport);
  const session = { id, server, transport, sseReady: false, pendingGrow: false };
  sessions.set(id, session);
  return session;
}

function headersOf(request) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }
  return headers;
}

function webRequest(request, body) {
  return new Request(`http://127.0.0.1:${port}${request.url ?? "/mcp"}`, {
    method: request.method,
    headers: headersOf(request),
    ...(body === undefined || request.method === "GET" || request.method === "HEAD"
      ? {}
      : { body, duplex: "half" }),
  });
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function pipe(response, res) {
  const headers = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });
  res.writeHead(response.status, headers);
  if (response.body === null) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) res.write(value);
    }
    res.end();
  } catch {
    res.destroy();
  }
}

async function sendGrown(session) {
  if (!session.sseReady) {
    session.pendingGrow = true;
    return;
  }
  try {
    await session.server.notification({ method: "notifications/tools/list_changed" });
    log("grow");
  } catch {
    // A later session sees the grown catalog anyway.
  }
}

const http = createServer(async (request, res) => {
  try {
    if (down()) {
      log("attempt");
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("server is down");
      return;
    }
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    if (request.method === "GET" || request.method === "DELETE") {
      const sid = request.headers["mcp-session-id"];
      const session = typeof sid === "string" ? sessions.get(sid) : undefined;
      if (session === undefined) {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("session not found");
        return;
      }
      const response = await session.transport.handleRequest(webRequest(request));
      if (request.method === "GET") {
        session.sseReady = true;
        void pipe(response, res);
        if (session.pendingGrow) {
          session.pendingGrow = false;
          void sendGrown(session);
        }
        return;
      }
      await pipe(response, res);
      return;
    }

    if (request.method !== "POST") {
      res.writeHead(405, { "content-type": "text/plain" });
      res.end("method not allowed");
      return;
    }

    const body = await readBody(request);
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("parse error");
      return;
    }
    const method = typeof parsed?.method === "string" ? parsed.method : undefined;
    log(`attempt:${method ?? "?"}`);

    if (method === "initialize") {
      log("initialize");
      const id = randomUUID();
      const session = await createSession(id);
      if ((mode === "drop-once" || mode === "invalid-request") && firstSessionId === undefined) {
        firstSessionId = session.id;
        dropArmed = true;
      }
      const response = await session.transport.handleRequest(webRequest(request, body), {
        parsedBody: parsed,
      });
      await pipe(response, res);
      return;
    }

    const sid = request.headers["mcp-session-id"];
    const session = typeof sid === "string" ? sessions.get(sid) : undefined;
    if (session === undefined) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("session not found");
      return;
    }

    if (mode === "unauthorized" && method === "tools/call") {
      log("unauthorized");
      res.writeHead(401, {
        "content-type": "text/plain",
        "www-authenticate": 'Bearer realm="session-drop"',
      });
      res.end("unauthorized");
      return;
    }

    if (
      mode === "invalid-request" &&
      method === "tools/call" &&
      dropArmed &&
      !dropped &&
      session.id === firstSessionId
    ) {
      dropped = true;
      log("invalid");
      sessions.delete(session.id);
      await session.transport.close().catch(() => {});
      res.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": session.id,
      });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: parsed?.id ?? null,
          error: { code: -32600, message: "invalid during session initialization" },
        }),
      );
      return;
    }

    if (
      mode === "drop-once" &&
      method === "tools/call" &&
      dropArmed &&
      !dropped &&
      session.id === firstSessionId
    ) {
      dropped = true;
      log("drop");
      sessions.delete(session.id);
      await session.transport.close().catch(() => {});
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("session not found");
      return;
    }

    const response = await session.transport.handleRequest(webRequest(request, body), {
      parsedBody: parsed,
    });
    await pipe(response, res);

    if (method === "tools/call") {
      log("call");
      if (mode === "grow" && !grown) {
        grown = true;
        void sendGrown(session);
      }
    }
  } catch (error) {
    log(`error:${error instanceof Error ? error.message : String(error)}`);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal error");
    } else {
      res.destroy();
    }
  }
});

http.listen(port, "127.0.0.1", () => {
  log("listening");
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    http.close();
    process.exit(0);
  });
}
