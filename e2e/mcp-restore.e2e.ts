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

function subscription(server: string, name: string, cursor: string, lastEventAt?: string) {
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
    ...(lastEventAt === undefined ? {} : { lastEventAt }),
    updatedAt: new Date().toISOString(),
  };
}

const OLD_BACKLOG_AT = "2026-11-05T20:33:23.582Z";
const startedRecentAt = new Date(Date.now() - 3_000).toISOString();

async function startRestoreApp(
  subscriptions = [
    subscription("restore", "gone-stream", "old:9"),
    subscription("restore", "old-stream", "old:42", OLD_BACKLOG_AT),
    subscription("restore", "recent-stream", "recent:41", startedRecentAt),
    subscription("restore", "flood-stream", "flood:9", startedRecentAt),
    subscription("restore", "live-stream", "live:0"),
    subscription("restore", "burst-stream", "burst:0"),
    subscription("paged", "paged-stream", "paged:0"),
  ],
): Promise<RestoreApp> {
  const dataDir = mkdtempSync(join(tmpdir(), "pi-ui-restore-data-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pi-ui-restore-agent-"));
  const logPath = join(dataDir, "restore-calls.log");
  const pagedLogPath = join(dataDir, "paged-calls.log");
  writeFileSync(
    join(dataDir, "mcp-subscriptions.json"),
    JSON.stringify({ version: 1, subscriptions }, null, 2),
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
            recent: subscriptions.find((item) => item.name === "recent-stream")?.cursor,
            flood: subscriptions.find((item) => item.name === "flood-stream")?.cursor,
            restored: subscriptions.map((item) => item.name).sort(),
          };
        },
        { timeout: 60_000 },
      )
      .toEqual({
        gone: "cancelled",
        old: null,
        live: "active",
        paged: "active",
        recent: "recent-stream:1",
        flood: null,
        restored: [
          "burst-stream",
          "flood-stream",
          "gone-stream",
          "live-stream",
          "old-stream",
          "paged-stream",
          "recent-stream",
        ],
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
    // Two backlogs are one gap status chip each, never a replayed event chip:
    // the old one by its timestamp, the flood one by its size.
    expect(
      state.messages.filter(
        (message) =>
          message.role === "user" &&
          message.text.includes("events were missed while pi was not running"),
      ),
    ).toHaveLength(2);
    expect(state.messages.some((message) => message.text.includes("from flood:9"))).toBe(true);
    expect(
      state.messages.some((message) =>
        message.text.includes(`from old:42 since ${OLD_BACKLOG_AT}`),
      ),
    ).toBe(true);
    expect(
      notices.filter((notice) => notice.ids.some((id) => id.startsWith("flood-"))),
    ).toHaveLength(0);
    expect(notices.filter((notice) => notice.ids.includes("old-stream-backlog"))).toHaveLength(0);
    expect(notices.filter((notice) => notice.ids.includes("recent-stream-backlog"))).toHaveLength(
      1,
    );
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
    // An old backlog starts from now; a recent one still replays its cursor.
    expect(calls).toContain("stream:old-stream:null");
    expect(calls).not.toContain("stream:old-stream:old:42");
    expect(calls).toContain("stream:recent-stream:recent:41");
    // A burst that fills the probe page is a backlog even when it is recent.
    expect(calls).toContain("stream:flood-stream:null");
    expect(calls).not.toContain("stream:flood-stream:flood:9");

    // No events/poll on this server, so the catalog fallback must follow nextCursor.
    const pagedCalls = readFileSync(spawned.pagedLogPath, "utf8").split("\n").filter(Boolean);
    expect(pagedCalls).toContain("list:first");
    expect(pagedCalls).toContain("list:page-2");
    expect(pagedCalls).toContain("stream:paged-stream:null");

    await spawned.stop();
    const persisted = JSON.parse(
      readFileSync(join(spawned.dataDir, "mcp-subscriptions.json"), "utf8"),
    ) as { subscriptions: Array<{ name: string; status: string; cursor: string | null }> };
    expect(persisted.subscriptions.find((item) => item.name === "gone-stream")?.status).toBe(
      "cancelled",
    );
    expect(persisted.subscriptions.find((item) => item.name === "old-stream")?.cursor).toBeNull();
    expect(persisted.subscriptions.find((item) => item.name === "recent-stream")?.cursor).toBe(
      "recent-stream:1",
    );
  } finally {
    await spawned.stop();
    rmSync(spawned.dataDir, { recursive: true, force: true });
  }
});

