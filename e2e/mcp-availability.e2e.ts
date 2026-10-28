import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import type { Snapshot } from "../src/shared/types";

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

    const notice = screen.getByTestId("mcp-unavailable");
    await expect(notice).toBeVisible();
    await expect(notice).toHaveText("unreachable unavailable");

    const shape = await browser.evaluate(() => {
      const element = document.querySelector('[data-testid="mcp-unavailable"]');
      const header = document.querySelector("header");
      if (element === null || header === null) return null;
      return {
        insideHeader: header.contains(element),
        height: element.getBoundingClientRect().height,
        lines: element.getClientRects().length,
      };
    });
    expect(shape).not.toBeNull();
    expect(shape?.insideHeader).toBe(true);
    expect(shape?.height ?? 0).toBeLessThanOrEqual(18);
    expect(shape?.lines).toBe(1);

    await app.screenshot("mcp-unavailable-notice");
  } finally {
    await spawned.stop();
  }
});

test("omits the notice when every configured MCP server is reachable", async ({ app, screen }) => {
  const spawned = await startApp(true);
  try {
    await app.open(`${spawned.url}/`);
    const state = await readState(spawned.url);

    expect(state.mcp.unavailable).toEqual([]);
    const stub = state.mcp.servers.find((server) => server.name === "stub");
    expect(stub?.available).toBe(true);
    expect(stub?.tools).toContain("stub__echo");
    await expect(screen.getByTestId("mcp-unavailable")).toHaveCount(0);
  } finally {
    await spawned.stop();
  }
});
