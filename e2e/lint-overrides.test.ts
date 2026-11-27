import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

function runGuard(): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveExit, rejectExit) => {
    const child = spawn(process.execPath, ["scripts/check-lint-overrides.mjs"], {
      cwd: root,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", rejectExit);
    child.on("close", (code) => resolveExit({ code, output }));
  });
}

test("the override baseline records every diagnostic the overrides hide", async () => {
  const result = await runGuard();
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Lint overrides hide no unreviewed diagnostics\./);
});
