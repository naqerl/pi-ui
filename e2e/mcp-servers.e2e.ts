import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  IdleNudge,
  idleNudgeText,
  staleWorkedTasks,
  taskSetHash,
} from "../src/server/idle-nudge.js";
import { TaskActivityTracker } from "../src/server/task-activity.js";
import { parseNotice } from "../src/shared/notices.js";
import type { Snapshot } from "../src/shared/types";

const check = fileURLToPath(new URL("./mcp-check.mjs", import.meta.url));

function runCheck(): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ["--import", "tsx", check], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ code, output }));
  });
}

test("bridges a stub MCP server, survives a broken one, and relays events", async () => {
  const result = await runCheck();
  expect(result.output).not.toMatch(/super-secret-token-9f3c/);
  expect(result.code).toBe(0);
});

const root = fileURLToPath(new URL("..", import.meta.url));
const serverEntry = fileURLToPath(new URL("./server.mjs", import.meta.url));

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
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`app exited before it answered\n${logs()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // The app is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`app did not answer within 60 seconds\n${logs()}`);
}

async function startApp(allMcpReachable: boolean): Promise<{
  url: string;
  stop: () => Promise<void>;
}> {
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", serverEntry], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      // The spawned app always uses the offline fake model and its own stub
      // MCP config, even when the outer suite is running against a live model.
      PI_E2E_LIVE: "0",
      PI_E2E_MCP_ALL_REACHABLE: allMcpReachable ? "1" : "0",
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
    throw error;
  }

  return {
    url,
    stop: async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
}

async function readState(baseUrl: string): Promise<Snapshot> {
  const response = await fetch(new URL("/api/state", baseUrl), { cache: "no-store" });
  expect(response.ok).toBe(true);
  return (await response.json()) as Snapshot;
}

test("shows exactly one configured but unreachable MCP server", async ({
  app,
  browser,
  screen,
}) => {
  const spawned = await startApp(false);
  try {
    await app.open(`${spawned.url}/`);
    const state = await readState(spawned.url);

    expect(state.mcp.unavailable).toEqual(["unreachable"]);
    expect(
      state.mcp.servers.filter((server) => !server.available).map((server) => server.name),
    ).toEqual(["unreachable"]);
    const stub = state.mcp.servers.find((server) => server.name === "stub");
    expect(stub?.available).toBe(true);
    expect(stub?.tools).toContain("stub__echo");

    // The composer chrome does not carry MCP text; the MCP widget on Stats does.
    await expect(screen.getByRole("textbox", "Message")).toBeVisible();
    expect(
      await browser.evaluate(
        () => document.querySelector('[data-testid="composer-dock"]')?.textContent ?? "",
      ),
    ).not.toMatch(/unreachable|unavailable/);
    await screen.getByRole("tab", "Stats").tap();
    await expect(screen.getByTestId("stat-mcp-unreachable")).toBeVisible();
    expect(
      await browser.evaluate(() =>
        [...document.querySelectorAll('[data-testid="widget-mcp"] li[data-state]')]
          .map(
            (item) =>
              `${item.getAttribute("data-testid")}:${item.getAttribute("data-state")}:${item.textContent}`,
          )
          .filter((row) => /^stat-mcp-(stub|unreachable):/.test(row)),
      ),
    ).toEqual([
      "stat-mcp-stub:ok:stub1 tool",
      "stat-mcp-unreachable:error:unreachableunavailable · server unreachable",
    ]);
    await expect(screen.getByTestId("widget-mcp-events")).toBeVisible();

    await app.screenshot("mcp-unavailable-widget");
    await screen.getByRole("tab", "Chat").tap();
  } finally {
    await spawned.stop();
  }
});

test("shows every server as connected when all are reachable", async ({ app, browser, screen }) => {
  const spawned = await startApp(true);
  try {
    await app.open(`${spawned.url}/`);
    const state = await readState(spawned.url);

    expect(state.mcp.unavailable).toEqual([]);
    const stub = state.mcp.servers.find((server) => server.name === "stub");
    expect(stub?.available).toBe(true);
    expect(stub?.tools).toContain("stub__echo");
    await screen.getByRole("tab", "Stats").tap();
    await expect(screen.getByTestId("stat-mcp-stub")).toBeVisible();
    expect(
      await browser.evaluate(
        () => document.querySelector('[data-testid="widget-mcp"]')?.textContent ?? "",
      ),
    ).not.toMatch(/unavailable/);
    await screen.getByRole("tab", "Chat").tap();
  } finally {
    await spawned.stop();
  }
});

const restoreRoot = fileURLToPath(new URL("..", import.meta.url));
const backendEntry = fileURLToPath(new URL("./backend.mjs", import.meta.url));
const restoreStub = fileURLToPath(new URL("./restore-mcp.mjs", import.meta.url));

interface RestoreApp {
  readonly url: string;
  readonly dataDir: string;
  readonly logPath: string;
  readonly pagedLogPath: string;
  readonly stop: () => Promise<void>;
}

function restoreFreePort(): Promise<number> {
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

async function waitRestoreHealth(baseUrl: string, child: ChildProcess, logs: () => string) {
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

  const port = await restoreFreePort();
  const child = spawn(process.execPath, ["--import", "tsx", backendEntry], {
    cwd: restoreRoot,
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
    await waitRestoreHealth(url, child, () => log);
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
    expect(notices.filter((notice) => notice.ids.includes("old-stream-backlog"))).toHaveLength(0);
    expect(
      notices.filter((notice) => notice.ids.some((id) => id.startsWith("burst-"))).length,
    ).toBeLessThanOrEqual(1);
    expect(
      notices.filter((notice) => notice.ids.some((id) => id.startsWith("gone-stream"))),
    ).toHaveLength(0);

    const calls = readFileSync(spawned.logPath, "utf8").split("\n").filter(Boolean);
    // One rejection at boot, then the dropped id is remembered.
    expect(calls.filter((line) => line.startsWith("poll:gone-stream:"))).toHaveLength(1);
    expect(calls.filter((line) => line.startsWith("stream:gone-stream:"))).toHaveLength(0);
    // The known subscription resumes at the fresh server cursor, not the backlog cursor.
    expect(calls).toContain("stream:old-stream:old-stream:1");
    expect(calls).not.toContain("stream:old-stream:old:42");

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

const nothing = { active: false, queued: 0, openTaskIds: [] as string[] };
const now = Date.parse("2026-10-31T12:00:00.000Z");
const hour = 60 * 60_000;
const old = new Date(now - 2 * hour).toISOString();
const recent = new Date(now - 60_000).toISOString();

function workingTask(
  id: string,
  title: string,
  patch: Partial<{ lastWorkedAt: string; workingSince: string }> = {},
) {
  return {
    id,
    title,
    status: "working" as const,
    blockedBy: [],
    workingSince: old,
    lastWorkedAt: old,
    ...patch,
  };
}

test("a stale working task is actualized while a freshly worked one is not", () => {
  const stale = workingTask("w1", "Long-running badge");
  const fresh = workingTask("w2", "Fresh work", { lastWorkedAt: recent });
  expect(staleWorkedTasks([stale, fresh], now).map((task) => task.id)).toEqual(["w1"]);

  const nudge = new IdleNudge(1_000, 0, "");
  const text = nudge.maybeNudge({ ...nothing, tasks: [stale, fresh] }, now) ?? "";
  const actualize = text.split("\n\n").find((part) => part.startsWith("Actualize these tasks"));
  expect(actualize).toContain("w1 — Long-running badge");
  expect(actualize).not.toContain("w2 —");
  expect(actualize).toContain("confirm it is still being worked on");
  expect(actualize).toContain("task_done and evidence");
  expect(parseNotice(text)?.kind).toBe("idle");
});

test("a stale working task nudges even when there is no new work", () => {
  const stale = workingTask("w1", "Still marked working");
  const nudge = new IdleNudge(1_000, 0, "");
  const text =
    nudge.maybeNudge(
      { ...nothing, openTaskIds: [], workingTaskIds: [], staleTasks: [stale] },
      now,
    ) ?? "";
  expect(text.startsWith("You have been idle for 20 minutes. Actualize these tasks.")).toBe(true);
  expect(text).toContain("w1 — Still marked working");
  const notice = parseNotice(text);
  expect(notice?.kind).toBe("idle");
  expect(notice?.kind === "idle" ? notice.taskIds.join(",") : "").toBe("w1");
});

test("an unchanged new-work and actualize set stays silent", () => {
  const open = { id: "o1", title: "New work", status: "open" as const, blockedBy: [] };
  const stale = workingTask("w1", "Still marked working");
  const state = { ...nothing, tasks: [open, stale] };
  const nudge = new IdleNudge(1_000, 0, "");

  const first = nudge.maybeNudge(state, now) ?? "";
  expect(first).toContain("open: o1");
  expect(first).toContain("Actualize these tasks");
  expect(nudge.nudgedHash).toBe(taskSetHash(["o1", "w1"]));

  nudge.noteActivity(now + 1);
  expect(nudge.maybeNudge(state, now + 2_000)).toBeNull();
});

test("no tasks at all still means no nudge", () => {
  const quiet = new IdleNudge(1_000, 0, "");
  expect(quiet.maybeNudge({ ...nothing }, now)).toBeNull();
  expect(
    quiet.maybeNudge({ ...nothing, tasks: [{ id: "d1", status: "done" as const }] }, now),
  ).toBeNull();
});

test("the protocol still names new work and stays empty without tasks", () => {
  expect(idleNudgeText(["a1"])).toContain("task(s) are open: a1");
  expect(idleNudgeText([])).toContain("0 task(s) are open");
});

function closedTask(id: string, title: string, at: string) {
  return {
    id,
    title,
    status: "done" as const,
    blockedBy: [],
    completedAt: at,
    lastWorkedAt: null,
  };
}

test("a closure since the last nudge asks for a memory write", () => {
  const closed = closedTask("d1", "Ship the ledger", new Date(now - 30 * 60_000).toISOString());
  const nudge = new IdleNudge(1_000, now - 2 * hour, "");
  const text = nudge.maybeNudge({ ...nothing, tasks: [closed] }, now) ?? "";

  expect(text).toContain(
    'You closed d1 "Ship the ledger" since the last nudge and have not written anything durable about it.',
  );
  expect(text).toContain("memory_write (long_term for the topic, daily for the log)");
  const notice = parseNotice(text);
  expect(notice?.kind).toBe("idle");
  expect(notice?.kind === "idle" ? notice.taskIds : []).toEqual(["d1"]);
  expect(notice?.kind === "idle" ? notice.closed : false).toBe(true);
  expect(nudge.nudgedHash).toBe(taskSetHash(["d1"]));
});

test("the same closure on the next tick stays silent", () => {
  const open = { id: "o1", title: "New work", status: "open" as const, blockedBy: [] };
  const closed = closedTask("d1", "Ship the ledger", new Date(now - 30 * 60_000).toISOString());
  const state = { ...nothing, tasks: [open, closed] };
  const nudge = new IdleNudge(1_000, now - 2 * hour, "");

  const first = nudge.maybeNudge(state, now) ?? "";
  expect(first).toContain("open: o1");
  expect(first).toContain('You closed d1 "Ship the ledger"');

  nudge.noteActivity(now + 1);
  expect(nudge.maybeNudge(state, now + 2_000)).toBeNull();
});

test("a failed closure-only submission is retried after re-arming", () => {
  const closed = closedTask("d1", "Ship the ledger", new Date(now - 30 * 60_000).toISOString());
  const state = { ...nothing, tasks: [closed] };
  const nudge = new IdleNudge(1_000, now - 2 * hour, "");

  expect(nudge.maybeNudge(state, now)).toContain('You closed d1 "Ship the ledger"');
  nudge.forgetNudge();
  nudge.noteActivity(now);

  const retry = nudge.maybeNudge(state, now + 2_000) ?? "";
  expect(retry).toContain('You closed d1 "Ship the ledger"');
  expect(nudge.nudgedHash).toBe(taskSetHash(["d1"]));
});

test("a closure during a run is asked after the run even without an earlier nudge", () => {
  const closed = closedTask("d1", "Ship the ledger", new Date(now - hour).toISOString());
  const nudge = new IdleNudge(1_000, now - 2 * hour, "");

  // The run ends after the closure and re-arms the nudge; the closure stays behind
  // the stable watermark instead of being lost with the activity timestamp.
  nudge.noteActivity(now);
  const text = nudge.maybeNudge({ ...nothing, tasks: [closed] }, now + 2_000) ?? "";

  expect(text).toContain('You closed d1 "Ship the ledger"');
});

test("a memory write after the closure drops the memory paragraph", () => {
  const open = { id: "o1", title: "New work", status: "open" as const, blockedBy: [] };
  const closed = closedTask("d1", "Ship the ledger", new Date(now - hour).toISOString());
  const tracker = new TaskActivityTracker(undefined, () => now);
  tracker.toolStarted("memory_write", { target: "daily", body: "the ledger closes cleanly" });

  const nudge = new IdleNudge(1_000, now - 2 * hour, "");
  const text =
    nudge.maybeNudge({ ...nothing, tasks: [open, closed], activity: tracker.view() }, now) ?? "";

  expect(text).toContain("open: o1");
  expect(text).not.toContain("You closed");
  expect(text).not.toContain("memory_write (long_term");
});

test("without a closure the memory paragraph never appears", () => {
  const open = { id: "o1", title: "New work", status: "open" as const, blockedBy: [] };
  const stale = workingTask("w1", "Still marked working");
  const nudge = new IdleNudge(1_000, now - 2 * hour, "");
  const text = nudge.maybeNudge({ ...nothing, tasks: [open, stale] }, now) ?? "";

  expect(text).toContain("open: o1");
  expect(text).toContain("Actualize these tasks");
  expect(text).not.toContain("You closed");
  expect(text).not.toContain("memory_write (long_term");
});
