#!/usr/bin/env node
// A stub hub for the restored-subscription tests. It answers the cursor probe
// differently per stream: one subscription is gone, one has a pre-restart
// backlog, one is healthy, and one emits a burst that lies about `replayed`.
import { appendFileSync } from "node:fs";
import { ProtocolError, Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const logPath = process.env.RESTORE_MCP_LOG;
const mode = process.env.RESTORE_MCP_MODE === "paged" ? "paged" : "poll";
const oldTimestamp = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
// A restart a moment ago: the missed event is seconds old, so replay is right.
const recentTimestamp = new Date(Date.now() - 2_000).toISOString();
const names =
  mode === "paged"
    ? ["first-a", "first-b", "paged-stream"]
    : ["gone-stream", "old-stream", "recent-stream", "idle-stream", "live-stream", "burst-stream"];

function log(line) {
  if (logPath !== undefined && logPath.length > 0) appendFileSync(logPath, `${line}\n`);
}

const server = new Server(
  { name: "restore-mcp", version: "1.0.0" },
  { capabilities: { tools: {}, experimental: { events: {} } } },
);

server.setRequestHandler("tools/list", async () => ({ tools: [] }));

server.setRequestHandler(
  "events/list",
  { params: z.object({ cursor: z.string().optional() }).passthrough() },
  async (params) => {
    const catalog = (name) => ({
      name,
      delivery: ["push"],
      description: `Restore probe stream ${name}.`,
    });
    if (mode === "paged") {
      log(`list:${params.cursor ?? "first"}`);
      if (params.cursor === undefined) {
        return { events: [catalog("first-a"), catalog("first-b")], nextCursor: "page-2" };
      }
      if (params.cursor === "page-2") return { events: [catalog("paged-stream")] };
      return { events: [] };
    }
    log("list");
    return { events: names.map(catalog) };
  },
);

if (mode !== "paged") {
  server.setRequestHandler(
    "events/poll",
    {
      params: z
        .object({
          name: z.string(),
          cursor: z.string().nullable().optional(),
          maxEvents: z.number().optional(),
        })
        .passthrough(),
    },
    async (params) => {
      log(`poll:${params.name}:${params.cursor ?? "null"}`);
      if (params.name === "gone-stream") {
        throw new ProtocolError(-32023, "Subscription not found");
      }
      if (params.name === "old-stream") {
        return {
          events: [
            {
              event: {
                eventId: "old-stream-backlog",
                name: "old-stream",
                timestamp: oldTimestamp,
                cursor: "old-stream:1",
                data: { kind: "old-stream.event", id: "old-1", state: "created" },
              },
            },
          ],
          cursor: "old-stream:1",
        };
      }
      if (params.name === "recent-stream") {
        return {
          events: [
            {
              event: {
                eventId: "recent-stream-backlog",
                name: "recent-stream",
                timestamp: recentTimestamp,
                cursor: "recent-stream:1",
                data: { kind: "recent-stream.event", id: "recent-1", state: "created" },
              },
            },
          ],
          cursor: "recent-stream:1",
        };
      }
      if (params.name === "flood-stream") {
        // A busy hub after a short outage: twenty-five events, every one of
        // them recent. Only the size gives it away as a backlog.
        return {
          events: Array.from({ length: 25 }, (_, index) => ({
            event: {
              eventId: `flood-${index + 1}`,
              name: "flood-stream",
              timestamp: recentTimestamp,
              cursor: `flood-stream:${index + 1}`,
              data: { kind: "flood-stream.event", id: `flood-${index + 1}`, state: "created" },
            },
          })),
          cursor: "flood-stream:25",
        };
      }
      if (params.name === "idle-stream") return { events: [], cursor: "idle:7" };
      if (params.name === "live-stream") return { events: [], cursor: "live-stream:0" };
      if (params.name === "burst-stream") return { events: [], cursor: "burst-stream:0" };
      throw new ProtocolError(-32023, "Subscription not found");
    },
  );
}

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
    log(`stream:${params.name}:${params.cursor ?? "null"}`);
    const meta = { "io.modelcontextprotocol/subscriptionId": String(ctx.mcpReq.id) };
    const notify = (method, extra) =>
      server.notification({ method, params: { _meta: meta, ...extra } });
    const closed = new Promise((resolve) => {
      if (ctx.mcpReq.signal.aborted) {
        resolve();
        return;
      }
      ctx.mcpReq.signal.addEventListener("abort", () => resolve(), { once: true });
    });

    setTimeout(() => {
      void notify("notifications/events/active", {
        cursor: params.cursor ?? null,
        // Only a client that kept the stale cursor is told its replay is truncated.
        ...(params.name === "old-stream" && params.cursor === "old:42" ? { truncated: true } : {}),
      });
    }, 10);

    if (params.name === "old-stream") {
      setTimeout(() => {
        if (params.cursor === "old:42") {
          // Only a process that kept the stale cursor sees the backlog.
          void notify("notifications/events/event", {
            eventId: "old-stream-backlog",
            name: "old-stream",
            timestamp: oldTimestamp,
            cursor: "old-stream:1",
            data: { kind: "old-stream.event", id: "old-1", state: "created" },
          });
        } else {
          void notify("notifications/events/heartbeat", { cursor: params.cursor ?? null });
        }
      }, 50);
    }

    if (params.name === "recent-stream") {
      setTimeout(() => {
        if (params.cursor === "recent:41") {
          void notify("notifications/events/event", {
            eventId: "recent-stream-backlog",
            name: "recent-stream",
            timestamp: recentTimestamp,
            cursor: "recent-stream:1",
            data: { kind: "recent-stream.event", id: "recent-1", state: "created" },
          });
        }
        void notify("notifications/events/heartbeat", { cursor: "recent-stream:1" });
      }, 50);
    }

    if (params.name === "idle-stream") {
      setTimeout(() => {
        void notify("notifications/events/heartbeat", { cursor: "idle:7" });
      }, 50);
    }

    if (params.name === "live-stream") {
      setTimeout(() => {
        void notify("notifications/events/event", {
          eventId: "live-1",
          name: "live-stream",
          timestamp: new Date().toISOString(),
          cursor: "live-stream:1",
          data: { kind: "live-stream.event", id: "live-1", state: "created" },
        });
        void notify("notifications/events/heartbeat", { cursor: "live-stream:1" });
      }, 3_000);
    }

    if (params.name === "paged-stream") {
      setTimeout(() => {
        void notify("notifications/events/heartbeat", { cursor: params.cursor ?? null });
      }, 50);
    }

    if (params.name === "burst-stream") {
      setTimeout(() => {
        for (let index = 1; index <= 22; index += 1) {
          void notify("notifications/events/event", {
            eventId: `burst-${index}`,
            name: "burst-stream",
            timestamp: oldTimestamp,
            cursor: `burst-stream:${index}`,
            data: { kind: "burst-stream.event", id: `burst-${index}`, state: "created" },
          });
        }
        void notify("notifications/events/heartbeat", { cursor: "burst-stream:22" });
      }, 2_000);
    }

    await closed;
    return {};
  },
);

await server.connect(new StdioServerTransport());
