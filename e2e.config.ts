import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

// Half the cores, never one, so a two-core runner still overlaps two files.
// `--workers` still overrides this on the command line.
export const workers = Math.max(2, Math.floor(availableParallelism() / 2));

// Every browser session gets its own app shard (see e2e/server.mjs). Two per
// worker leaves room for a context that is still closing while the next starts.
const appShards = Math.max(4, workers * 2);

// The image keeps its Playwright cache under /opt/playwright. Setting this here
// keeps a bare `npm run e2e` from trying to install into an unwritable HOME.
if (process.env.PLAYWRIGHT_BROWSERS_PATH === undefined && existsSync("/opt/playwright")) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = "/opt/playwright";
}

export default {
  tests: ["e2e/**/*.e2e.ts"],
  workers,
  // Four browser workers on a busy host can stretch a long UI test past the
  // 120s default; keep a bounded deadline without turning load into a failure.
  timeout: 180_000,
  targets: [
    {
      name: "web",
      // Headless CI does not need the continuously drifting shader in every
      // test; reduced motion still paints the background and keeps the suite
      // from burning a core per browser. The shader's normal-motion test opts
      // back in explicitly.
      engine: web({ browser: "chromium", reducedMotion: "reduce" }),
      app: {
        url: "http://127.0.0.1:0",
        command: {
          executable: process.execPath,
          args: ["--import", "tsx", "e2e/server.mjs"],
          env: { PORT: "{port}", PI_E2E_SHARDS: String(appShards) },
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
