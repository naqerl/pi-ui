import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeModelServer } from "./fake-model.mjs";

const dataDir = mkdtempSync(join(tmpdir(), "pi-ui-e2e-data-"));
const agentDir = mkdtempSync(join(tmpdir(), "pi-ui-e2e-agent-"));
mkdirSync(dataDir, { recursive: true });
mkdirSync(agentDir, { recursive: true });

const live = process.env.PI_E2E_LIVE === "1";
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
                input: ["text"],
                contextWindow: 32768,
                maxTokens: 2048,
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
          broken: {
            command: process.execPath,
            args: ["-e", "process.exit(1)"],
          },
        },
      },
      null,
      2,
    ),
  );
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_MODEL = "e2e/e2e-model";
  process.env.PI_OFFLINE = "1";
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
