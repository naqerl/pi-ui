import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import type { Snapshot } from "../src/shared/types";

const root = fileURLToPath(new URL("..", import.meta.url));
const backendEntry = fileURLToPath(new URL("./backend.mjs", import.meta.url));
const restoreStub = fileURLToPath(new URL("./restore-mcp.mjs", import.meta.url));

interface RestoreApp {
  readonly url: string;
  readonly dataDir: string;
  readonly logPath: string;
  readonly pagedLogPath: string;
  readonly stop: () => Promise<void>;
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

async function waitForHealth(baseUrl: string, child: ChildProcess, logs: () => string) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`app exited before it answered\n${logs()}`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The app is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`app did not answer within 90 seconds\n${logs()}`);
}

function subscription(server: string, name: string, cursor: string) {
  return {
    server,
    name,
    stableId: `${server}/${name}`,
    id:
      name === "gone-stream"
        ? "mcp-extension-83ab15c2-8ac6-476f-b275-61e1954ce993-0"
        : `${name}-old`,
    arguments: {},
    cursor,
    status: "active",
    enabled: true,
    deliveredEventIds: [],
    updatedAt: new Date().toISOString(),
  };
}

async function startRestoreApp(): Promise<RestoreApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-ui-restore-data-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pi-ui-restore-agent-"));
  const logPath = join(dataDir, "restore-calls.log");
  const pagedLogPath = join(dataDir, "paged-calls.log");
  writeFileSync(
    join(dataDir, "mcp-subscriptions.json"),
    JSON.stringify(
      {
        version: 1,
        subscriptions: [
          subscription("restore", "gone-stream", "old:9"),
          subscription("restore", "old-stream", "old:42"),
          subscription("restore", "live-stream", "live:0"),
          subscription("restore", "burst-stream", "burst:0"),
          subscription("paged", "paged-stream", "paged:0"),
        ],
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(agentDir, "mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          restore: {
            command: process.execPath,
            args: [restoreStub],
            env: { RESTORE_MCP_LOG: logPath },
          },
          paged: {
            command: process.execPath,
            args: [restoreStub],
            env: { RESTORE_MCP_LOG: pagedLogPath, RESTORE_MCP_MODE: "paged" },
          },
          web: { command: process.execPath, disabled: true },
        },
      },
      null,
      2,
    ),
  );

  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", backendEntry], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      PI_E2E_LIVE: "0",
      PI_E2E_DATA_DIR: dataDir,
      PI_E2E_AGENT_DIR: agentDir,
      PI_MCP_WATCHDOG_INTERVAL_MS: "250",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const append = (chunk: Buffer) => {
    log = `${log}${chunk.toString()}`.slice(-50_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  const url = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(url, child, () => log);
  } catch (error) {
    child.kill("SIGKILL");
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    throw error;
  }

  return {
    url,
    dataDir,
    logPath,
    pagedLogPath,
    stop: async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      rmSync(agentDir, { recursive: true, force: true });
    },
  };
}

async function readState(baseUrl: string): Promise<Snapshot> {
  const response = await fetch(new URL("/api/state", baseUrl), { cache: "no-store" });
  expect(response.ok).toBe(true);
  return (await response.json()) as Snapshot;
}

function mcpNotices(state: Snapshot) {
  return state.messages.map((message) => {
    const notice = message.notice as
      | { kind?: string; events?: Array<{ id?: string | null }> }
      | undefined;
    return {
      kind: notice?.kind ?? "",
      ids: (notice?.events ?? []).map((event) => event.id ?? ""),
    };
  });
}

test("a restored subscription the server rejects is cancelled and never polled again", async ({
  app,
}) => {
  const spawned = await startRestoreApp();
  try {
    await app.open(`${spawned.url}/`);

    await expect
      .poll(
        async () => {
          const state = await readState(spawned.url);
          const subscriptions = state.mcpEvents?.subscriptions ?? [];
          return {
            gone: subscriptions.find((item) => item.name === "gone-stream")?.status,
            old: subscriptions.find((item) => item.name === "old-stream")?.cursor,
            live: subscriptions.find((item) => item.name === "live-stream")?.status,
            paged: subscriptions.find((item) => item.name === "paged-stream")?.status,
            restored: subscriptions.map((item) => item.name).sort(),
          };
        },
        { timeout: 60_000 },
      )
      .toEqual({
        gone: "cancelled",
        old: "old-stream:1",
        live: "active",
        paged: "active",
        restored: ["burst-stream", "gone-stream", "live-stream", "old-stream", "paged-stream"],
      });

    // The healthy restore still delivers its new event as a chat notice.
    await expect
      .poll(
        async () => {
          const state = await readState(spawned.url);
          return mcpNotices(state).some(
            (notice) => notice.kind === "mcp" && notice.ids.includes("live-1"),
          );
        },
        { timeout: 30_000 },
      )
      .toBe(true);

    // Give the old backlog and the 22-event burst time to arrive.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const state = await readState(spawned.url);
    const notices = mcpNotices(state);
    // A provider-reported replay gap is a durable MCP status chip, not a lost UI toast.
    expect(
      state.messages.some(
        (message) =>
          message.notice?.kind === "mcp" &&
          message.text.includes("replay is truncated for old-stream"),
      ),
    ).toBe(true);
    expect(notices.filter((notice) => notice.ids.includes("old-stream-backlog"))).toHaveLength(1);
    expect(
      notices.filter((notice) => notice.ids.some((id) => id.startsWith("burst-"))).length,
    ).toBe(1);
    expect(
      notices
        .flatMap((notice) => notice.ids)
        .filter((id) => id.startsWith("burst-"))
        .sort(),
    ).toEqual(Array.from({ length: 22 }, (_, index) => `burst-${index + 1}`).sort());
    expect(
      notices.filter((notice) => notice.ids.some((id) => id.startsWith("gone-stream"))),
    ).toHaveLength(0);

    const calls = readFileSync(spawned.logPath, "utf8").split("\n").filter(Boolean);
    // One rejection at boot, then the dropped id is remembered.
    expect(calls.filter((line) => line.startsWith("poll:gone-stream:"))).toHaveLength(1);
    expect(calls.filter((line) => line.startsWith("stream:gone-stream:"))).toHaveLength(0);
    // The acknowledged cursor is replayed; an unseen preboot ID is not thrown away.
    expect(calls).toContain("stream:old-stream:old:42");
    expect(calls).not.toContain("stream:old-stream:old-stream:1");

    // No events/poll on this server, so the catalog fallback must follow nextCursor.
    const pagedCalls = readFileSync(spawned.pagedLogPath, "utf8").split("\n").filter(Boolean);
    expect(pagedCalls).toContain("list:first");
    expect(pagedCalls).toContain("list:page-2");
    expect(pagedCalls).toContain("stream:paged-stream:paged:0");

    await spawned.stop();
    const persisted = JSON.parse(
      readFileSync(join(spawned.dataDir, "mcp-subscriptions.json"), "utf8"),
    ) as { subscriptions: Array<{ name: string; status: string; cursor: string | null }> };
    expect(persisted.subscriptions.find((item) => item.name === "gone-stream")?.status).toBe(
      "cancelled",
    );
    expect(persisted.subscriptions.find((item) => item.name === "old-stream")?.cursor).toBe(
      "old-stream:1",
    );
  } finally {
    await spawned.stop();
    rmSync(spawned.dataDir, { recursive: true, force: true });
  }
});
