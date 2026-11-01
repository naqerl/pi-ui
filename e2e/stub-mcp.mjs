#!/usr/bin/env node
import { existsSync } from "node:fs";
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

const server = new Server(
  { name: "stub-mcp", version: "1.0.0" },
  { capabilities: { tools: {}, experimental: { events: {} } } },
);

server.setRequestHandler("tools/list", async () => ({
  tools: [
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
  ],
}));

server.setRequestHandler("tools/call", async (request) => {
  const name = request.params?.name;
  const args = request.params?.arguments ?? {};
  if (name !== "echo") {
    return { content: [{ type: "text", text: `unknown tool: ${String(name)}` }], isError: true };
  }
  return { content: [{ type: "text", text: `echo: ${String(args.text ?? "")}` }] };
});

server.setRequestHandler(
  "events/list",
  { params: z.object({ cursor: z.string().optional() }).passthrough() },
  async () => ({
    events: [
      {
        name: "stub-event",
        delivery: ["push"],
        description: "A stub event used by the pi-ui e2e suite.",
      },
      {
        name: "stub-hub",
        delivery: ["push"],
        description:
          "Hub-shaped events: every event is named `stub-hub` and carries its kind in `data.kind`.",
      },
      {
        name: "stub-burst",
        delivery: ["push"],
        description: "Three events in quick succession, for the queued-notice burst test.",
      },
      {
        name: "stub-burst-early",
        delivery: ["push"],
        description: "The first burst in the typed-message-between-bursts test.",
      },
      {
        name: "stub-burst-late",
        delivery: ["push"],
        description: "The second burst in the typed-message-between-bursts test.",
      },
      {
        name: "stub-burst-cancel",
        delivery: ["push"],
        description: "A burst whose merged chip is cancelled before delivery.",
      },
      {
        name: "stub-single",
        delivery: ["push"],
        description: "A single event, for the one-message single-event test.",
      },
      {
        name: "stub-huge",
        delivery: ["push"],
        description: "Five large events that split across several bounded notices.",
      },
      {
        name: "stub-burst-update",
        delivery: ["push"],
        description: "A burst whose first subject updates before the queued run is placed.",
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
    const id = String(ctx.mcpReq.id);
    const meta = { "io.modelcontextprotocol/subscriptionId": id };
    const notify = (method, extra) =>
      server.notification({ method, params: { _meta: meta, ...extra } });
    setTimeout(() => {
      void notify("notifications/events/active", { cursor: null });
    }, 10);
    const wave = (name, prefix, from, to) => {
      for (let index = from; index <= to; index++) {
        void notify("notifications/events/event", {
          eventId: `${prefix}-${index}`,
          name,
          timestamp: new Date().toISOString(),
          cursor: `${prefix}:${index}`,
          data: {
            kind: `${name}.event`,
            id: `${prefix}-${index}`,
            state: "created",
          },
        });
      }
      void notify("notifications/events/heartbeat", { cursor: `${prefix}:${to}` });
    };
    const prefix = (fallback) =>
      typeof params.arguments?.prefix === "string" && params.arguments.prefix.length > 0
        ? params.arguments.prefix
        : fallback;
    const hold = () => new Promise((resolve) => setTimeout(resolve, 120_000));
    if (params.name === "stub-burst") {
      setTimeout(() => wave("stub-burst", prefix("burst"), 1, 3), 100);
      await hold();
      return {};
    }
    if (params.name === "stub-burst-early") {
      setTimeout(() => wave("stub-burst-early", prefix("early"), 1, 3), 100);
      await hold();
      return {};
    }
    if (params.name === "stub-burst-late") {
      const release = typeof params.arguments?.release === "string" ? params.arguments.release : "";
      const deadline = Date.now() + 30_000;
      while ((release === "" || !existsSync(release)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      wave("stub-burst-late", prefix("late"), 1, 3);
      await hold();
      return {};
    }
    if (params.name === "stub-burst-cancel") {
      setTimeout(() => wave("stub-burst-cancel", prefix("cancel"), 1, 3), 100);
      await hold();
      return {};
    }
    if (params.name === "stub-single") {
      setTimeout(() => wave("stub-single", prefix("single"), 1, 1), 100);
      await hold();
      return {};
    }
    if (params.name === "stub-huge") {
      const eventPrefix = prefix("huge");
      setTimeout(() => {
        for (let index = 1; index <= 5; index++) {
          void notify("notifications/events/event", {
            eventId: `${eventPrefix}-${index}`,
            name: "stub-huge",
            timestamp: new Date().toISOString(),
            cursor: `${eventPrefix}:${index}`,
            data: {
              kind: "stub-huge.event",
              id: `${eventPrefix}-${index}`,
              state: "created",
              text: "x".repeat(7_000),
            },
          });
        }
        void notify("notifications/events/heartbeat", { cursor: `${eventPrefix}:5` });
      }, 100);
      await hold();
      return {};
    }
    if (params.name === "stub-burst-update") {
      const eventPrefix = prefix("update");
      setTimeout(() => {
        for (let index = 1; index <= 3; index++) {
          void notify("notifications/events/event", {
            eventId: `${eventPrefix}-${index}`,
            name: "stub-burst-update",
            timestamp: new Date().toISOString(),
            cursor: `${eventPrefix}:${index}`,
            data: {
              kind: "stub-update.event",
              id: `${eventPrefix}-subject-${index}`,
              state: "created",
            },
          });
        }
      }, 100);
      setTimeout(() => {
        void notify("notifications/events/event", {
          eventId: `${eventPrefix}-update`,
          name: "stub-burst-update",
          timestamp: new Date().toISOString(),
          cursor: `${eventPrefix}:update`,
          data: {
            kind: "stub-update.event",
            id: `${eventPrefix}-subject-1`,
            state: "running",
          },
        });
        void notify("notifications/events/heartbeat", { cursor: `${eventPrefix}:update` });
      }, 900);
      await hold();
      return {};
    }
    if (params.name === "stub-hub") {
      // A multiplexed stream, as a hub sends it: named after the stream, with
      // the event's own kind in data.kind.
      setTimeout(() => {
        void notify("notifications/events/event", {
          eventId: "510",
          name: "stub-hub",
          timestamp: new Date().toISOString(),
          cursor: "hub:510",
          data: { kind: "stub-hub.job", id: "job-1", state: "cancelled" },
        });
        void notify("notifications/events/heartbeat", { cursor: "hub:510" });
      }, 100);
      // Stays open like a real hub stream, until the client unsubscribes.
      await new Promise((resolve) => setTimeout(resolve, 120_000));
      return {};
    }
    setTimeout(() => {
      void notify("notifications/events/event", {
        eventId: "stub-event-1",
        name: params.name,
        timestamp: new Date().toISOString(),
        cursor: "stub-cursor-1",
        data: { hello: "from-stub", arguments: params.arguments ?? {} },
      });
    }, 100);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    void notify("notifications/events/terminated", {
      error: { message: "stub stream finished" },
    });
    return {};
  },
);

await server.connect(new StdioServerTransport());
