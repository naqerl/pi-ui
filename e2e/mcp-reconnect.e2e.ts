import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { startMcpRuntime } from "../src/server/mcp-runtime.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixtureEntry = fileURLToPath(new URL("./session-drop-mcp.mjs", import.meta.url));

type FixtureMode =
  | "drop-once"
  | "invalid-request"
  | "grow"
  | "down"
  | "method-not-found"
  | "unauthorized";

interface Fixture {
  readonly url: string;
  readonly statePath: string;
  readonly controlPath: string;
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

function lines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function startFixture(mode: FixtureMode): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "pi-ui-session-drop-"));
  const statePath = join(dir, "state.log");
  const controlPath = join(dir, "control");
  const port = await freePort();
  const child: ChildProcess = spawn(process.execPath, [fixtureEntry], {
    cwd: root,
    env: {
      ...process.env,
      SESSION_DROP_MODE: mode,
      SESSION_DROP_STATE: statePath,
      SESSION_DROP_CONTROL: controlPath,
      SESSION_DROP_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const append = (chunk: Buffer) => {
    output = `${output}${chunk.toString()}`.slice(-20_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);

  await expect
    .poll(() => lines(statePath).includes("listening"), {
      timeout: 20_000,
      message: `session-drop fixture did not listen\n${output}`,
    })
    .toBe(true);

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    statePath,
    controlPath,
    stop: async () => {
      if (child.exitCode === null) {
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        child.kill("SIGTERM");
        await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function writeConfig(url: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-ui-session-drop-agent-"));
  writeFileSync(
    join(dir, "mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          tracer: { url, requestTimeoutMs: 5_000 },
          web: { command: process.execPath, disabled: true },
        },
      },
      null,
      2,
    ),
  );
  return dir;
}

async function startRuntime(fixture: Fixture, messages: string[]) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = writeConfig(fixture.url);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const runtime = await startMcpRuntime({ submit: (text) => messages.push(text) });
    return {
      runtime,
      stop: async () => {
        await runtime.close();
        rmSync(agentDir, { recursive: true, force: true });
        if (previous === undefined) {
          delete process.env.PI_CODING_AGENT_DIR;
        } else {
          process.env.PI_CODING_AGENT_DIR = previous;
        }
      },
    };
  } catch (error) {
    rmSync(agentDir, { recursive: true, force: true });
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previous;
    }
    throw error;
  }
}

function execute(
  runtime: Awaited<ReturnType<typeof startMcpRuntime>>,
  name: string,
  args: Record<string, unknown>,
) {
  return runtime.shim.callTool(name, args);
}

test("a forgotten session is re-initialized and the call is retried exactly once", async () => {
  const fixture = await startFixture("drop-once");
  const messages: string[] = [];
  const started = await startRuntime(fixture, messages);
  try {
    expect(started.runtime.toolNames).toContain("tracer__echo");
    const result = await execute(started.runtime, "tracer__echo", { text: "hello" });
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result.content)).toMatch(/echo: hello/);

    await expect
      .poll(() => lines(fixture.statePath).filter((line) => line === "initialize").length, {
        timeout: 15_000,
      })
      .toBe(2);
    expect(lines(fixture.statePath).filter((line) => line === "drop")).toHaveLength(1);

    const recovery = messages.filter((text) =>
      /session lost \(http404\), re-initialized, tool list refreshed/.test(text),
    );
    expect(recovery).toHaveLength(1);
    expect(messages.filter((text) => /retry failed|re-initialize failed/.test(text))).toHaveLength(
      0,
    );

    const status = started.runtime.status.servers.find((server) => server.name === "tracer");
    expect(status?.available).toBe(true);
    expect(status?.tools).toContain("tracer__echo");
    expect(started.runtime.failedServers.some((failure) => failure.name === "tracer")).toBe(false);
  } finally {
    await started.stop();
    await fixture.stop();
  }
});

test("concurrent calls share one bounded recovery instead of failing a parallel call", async () => {
  const fixture = await startFixture("drop-once");
  const messages: string[] = [];
  const started = await startRuntime(fixture, messages);
  try {
    const [first, second] = await Promise.all([
      execute(started.runtime, "tracer__echo", { text: "a" }),
      execute(started.runtime, "tracer__echo", { text: "b" }),
    ]);
    expect(first.isError).toBeUndefined();
    expect(second.isError).toBeUndefined();
    expect(JSON.stringify(first.content)).toMatch(/echo: a/);
    expect(JSON.stringify(second.content)).toMatch(/echo: b/);

    await expect
      .poll(() => lines(fixture.statePath).filter((line) => line === "initialize").length, {
        timeout: 15_000,
      })
      .toBe(2);
    expect(lines(fixture.statePath).filter((line) => line === "drop")).toHaveLength(1);
    expect(lines(fixture.statePath).filter((line) => line === "call")).toHaveLength(2);
    expect(
      messages.filter((text) =>
        /session lost \(http404\), re-initialized, tool list refreshed/.test(text),
      ),
    ).toHaveLength(1);
    expect(messages.filter((text) => /retry failed|re-initialize failed/.test(text))).toHaveLength(
      0,
    );
    expect(
      started.runtime.status.servers.find((server) => server.name === "tracer")?.available,
    ).toBe(true);
  } finally {
    await started.stop();
    await fixture.stop();
  }
});

