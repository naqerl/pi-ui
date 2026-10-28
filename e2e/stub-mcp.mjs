#!/usr/bin/env node
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
