import { existsSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

// Leave one core for the proxy and backend shards. Two files still overlap on
// a two-core runner, while a four-core host does not starve the browser during
// another suite's run. `--workers` still overrides this on the command line.
export const workers = Math.max(2, Math.min(8, availableParallelism() - 1));

// Every worker gets its own initial app shard (see e2e/server.mjs); the server
// grows the pool for a closing context but keeps that growth tightly bounded.
const appShards = Math.max(4, workers);

// The image keeps its Playwright cache under /opt/playwright. Setting this here
// keeps a bare `npm run e2e` from trying to install into an unwritable HOME.
if (process.env.PLAYWRIGHT_BROWSERS_PATH === undefined && existsSync("/opt/playwright")) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = "/opt/playwright";
}

export default {
  // This glob already selects the 28-file core, so no allowlist is needed. A new `*.e2e.ts`
  // is a budget decision: the suite has a 420 s guard and a new spec must displace one.
  tests: ["e2e/**/*.e2e.ts"],
  workers,
  // A busy host can stretch a long UI test past the 120s default; keep a
  // bounded deadline without turning another suite's load into a failure.
  timeout: 300_000,
  targets: [
    {
      name: "web",
      // Headless CI does not need the continuously drifting shader in every
      // test; reduced motion still paints the background and keeps the suite
      // from burning a core per browser.
      engine: web({ browser: "chromium", reducedMotion: "reduce" }),
      app: {
        url: "http://127.0.0.1:0",
        command: {
          executable: process.execPath,
          args: ["--import", "tsx", "e2e/server.mjs"],
          env: {
            PORT: "{port}",
            PI_E2E_SHARDS: String(appShards),
            // A writable HOME lets theme tests install real color files without
            // touching the runner's read-only home directory.
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
