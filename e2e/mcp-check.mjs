#!/usr/bin/env node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpEventFeed } from "../src/server/mcp-events.ts";
import { startMcpRuntime } from "../src/server/mcp-runtime.ts";

const stub = join(import.meta.dirname, "stub-mcp.mjs");
const staleStub = join(import.meta.dirname, "stale-mcp.mjs");
const recoveringStub = join(import.meta.dirname, "recovering-mcp.mjs");
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
// Wired as the server does: the feed behind /api/state, the MCP events widget
// and the mcp widget must see subscription events, not only tool results (#3).
const feed = new McpEventFeed();
runtime.setObserver((notice) => feed.ingest(notice));

async function waitForFeed(check, what, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(check(), `${what}; feed: ${JSON.stringify(feed.state)}`);
}
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
  await waitForFeed(
    () => feed.state.events.some((event) => event.id === "stub-event-1"),
    "the subscription event did not reach the event feed",
  );
  const delivered = feed.state.events.find((event) => event.id === "stub-event-1");
  assert.equal(delivered.server, "stub");
  assert.equal(delivered.name, "stub-event");
  assert.match(delivered.summary, /from-stub/);
  assert.equal(feed.state.notice, "new event from stub");
  assert.equal(
    feed.state.subscriptions.find((item) => item.id === subscription.subscription.id)?.cursor,
    "stub-cursor-1",
  );

  // A hub-shaped stream: numeric eventId and timestamp, and a kind that is not
  // the stream name. pi-mcp-events alone drops every such event in silence.
  const hub = await execute(events, { action: "subscribe", server: "stub", name: "stub-hub" });
  assert.equal(hub.isError, undefined, JSON.stringify(hub));
  await waitForFeed(
    () => feed.state.events.some((event) => event.id === "510"),
    "the hub-shaped event did not reach the event feed",
  );
  const job = feed.state.events.find((event) => event.id === "510");
  assert.equal(job.name, "stub-hub.job");
  assert.match(job.timestamp, /^\d{4}-\d\d-\d\dT/);
  assert.match(job.summary, /job-1/);
  await waitForFeed(
    () => messages.some((text) => text.includes("job-1")),
    "the hub-shaped event follow-up was not submitted",
  );
  const hubId = JSON.parse(hub.output[0].text).subscription.id;
  assert.equal(feed.state.subscriptions.find((item) => item.id === hubId)?.cursor, "hub:510");
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

// A live subscription that receives Invalid Request must open a new session.
// Method not found stays failed and must not open another stream.
function subscription(listed, server) {
  const parsed = JSON.parse(listed.output[0].text);
  return parsed.subscriptions.find((item) => item.server === server);
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

const staleDir = mkdtempSync(join(tmpdir(), "pi-ui-mcp-stale-"));
const recoveredState = join(staleDir, "recovered.txt");
const terminalState = join(staleDir, "terminal.txt");
writeFileSync(
  join(staleDir, "mcp.json"),
  JSON.stringify(
    {
      mcpServers: {
        recovered: {
          command: process.execPath,
          args: [staleStub],
          env: { STALE_MCP_MODE: "invalid-request", STALE_MCP_STATE: recoveredState },
        },
        terminal: {
          command: process.execPath,
          args: [staleStub],
          env: { STALE_MCP_MODE: "method-not-found", STALE_MCP_STATE: terminalState },
        },
      },
    },
    null,
    2,
  ),
);
process.env.PI_CODING_AGENT_DIR = staleDir;
const recoveredMessages = [];
const staleRuntime = await startMcpRuntime({
  submit: (text) => recoveredMessages.push(text),
});
try {
  const events = staleRuntime.tools.find((tool) => tool.name === "mcp_events");
  assert.ok(events, "mcp_events was not installed for the stale session");
  const subscribed = await execute(events, {
    action: "subscribe",
    server: "recovered",
    name: "stub-event",
  });
  assert.equal(subscribed.isError, undefined, JSON.stringify(subscribed));
  const sawRecovery = await waitFor(
    () => recoveredMessages.some((text) => text.includes("recovered-event")),
    10_000,
  );
  assert.ok(sawRecovery, `subscription did not reconnect: ${recoveredMessages.join("\n")}`);
  const live = subscription(await execute(events, { action: "list" }), "recovered");
  assert.equal(live?.status, "active");
  assert.equal(readFileSync(recoveredState, "utf8").trim(), "2");

  const rejected = await execute(events, {
    action: "subscribe",
    server: "terminal",
    name: "stub-event",
  });
  assert.equal(rejected.isError, undefined, JSON.stringify(rejected));
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  assert.equal(readFileSync(terminalState, "utf8").trim(), "1");
  const dead = subscription(await execute(events, { action: "list" }), "terminal");
  assert.equal(dead?.status, "failed");
  assert.match(dead?.error ?? "", /Method not found/);
} finally {
  await staleRuntime.close();
}

// A failed boot probe must not keep a server unavailable after its events
// protocol connects; that connection is a live probe of the same definition.
const recoveryDir = mkdtempSync(join(tmpdir(), "pi-ui-mcp-recovery-"));
const recoveryMarker = join(recoveryDir, "spawned");
writeFileSync(
  join(recoveryDir, "mcp.json"),
  JSON.stringify(
    {
      mcpServers: {
        recovering: {
          command: process.execPath,
          args: [recoveringStub],
          env: { RECOVERING_MCP_MARKER: recoveryMarker },
        },
      },
    },
    null,
    2,
  ),
);
process.env.PI_CODING_AGENT_DIR = recoveryDir;
const recoveryRuntime = await startMcpRuntime();
try {
  assert.ok(
    recoveryRuntime.failedServers.some((server) => server.name === "recovering"),
    "the failed boot probe was not reported",
  );
  assert.deepEqual(recoveryRuntime.status.unavailable, ["recovering"]);

  const recoveryEvents = recoveryRuntime.tools.find((tool) => tool.name === "mcp_events");
  assert.ok(recoveryEvents, "mcp_events was not installed for the recovering server");
  const catalog = await execute(recoveryEvents, { action: "catalog", server: "recovering" });
  assert.equal(catalog.isError, undefined, JSON.stringify(catalog));
  assert.match(JSON.stringify(catalog.output), /stub-event/);
  assert.ok(
    !recoveryRuntime.failedServers.some((server) => server.name === "recovering"),
    "a successful protocol connection did not clear the boot failure",
  );
  const recovered = recoveryRuntime.status.servers.find((server) => server.name === "recovering");
  assert.equal(recovered?.available, true);
  assert.equal(recovered?.authRejected, false);
  assert.deepEqual(recoveryRuntime.status.unavailable, []);
} finally {
  await recoveryRuntime.close();
}
