#!/usr/bin/env node
// First events/stream becomes active, then answers with a JSON-RPC error.
// invalid-request models a restarted server rejecting the old session.
// method-not-found is a real protocol failure and must not be retried.
import { readFileSync, writeFileSync } from "node:fs";
import {
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  ProtocolError,
  Server,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const mode = process.env.STALE_MCP_MODE ?? "invalid-request";
const statePath = process.env.STALE_MCP_STATE;
if (statePath === undefined || statePath.length === 0) {
  process.stderr.write("STALE_MCP_STATE is required\n");
  process.exit(1);
}

function nextStream() {
  let count = 0;
  try {
    const parsed = Number(readFileSync(statePath, "utf8"));
    if (Number.isFinite(parsed)) count = parsed;
  } catch {
    count = 0;
  }
  writeFileSync(statePath, String(count + 1));
  return count;
}

const server = new Server(
  { name: "stale-mcp", version: "1.0.0" },
  { capabilities: { tools: {}, experimental: { events: {} } } },
);

server.setRequestHandler("tools/list", async () => ({ tools: [] }));

server.setRequestHandler(
  "events/list",
  { params: z.object({ cursor: z.string().optional() }).passthrough() },
  async () => ({
    events: [
      {
        name: "stub-event",
        delivery: ["push"],
        description: "A stub event used to test stale MCP sessions.",
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
        maxAgeMs: z.number().optional(),
      })
      .passthrough(),
  },
  async (params, ctx) => {
    const index = nextStream();
    const id = String(ctx.mcpReq.id);
    const meta = { "io.modelcontextprotocol/subscriptionId": id };
    const notify = (method, extra) =>
      server.notification({ method, params: { _meta: meta, ...extra } });
    await notify("notifications/events/active", { cursor: null });
    // Let the subscription become active before the failure response.
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (index === 0 && mode === "invalid-request") {
      throw new ProtocolError(INVALID_REQUEST, "Invalid Request");
    }
    if (mode === "method-not-found") {
      throw new ProtocolError(METHOD_NOT_FOUND, "Method not found");
    }
    await notify("notifications/events/event", {
      eventId: "recovered-1",
      name: params.name,
      timestamp: new Date().toISOString(),
      cursor: "recovered-cursor",
      data: { hello: "recovered-event" },
    });
    await new Promise((resolve) => {
      if (ctx.mcpReq.signal.aborted) {
        resolve();
        return;
      }
      ctx.mcpReq.signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return {};
  },
);

await server.connect(new StdioServerTransport());
