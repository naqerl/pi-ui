import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAKE_HCLOUD_TOKEN, startFakeModelServer } from "./fake-model.mjs";

const dataDir = process.env.PI_E2E_DATA_DIR ?? mkdtempSync(join(tmpdir(), "pi-ui-e2e-data-"));
const suppliedAgentDir = process.env.PI_E2E_AGENT_DIR;
const agentDir = suppliedAgentDir ?? mkdtempSync(join(tmpdir(), "pi-ui-e2e-agent-"));
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

                cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },

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
  if (suppliedAgentDir === undefined) {
    writeFileSync(
      join(agentDir, "mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            stub: {
              command: process.execPath,
              args: [join(import.meta.dirname, "stub-mcp.mjs")],
            },

            ...(allMcpReachable
              ? {}
              : { unreachable: { url: "http://127.0.0.1:1/mcp", requestTimeoutMs: 2000 } }),
          },
        },
        null,
        2,
      ),
    );
  }
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_MODEL = "e2e/e2e-model";
  process.env.PI_OFFLINE = "1";

  process.env.HCLOUD_TOKEN = FAKE_HCLOUD_TOKEN;
  process.env.PI_DASHBOARD_MIN_INTERVAL_MS = "500";

  process.env.PI_UI_QUIET_AFTER_MS ??= "3000";

  process.env.PI_RETRY_BASE_MS ??= "50";
  process.env.PI_RETRY_MAX_DELAY_MS ??= "100";
  process.env.PI_RETRY_BUDGET_MS ??= "1000";
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
