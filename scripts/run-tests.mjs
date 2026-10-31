import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Unit tests all live here; the glob is expanded by Node's test runner. */
export const TEST_FILE_GLOB = "e2e/*.test.ts";

/** Every path a test process may write to, mapped to its directory under the run root. */
const ISOLATED_ENV_PATHS = {
  DATA_DIR: "data",
  PI_MEMORY_DIR: "memory",
  XDG_DATA_HOME: "xdg-data",
  XDG_STATE_HOME: "xdg-state",
  XDG_CONFIG_HOME: "xdg-config",
};

/**
 * Builds the environment for one test process. The live `DATA_DIR` and the
 * user's XDG directories are overridden so no in-process module can resolve
 * its state into the real data directory.
 */
export function computeTestEnv(root, baseEnv = process.env) {
  const env = { ...baseEnv, NODE_ENV: "test" };
  for (const [key, dir] of Object.entries(ISOLATED_ENV_PATHS)) {
    env[key] = join(root, dir);
  }
  return env;
}

/** Creates the isolated directories so a test process never races on mkdir. */
async function prepareRoot(root, env) {
  await mkdir(root, { recursive: true });
  await Promise.all(
    Object.keys(ISOLATED_ENV_PATHS).map((key) => mkdir(env[key], { recursive: true })),
  );
}

function runTests(env) {
  return new Promise((resolveExit) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--test", ...process.argv.slice(2), TEST_FILE_GLOB],
      { env, stdio: "inherit" },
    );
    child.on("error", (error) => {
      console.error(`run-tests: could not start the test runner: ${String(error)}`);
      resolveExit(1);
    });
    child.on("exit", (code, signal) => {
      resolveExit(signal === null ? (code ?? 1) : 1);
    });
  });
}

async function main() {
  const explicitTemp = process.env.PI_E2E_KEEP_DATA === "1";
  const root = await mkdtemp(join(resolve(tmpdir()), "pi-ui-tests-"));
  let exitCode = 1;
  try {
    const env = computeTestEnv(root);
    await prepareRoot(root, env);
    exitCode = await runTests(env);
    if (explicitTemp) console.error(`run-tests: kept isolated test data in ${root}`);
  } finally {
    if (!explicitTemp) await rm(root, { recursive: true, force: true });
  }
  process.exitCode = exitCode;
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) await main();
