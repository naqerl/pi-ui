import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

export const workers = Math.max(2, Math.min(8, availableParallelism() - 1));

const appShards = Math.max(4, workers);

if (process.env.PLAYWRIGHT_BROWSERS_PATH === undefined && existsSync("/opt/playwright")) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = "/opt/playwright";
}

export default {
  tests: ["e2e/**/*.e2e.ts"],
  workers,
  timeout: 300_000,
  targets: [
    {
      name: "web",
      engine: web({ browser: "chromium", reducedMotion: "reduce" }),
      app: {
        url: "http://127.0.0.1:0",
        command: {
          executable: process.execPath,
          args: ["--import", "tsx", "e2e/server.mjs"],
          env: {
            PORT: "{port}",
            PI_E2E_SHARDS: String(appShards),
            HOME: join(process.cwd(), ".e2e/home"),
          },
          inheritEnv: [
            "PI_E2E_LIVE",
            "PI_MODEL",
            "PI_PROVIDER",
            "PI_CODING_AGENT_DIR",
            "PI_MCP_*",
            "OPENAI_*",
            "ANTHROPIC_*",
            "GOOGLE_*",
          ],
          startupTimeout: 120_000,
        },
      },
    },
  ],
} satisfies E2EConfig;
