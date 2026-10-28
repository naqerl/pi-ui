import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";

const check = fileURLToPath(new URL("./mcp-check.mjs", import.meta.url));

function runCheck(): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ["--import", "tsx", check], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", rejectRun);
    child.on("close", (code) => resolveRun({ code, output }));
  });
}

test("bridges a stub MCP server, survives a broken one, and relays events", async () => {
  const result = await runCheck();
  expect(result.output).not.toMatch(/super-secret-token-9f3c/);
  expect(result.code).toBe(0);
});
