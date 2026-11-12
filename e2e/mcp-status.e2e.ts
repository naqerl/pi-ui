import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { McpEventFeed } from "../src/server/mcp-events.ts";
import { acceptMcpStatusNotice } from "../src/server/mcp-status-intake.ts";
import { deriveStableId } from "../src/server/mcp-subscriptions.ts";
import { MCP_STATUS_HEAD } from "../src/shared/notices.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const backendEntry = fileURLToPath(new URL("./backend.mjs", import.meta.url));
const fixtureEntry = fileURLToPath(new URL("./session-drop-mcp.mjs", import.meta.url));

type Page = { evaluate: <T, A = undefined>(fn: (arg: A) => T | Promise<T>, arg?: A) => Promise<T> };

interface State {
  run?: string;
  messages?: Array<{ role?: string; text?: string }>;
  mcpEvents?: {
    subscriptions: Array<{ id: string; name: string; status: string; cursor: string | null }>;
  };
  activity?: Array<{ name?: string; output?: string }>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close();
        reject(new Error("the port probe has no TCP address"));
        return;
      }
      const port = address.port;
      probe.close((error) => (error === undefined ? resolve(port) : reject(error)));
    });
  });
}

function lines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function waitForHealth(
  url: string,
  child: ChildProcess,
  output: () => string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        if (child.exitCode !== null) return `exited: ${output()}`;
        try {
          const response = await fetch(new URL("/api/health", url));
          return response.ok ? "ok" : `status ${response.status}`;
        } catch {
          return "starting";
        }
      },
      { timeout: 120_000 },
    )
    .toBe("ok");
}

