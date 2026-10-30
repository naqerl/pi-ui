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
