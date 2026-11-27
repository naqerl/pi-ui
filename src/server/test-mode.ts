import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";

export function isUnderTempDir(path: string, tempRoot = tmpdir()): boolean {
  const relativePath = relative(resolve(tempRoot), resolve(path));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

export function liveDataDirInTestError(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (env.NODE_ENV !== "test") return null;
  const resolved = resolve(dataDir);
  if (isUnderTempDir(resolved)) return null;
  return `refusing to start in test mode with a non-temporary data directory: ${resolved}`;
}
