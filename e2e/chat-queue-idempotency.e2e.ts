import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const root = fileURLToPath(new URL("..", import.meta.url));
const backendEntry = fileURLToPath(new URL("./backend.mjs", import.meta.url));

interface App {
  readonly url: string;
  readonly child: ChildProcess;
  readonly logs: () => string;
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

async function waitForHealth(url: string, app: App): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (app.child.exitCode !== null || app.child.signalCode !== null) {
      throw new Error(`app exited before it answered\n${app.logs()}`);
    }
    try {
      const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3_000) });
      if (response.ok) return;
    } catch {
      // The app is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`app did not answer within 120 seconds\n${app.logs()}`);
}

async function startApp(dataDir: string, agentDir: string): Promise<App> {
  const port = await freePort();
  const child = spawn(process.execPath, ["--import", "tsx", backendEntry], {
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
  let log = "";
  const append = (chunk: Buffer) => {
    log = `${log}${chunk.toString()}`.slice(-30_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const url = `http://127.0.0.1:${port}`;
  const app: App = {
    url,
    child,
    logs: () => log,
    stop: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    },
  };
  try {
    await waitForHealth(url, app);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  return app;
}

async function waitForFile(file: string, needle: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if (readFileSync(file, "utf8").includes(needle)) return;
    } catch {
      // The marker is not there yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${file} never contained ${needle}`);
}

test("a repeated client id and a restored marker never replay a delivered message", async ({
  app,
  browser,
  screen,
}) => {
  const tag = Date.now();
  const dataDir = mkdtempSync(join(tmpdir(), "pi-ui-queue-idempotency-data-"));
  const agentDir = mkdtempSync(join(tmpdir(), "pi-ui-queue-idempotency-agent-"));
  const release = join(tmpdir(), `pi-ui-queue-idempotency-${tag}`);
  const secondText = `queued exactly once ${tag}`;
  const queueKey = `queued-once-${tag}`;
  let first: App | undefined;
  let second: App | undefined;
  try {
    first = await startApp(dataDir, agentDir);
    await app.open(`${first.url}/`);
    await expect(screen.getByRole("button", { name: "Send" })).toBeVisible({ timeout: 30_000 });

    const wait = `for i in $(seq 600); do [ -e '${release}' ] && break; sleep 0.1; done; echo released`;
    const calls = [{ name: "bash", arguments: { command: wait } }];
    const composer = screen.getByRole("textbox", "Message");
    await composer.fill(`TOOLCALLS ${JSON.stringify(calls)}`);
    await screen.getByRole("button", { name: "Send" }).tap();
    await expect(screen.getByRole("button", { name: "Stop" })).toBeVisible({ timeout: 30_000 });

    const queued = await browser.evaluate(
      async ({ text, key }: { text: string; key: string }) => {
        const response = await fetch("/api/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, mode: "queue", queueKey: key }),
        });
        return (await response.json()) as {
          queued: boolean;
          placed: boolean;
          message: { id: string };
          queue: { id: string; key?: string }[];
        };
      },
      { text: secondText, key: queueKey },
    );
    expect(queued.queued).toBe(true);
    expect(queued.queue.some((item) => item.key === queueKey)).toBe(true);

    // Keep the pre-delivery marker: restoring it simulates a crash whose last write
    // still listed an item durable had already handed to the model.
    const markerPath = join(dataDir, "run.json");
    await waitForFile(markerPath, secondText);
    const staleMarker = readFileSync(markerPath, "utf8");

    writeFileSync(release, "");
    await expect(screen.getByText(`Echo: ${secondText}`, { exact: true })).toBeVisible({
      timeout: 30_000,
    });

    const counts = async () =>
      browser.evaluate(
        async ({ text }: { text: string }) => {
          const state = (await (await fetch("/api/state", { cache: "no-store" })).json()) as {
            messages: { role: string; text: string }[];
            queue: { text: string }[];
          };
          return {
            users: state.messages.filter(
              (message) => message.role === "user" && message.text.trim() === text,
            ).length,
            answers: state.messages.filter(
              (message) => message.role === "assistant" && message.text.includes(text),
            ).length,
            queued: state.queue.filter((item) => item.text === text).length,
          };
        },
        { text: secondText },
      );

    await expect.poll(counts).toEqual({ users: 1, answers: 1, queued: 0 });

    // The same client id is the same message, even after it was placed.
    const duplicate = await browser.evaluate(
      async ({ text, key }: { text: string; key: string }) => {
        const response = await fetch("/api/message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text, mode: "queue", queueKey: key }),
        });
        return (await response.json()) as { placed: boolean; message: { id: string } };
      },
      { text: secondText, key: queueKey },
    );
    expect(duplicate.placed).toBe(true);
    expect(duplicate.message.id).toBe(`m-${queueKey}`);
    await expect.poll(counts).toEqual({ users: 1, answers: 1, queued: 0 });

    await first.stop();
    first = undefined;
    writeFileSync(markerPath, staleMarker);

    second = await startApp(dataDir, agentDir);
    await app.open(`${second.url}/`);
    await expect(screen.getByText(secondText, { exact: true })).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect.poll(counts).toEqual({ users: 1, answers: 1, queued: 0 });
  } finally {
    await first?.stop();
    await second?.stop();
    rmSync(release, { force: true });
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  }
});