test("a JSON-RPC -32600 invalid session is recovered as jsonrpc-32600", async () => {
  const fixture = await startFixture("invalid-request");
  const messages: string[] = [];
  const started = await startRuntime(fixture, messages);
  try {
    const result = await execute(started.runtime, "tracer__echo", { text: "again" });
    expect(result.isError).toBeUndefined();
    expect(JSON.stringify(result.content)).toMatch(/echo: again/);

    await expect
      .poll(() => lines(fixture.statePath).filter((line) => line === "initialize").length, {
        timeout: 15_000,
      })
      .toBe(2);
    expect(lines(fixture.statePath).filter((line) => line === "invalid")).toHaveLength(1);
    expect(
      messages.filter((text) =>
        /session lost \(jsonrpc-32600\), re-initialized, tool list refreshed/.test(text),
      ),
    ).toHaveLength(1);
    expect(messages.filter((text) => /retry failed|re-initialize failed/.test(text))).toHaveLength(
      0,
    );
    expect(
      started.runtime.status.servers.find((server) => server.name === "tracer")?.available,
    ).toBe(true);
  } finally {
    await started.stop();
    await fixture.stop();
  }
});

test("a tool added to tools/list becomes callable without a restart", async () => {
  const fixture = await startFixture("grow");
  const messages: string[] = [];
  const started = await startRuntime(fixture, messages);
  try {
    const first = await execute(started.runtime, "tracer__echo", { text: "one" });
    expect(JSON.stringify(first.content)).toMatch(/echo: one/);

    await expect
      .poll(() => started.runtime.toolNames.includes("tracer__added"), { timeout: 20_000 })
      .toBe(true);
    const added = await execute(started.runtime, "tracer__added", {});
    expect(added.isError).toBeUndefined();
    expect(JSON.stringify(added.content)).toMatch(/added: ok/);
    expect(
      started.runtime.status.servers
        .find((server) => server.name === "tracer")
        ?.tools.includes("tracer__added"),
    ).toBe(true);
  } finally {
    await started.stop();
    await fixture.stop();
  }
});

test("a server that is down at boot appears after the backoff retries, without a storm", async () => {
  const fixture = await startFixture("down");
  const messages: string[] = [];
  const started = await startRuntime(fixture, messages);
  try {
    expect(started.runtime.failedServers.some((failure) => failure.name === "tracer")).toBe(true);
    expect(started.runtime.toolNames).not.toContain("tracer__echo");

    await expect
      .poll(() => lines(fixture.statePath).filter((line) => line === "attempt").length >= 2, {
        timeout: 20_000,
      })
      .toBe(true);
    writeFileSync(fixture.controlPath, "up");

    await expect
      .poll(() => started.runtime.toolNames.includes("tracer__echo"), { timeout: 30_000 })
      .toBe(true);
    const result = await execute(started.runtime, "tracer__echo", { text: "back" });
    expect(JSON.stringify(result.content)).toMatch(/echo: back/);
    expect(
      started.runtime.status.servers.find((server) => server.name === "tracer")?.available,
    ).toBe(true);

    // The 1s/5s/15s/60s/capped-5min schedule bounds how many attempts fit in
    // this window; a retry storm would be far above this.
    expect(
      lines(fixture.statePath).filter((line) => line === "attempt").length,
    ).toBeLessThanOrEqual(5);
    expect(messages.some((text) => /re-initialized, tool list refreshed/.test(text))).toBe(true);
  } finally {
    await started.stop();
    await fixture.stop();
  }
});

test("method-not-found is a real failure, never a session recovery", async () => {
  const fixture = await startFixture("method-not-found");
  const messages: string[] = [];
  const started = await startRuntime(fixture, messages);
  try {
    const result = await execute(started.runtime, "tracer__echo", { text: "nope" });
    expect(JSON.stringify(result.content)).toMatch(/-32601|JSON-RPC code/);
    expect(result.isError).toBeUndefined();

    await expect
      .poll(() => lines(fixture.statePath).filter((line) => line === "initialize").length, {
        timeout: 10_000,
      })
      .toBe(1);
    expect(lines(fixture.statePath).filter((line) => line === "call")).toHaveLength(1);
    expect(messages.filter((text) => /session lost|re-initialized/.test(text))).toHaveLength(0);
    expect(
      started.runtime.status.servers.find((server) => server.name === "tracer")?.available,
    ).toBe(true);
  } finally {
    await started.stop();
    await fixture.stop();
  }
});

test("401 keeps the exact credentials wording and is not retried", async () => {
  const fixture = await startFixture("unauthorized");
  const messages: string[] = [];
  const started = await startRuntime(fixture, messages);
  try {
    const result = await execute(started.runtime, "tracer__echo", { text: "secret" });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: "server tracer rejected the configured credentials" },
    ]);

    await expect
      .poll(() => lines(fixture.statePath).filter((line) => line === "initialize").length, {
        timeout: 10_000,
      })
      .toBe(1);
    expect(lines(fixture.statePath).filter((line) => line === "unauthorized")).toHaveLength(1);
    expect(messages.filter((text) => /session lost|re-initialized/.test(text))).toHaveLength(0);
  } finally {
    await started.stop();
    await fixture.stop();
  }
});
