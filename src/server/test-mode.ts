import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

/** True when `path` is the temp root itself or lives below it. */
export function isUnderTempDir(path: string, tempRoot = tmpdir()): boolean {
  const relativePath = relative(resolve(tempRoot), resolve(path));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

/**
 * A test-mode server must never touch the live data directory. Returns the
 * one-line refusal for a live path, or null when the directory is isolated.
 */
export function liveDataDirInTestError(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.NODE_ENV !== "test") return null;
  const resolved = resolve(dataDir);
  if (isUnderTempDir(resolved)) return null;
  return `refusing to start in test mode with a non-temporary data directory: ${resolved}`;
}
