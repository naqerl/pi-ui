import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_HCLOUD_TOKEN, startFakeModelServer } from "./fake-model.mjs";

const dataDir = process.env.PI_E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), "pi-ui-e2e-data-"));
const agentDir = mkdtempSync(join(tmpdir(), "pi-ui-e2e-agent-"));
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const live = process.env.PI_E2E_LIVE === "1";
const allMcpReachable = process.env.PI_E2E_MCP_ALL_REACHABLE === "1";
let fakeModel;
if (!live) {
  const { server, port } = await startFakeModelServer();
  fakeModel = server;
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify(
      {
        providers: {
          e2e: {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            api: "openai-completions",
            apiKey: "e2e",
            models: [
              {
                id: "e2e-model",
                name: "E2E Model",
                reasoning: false,
                input: ["text", "image"],
                // Large enough that the suite's shared conversation (history seeds
                // ~50 bulky turns) never triggers preflight compression mid-run.
                contextWindow: 1_048_576,
                maxTokens: 2048,
              },
              {
                id: "e2e-other",
                name: "E2E Other",
                reasoning: false,
                input: ["text"],
                contextWindow: 8192,
                maxTokens: 1024,
              },
            ],
          },
        },
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
          stub: {
            command: process.execPath,
            args: [join(import.meta.dirname, "stub-mcp.mjs")],
          },
          // Loopback port 1 is closed, so this HTTP server fails at boot while
          // the stdio stub above stays reachable.
          ...(allMcpReachable
            ? {}
            : { unreachable: { url: "http://127.0.0.1:1/mcp", requestTimeoutMs: 2000 } }),
        },
      },
      null,
      2,
    ),
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_MODEL = "e2e/e2e-model";
  process.env.PI_OFFLINE = "1";
  // Dashboard polls hit the fake Hetzner API on the fake model server, fast.
  process.env.HCLOUD_TOKEN = FAKE_HCLOUD_TOKEN;
  process.env.PI_DASHBOARD_MIN_INTERVAL_MS = "500";
  // A short quiet threshold, so the stalled-run watchdog and its strip run within a test.
  process.env.PI_UI_QUIET_AFTER_MS ??= "3000";
}

process.env.DATA_DIR = dataDir;
process.env.XDG_DATA_HOME = join(dataDir, "xdg-data");
process.env.XDG_STATE_HOME = join(dataDir, "xdg-state");
process.env.XDG_CONFIG_HOME = join(dataDir, "xdg-config");
mkdirSync(process.env.XDG_DATA_HOME, { recursive: true });
mkdirSync(process.env.XDG_STATE_HOME, { recursive: true });
mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });

const close = () => {
  fakeModel?.close();
};
process.on("SIGTERM", close);
process.on("SIGINT", close);

await import("../dist/server/index.js");