test("a restore whose backlog predates this process starts from now and reports one gap", async ({
  app,
}) => {
  // Only the age-stale stream, so the latest gap is unambiguously its own;
  // the size-stale flood stream has its own assertion in the first test.
  const spawned = await startRestoreApp([
    subscription("restore", "old-stream", "old:42", OLD_BACKLOG_AT),
  ]);
  try {
    await app.open(`${spawned.url}/`);

    await expect
      .poll(
        async () => {
          const state = await readState(spawned.url);
          const gap = state.mcpEvents?.gap;
          return gap === undefined ? "" : `${gap.from}|${gap.missedSince}`;
        },
        { timeout: 60_000 },
      )
      .toBe(`old:42|${OLD_BACKLOG_AT}`);

    const state = await readState(spawned.url);
    expect(
      state.messages.filter(
        (message) =>
          message.role === "user" &&
          message.text.includes("events were missed while pi was not running"),
      ),
    ).toHaveLength(1);
    expect(mcpNotices(state).flatMap((notice) => notice.ids)).not.toContain("old-stream-backlog");

    const calls = readFileSync(spawned.logPath, "utf8").split("\n").filter(Boolean);
    expect(calls).toContain("stream:old-stream:null");
    expect(calls).not.toContain("stream:old-stream:old:42");
  } finally {
    await spawned.stop();
    rmSync(spawned.dataDir, { recursive: true, force: true });
  }
});

test("a restore a few seconds behind still replays", async ({ app }) => {
  const spawned = await startRestoreApp();
  try {
    await app.open(`${spawned.url}/`);

    await expect
      .poll(
        async () => {
          const state = await readState(spawned.url);
          return state.mcpEvents?.subscriptions.find((item) => item.name === "recent-stream")
            ?.cursor;
        },
        { timeout: 60_000 },
      )
      .toBe("recent-stream:1");

    const state = await readState(spawned.url);
    expect(
      mcpNotices(state)
        .flatMap((notice) => notice.ids)
        .filter((id) => id === "recent-stream-backlog"),
    ).toHaveLength(1);
    const calls = readFileSync(spawned.logPath, "utf8").split("\n").filter(Boolean);
    expect(calls).toContain("stream:recent-stream:recent:41");
  } finally {
    await spawned.stop();
    rmSync(spawned.dataDir, { recursive: true, force: true });
  }
});

test("an old lastEventAt with an empty poll keeps the current cursor and records no gap", async ({
  app,
}) => {
  const spawned = await startRestoreApp([
    subscription("restore", "idle-stream", "idle:7", OLD_BACKLOG_AT),
  ]);
  try {
    await app.open(`${spawned.url}/`);

    await expect
      .poll(
        async () => {
          const state = await readState(spawned.url);
          return state.mcpEvents?.subscriptions.find((item) => item.name === "idle-stream")?.cursor;
        },
        { timeout: 60_000 },
      )
      .toBe("idle:7");

    const state = await readState(spawned.url);
    expect(state.mcpEvents?.gap).toBeUndefined();
    expect(
      state.messages.some(
        (message) =>
          message.role === "user" &&
          message.text.includes("events were missed while pi was not running"),
      ),
    ).toBe(false);

    const calls = readFileSync(spawned.logPath, "utf8").split("\n").filter(Boolean);
    expect(calls).toContain("stream:idle-stream:idle:7");
    expect(calls).not.toContain("stream:idle-stream:null");

    await spawned.stop();
    const persisted = JSON.parse(
      readFileSync(join(spawned.dataDir, "mcp-subscriptions.json"), "utf8"),
    ) as { subscriptions: Array<{ name: string; cursor: string | null }> };
    expect(persisted.subscriptions.find((item) => item.name === "idle-stream")?.cursor).toBe(
      "idle:7",
    );
  } finally {
    await spawned.stop();
    rmSync(spawned.dataDir, { recursive: true, force: true });
  }
});
