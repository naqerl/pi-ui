#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startMcpRuntime } from "../src/server/mcp-runtime.ts";

const stub = join(import.meta.dirname, "stub-mcp.mjs");
const secret = "super-secret-token-9f3c";

function writeConfig(servers) {
  const dir = mkdtempSync(join(tmpdir(), "pi-ui-mcp-"));
  writeFileSync(join(dir, "mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));
  return dir;
}

async function execute(tool, args) {
  return tool.execute(args, { callId: "mcp-e2e" }, { abortSignal: new AbortController().signal });
}

const messages = [];
process.env.PI_CODING_AGENT_DIR = writeConfig({
  stub: { command: process.execPath, args: [stub] },
  broken: { command: process.execPath, args: ["-e", "process.exit(1)"] },
});

const runtime = await startMcpRuntime({
  submit: (text) => messages.push(text),
});
try {
  assert.ok(runtime.toolNames.includes("stub__echo"), `echo tool missing: ${runtime.toolNames}`);
  assert.ok(runtime.toolNames.includes("mcp_events"), "mcp_events missing");
  assert.ok(
    runtime.failedServers.some((server) => server.name === "broken"),
    "broken server was not reported",
  );
  assert.ok(
    runtime.toolNames.some((name) => name.startsWith("web__")),
    "the built-in web MCP server did not start",
  );

  const echo = runtime.tools.find((tool) => tool.name === "stub__echo");
  assert.ok(echo, "stub__echo was not installed");
  const echoed = await execute(echo, { text: "hello" });
  assert.equal(echoed.isError, undefined);
  assert.match(JSON.stringify(echoed.output), /echo: hello/);

  const events = runtime.tools.find((tool) => tool.name === "mcp_events");
  assert.ok(events, "mcp_events was not installed");
  const catalog = await execute(events, { action: "catalog", server: "stub" });
  assert.equal(catalog.isError, undefined);
  assert.match(JSON.stringify(catalog.output), /stub-event/);

  const subscribed = await execute(events, {
    action: "subscribe",
    server: "stub",
    name: "stub-event",
  });
  assert.equal(subscribed.isError, undefined, JSON.stringify(subscribed));
  const subscription = JSON.parse(subscribed.output[0].text);
  assert.equal(subscription.subscription.status, "active");
  const listed = await execute(events, { action: "list" });
  assert.equal(JSON.parse(listed.output[0].text).subscriptions[0].name, "stub-event");

  const deadline = Date.now() + 5_000;
  while (!messages.some((text) => text.includes("stub-event")) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(
    messages.some((text) => text.includes("stub-event")),
    "no event follow-up was submitted",
  );
} finally {
  await runtime.close();
}

// A rejected credential must not leak the header value into a log.
const authServer = createServer((_request, response) => {
  response.writeHead(401, { "content-type": "text/plain" });
  response.end("unauthorized");
});
await new Promise((resolve) => authServer.listen(0, "127.0.0.1", resolve));
const address = authServer.address();
assert.ok(address && typeof address === "object");
process.env.PI_CODING_AGENT_DIR = writeConfig({
  secure: {
    url: `http://127.0.0.1:${address.port}/mcp`,
    headers: { Authorization: `!printf ${secret}` },
  },
});
const warnings = [];
const warn = console.warn;
console.warn = (...args) => warnings.push(args.map(String).join(" "));
let secureRuntime;
try {
  secureRuntime = await startMcpRuntime();
  assert.ok(
    secureRuntime.failedServers.some((server) => server.name === "secure" && server.auth),
    "401 was not reported as a credentials failure",
  );
  assert.ok(!warnings.join("\n").includes(secret), "the configured header value leaked into a log");
} finally {
  console.warn = warn;
  await secureRuntime?.close();
  authServer.close();
}
