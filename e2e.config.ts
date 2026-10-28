import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

export default {
  tests: ["e2e/**/*.e2e.ts"],
  workers: 1,
  targets: [
    {
      name: "web",
      engine: web({ browser: "chromium" }),
      app: {
        url: "http://127.0.0.1:0",
        command: {
          executable: process.execPath,
          args: ["e2e/server.mjs"],
          env: { PORT: "{port}" },
          inheritEnv: [
            "PI_E2E_LIVE",
            "PI_MODEL",
            "PI_PROVIDER",
            "PI_CODING_AGENT_DIR",
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