async function startEventDropApp(mode: "event-drop" | "event-cut" = "event-drop") {
  const dir = mkdtempSync(join(tmpdir(), "pi-ui-status-e2e-"));
  const statePath = join(dir, "fixture.log");
  const agentDir = join(dir, "agent");
  const dataDir = join(dir, "data");
  mkdirSync(agentDir, { recursive: true });
  const port = await freePort();
  const fixturePort = await freePort();
  const fixture = spawn(process.execPath, [fixtureEntry], {
    cwd: root,
    env: {
      ...process.env,
      SESSION_DROP_MODE: mode,
      SESSION_DROP_STATE: statePath,
      SESSION_DROP_PORT: String(fixturePort),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let fixtureLog = "";
  const appendFixture = (chunk: Buffer) => {
    fixtureLog = `${fixtureLog}${chunk.toString()}`.slice(-20_000);
  };
  fixture.stdout?.on("data", appendFixture);
  fixture.stderr?.on("data", appendFixture);
  await expect
    .poll(() => lines(statePath).includes("listening"), {
      timeout: 20_000,
      message: `event-drop fixture did not listen\n${fixtureLog}`,
    })
    .toBe(true);

  writeFileSync(
    join(agentDir, "mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          tracer: { url: `http://127.0.0.1:${fixturePort}/mcp`, requestTimeoutMs: 5_000 },
          web: { command: process.execPath, disabled: true },
        },
      },
      null,
      2,
    ),
  );
  const backend = spawn(process.execPath, ["--import", "tsx", backendEntry], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      PI_E2E_LIVE: "0",
      PI_E2E_DATA_DIR: dataDir,
      PI_E2E_AGENT_DIR: agentDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let backendLog = "";
  const appendBackend = (chunk: Buffer) => {
    backendLog = `${backendLog}${chunk.toString()}`.slice(-50_000);
  };
  backend.stdout?.on("data", appendBackend);
  backend.stderr?.on("data", appendBackend);
  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(url, backend, () => backendLog);
  } catch (error) {
    backend.kill("SIGKILL");
    fixture.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return {
    url,
    statePath,
    stop: async () => {
      for (const child of [backend, fixture]) {
        if (child.exitCode !== null) continue;
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGTERM");
        await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function readState(baseUrl: string): Promise<State> {
  const response = await fetch(new URL("/api/state", baseUrl), { cache: "no-store" });
  expect(response.ok).toBe(true);
  return (await response.json()) as State;
}

async function send(baseUrl: string, text: string): Promise<void> {
  const response = await fetch(new URL("/api/message", baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, mode: "queue" }),
  });
  expect(response.ok).toBe(true);
}

const toolIdle = (browser: Page) =>
  browser.evaluate(async () => {
    const response = await fetch("/api/state");
    const state = (await response.json()) as State;
    return {
      idle: state.run === "idle",
      loaded: (state.activity ?? []).some(
        (item) => item.name === "tool_search" && (item.output ?? "").includes("mcp_events"),
      ),
    };
  });

test("the production intake drops untracked and healthy status without a chat item", () => {
  const feed = new McpEventFeed();
  feed.ingest({
    customType: "mcp-events-tool",
    details: {
      args: { action: "subscribe" },
      result: {
        subscription: { id: "b-live", server: "hub", name: "hub", status: "active" },
      },
    },
  });
  const accepted: string[] = [];
  const intake = (text: string, details?: unknown, customType?: string) => {
    const value = acceptMcpStatusNotice(feed, text, details, customType);
    if (value !== null) accepted.push(value);
  };
  const subscriptions = [{ id: "a-dead", server: "hub", name: "hub", status: "failed" }];

  intake(
    `${MCP_STATUS_HEAD}\n${JSON.stringify({ subscriptions })}`,
    { subscriptions },
    "mcp-events-status",
  );
  intake(
    `${MCP_STATUS_HEAD}\nhub: subscription=a-dead is failed.`,
    { subscription_id: "a-dead", server: "hub", name: "hub", status: "failed" },
    "mcp-ui-status",
  );
  const healthy = [{ id: "b-live", server: "hub", name: "hub", status: "active" }];
  intake(
    `${MCP_STATUS_HEAD}\n${JSON.stringify({ subscriptions: healthy })}`,
    { subscriptions: healthy },
    "mcp-events-status",
  );

  // A durable-id-only status describes the same live row. While that row is
  // still delivering it is not news, but the real intake (not just the feed
  // predicate) must be the thing that keeps it out of chat.
  feed.ingest({
    customType: "mcp-events-traffic",
    details: {
      subscription_id: "b-live",
      server: "hub",
      cursor: "hub:900",
      timestamp: new Date().toISOString(),
    },
  });
  const stableId = deriveStableId("hub", "hub", {});
  const durable = [{ stable_id: stableId, server: "hub", name: "hub", status: "reconnecting" }];
  intake(
    `${MCP_STATUS_HEAD}\n${JSON.stringify({ subscriptions: durable })}`,
    { subscriptions: durable },
    "mcp-events-status",
  );

  expect(accepted).toEqual([]);
  expect(feed.state.subscriptions[0]?.status).toBe("active");
});

test("a killed tracked stream reconnects at its cursor with one outage notice", {
  timeout: 240_000,
}, async ({ app, browser }) => {
  const spawned = await startEventDropApp();
  try {
    await app.open(`${spawned.url}/`);
    await send(
      spawned.url,
      `TOOLCALLS ${JSON.stringify([{ name: "tool_search", arguments: { query: "mcp_events" } }])}`,
    );
    await expect
      .poll(() => toolIdle(browser), { timeout: 60_000 })
      .toEqual({ idle: true, loaded: true });

    await send(
      spawned.url,
      `TOOLCALLS ${JSON.stringify([
        {
          name: "mcp_events",
          arguments: { action: "subscribe", server: "tracer", name: "drop-stream" },
        },
      ])}`,
    );
    await expect
      .poll(
        async () =>
          (await readState(spawned.url)).mcpEvents?.subscriptions.find(
            (item) => item.name === "drop-stream",
          ),
        { timeout: 60_000 },
      )
      .toEqual(expect.objectContaining({ status: "active", cursor: "drop:1" }));

    // The first stream stays silent past the extension's 65 s heartbeat
    // timeout, then reconnects from the cursor it had acknowledged.
    await expect
      .poll(
        () => lines(spawned.statePath).filter((line) => line.startsWith("stream:drop-stream:")),
        {
          timeout: 120_000,
        },
      )
      .toEqual(["stream:drop-stream:null", "stream:drop-stream:drop:1"]);

    // The drop and its recovery are each news once; the dead cursor is not
    // reset to a zero position on the replacement transport.
    await expect
      .poll(
        async () => {
          const state = await readState(spawned.url);
          const status = (state.messages ?? [])
            .map((message) => message.text ?? "")
            .filter((text) => text.startsWith(MCP_STATUS_HEAD));
          return {
            cursor: state.mcpEvents?.subscriptions.find((item) => item.name === "drop-stream")
              ?.cursor,
            outages: status.filter((text) => text.includes('"status":"reconnecting"')).length,
            recoveries: status.filter((text) => text.includes('"status":"active"')).length,
          };
        },
        { timeout: 90_000 },
      )
      .toEqual({ cursor: "drop:1", outages: 1, recoveries: 1 });
    expect(lines(spawned.statePath)).toContain("drop-stream");
    expect(lines(spawned.statePath)).not.toContain("stream:drop-stream:drop:0");
  } finally {
    await spawned.stop();
  }
});

test("a cut stream resumes at its last cursor without a status notice", {
  timeout: 240_000,
}, async ({ app, browser }) => {
  const spawned = await startEventDropApp("event-cut");
  try {
    await app.open(`${spawned.url}/`);
    await send(
      spawned.url,
      `TOOLCALLS ${JSON.stringify([{ name: "tool_search", arguments: { query: "mcp_events" } }])}`,
    );
    await expect
      .poll(() => toolIdle(browser), { timeout: 60_000 })
      .toEqual({ idle: true, loaded: true });

    await send(
      spawned.url,
      `TOOLCALLS ${JSON.stringify([
        {
          name: "mcp_events",
          arguments: { action: "subscribe", server: "tracer", name: "drop-stream" },
        },
      ])}`,
    );

    // The first request stream ends after one delivered event. The replacement
    // stream must continue from that event's cursor, not the original position.
    await expect
      .poll(
        () => lines(spawned.statePath).filter((line) => line.startsWith("stream:drop-stream:")),
        { timeout: 60_000 },
      )
      .toEqual(["stream:drop-stream:null", "stream:drop-stream:drop:2"]);

    // The next event proves the replacement stream is delivering, so the row is
    // healthy again and no generation death belonged in the chat.
    await expect
      .poll(
        async () =>
          (await readState(spawned.url)).mcpEvents?.subscriptions.find(
            (item) => item.name === "drop-stream",
          ),
        { timeout: 60_000 },
      )
      .toEqual(expect.objectContaining({ status: "active", cursor: "drop:3" }));

    const state = await readState(spawned.url);
    const statuses = (state.messages ?? [])
      .map((message) => message.text ?? "")
      .filter((text) => text.startsWith(MCP_STATUS_HEAD));
    expect(statuses).toEqual([]);
    expect(lines(spawned.statePath)).not.toContain("stream:drop-stream:drop:0");
  } finally {
    await spawned.stop();
  }
});
