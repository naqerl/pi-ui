#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const unregister = register({ tsconfig: resolve(root, "tsconfig.json") });

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function usage() {
  console.error(
    "usage: node scripts/try-tool.mjs <web tool> [json arguments] [--kill-child]\n" +
      '  example: node scripts/try-tool.mjs web_search \'{"query":"pi coding agent","provider":"duckduckgo"}\'',
  );
}

async function main() {
  const args = process.argv.slice(2);
  const killChild = args.includes("--kill-child");
  const positional = args.filter((arg) => arg !== "--kill-child");
  const requested = positional[0];
  if (!requested) {
    usage();
    process.exitCode = 1;
    return;
  }

  let toolArguments = {};
  if (positional[1] !== undefined) {
    try {
      const parsed = JSON.parse(positional[1]);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("tool arguments must be a JSON object");
      }
      toolArguments = parsed;
    } catch (error) {
      console.error(`invalid JSON arguments: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 1;
      return;
    }
  }

  const { createAppRegistry } = await import(
    new URL("../src/server/app-registry.ts", import.meta.url).href
  );
  const { registry, webTools } = await createAppRegistry();
  if (webTools === undefined) {
    console.error("web tools are unavailable");
    process.exitCode = 1;
    return;
  }

  const name = requested.startsWith("mcp__web__") ? requested : `mcp__web__${requested}`;
  const entry = registry
    .snapshot()
    .tools()
    .find((candidate) => candidate.tool.name === name);
  if (entry === undefined) {
    console.error(`unknown tool: ${name}`);
    process.exitCode = 1;
    return;
  }

  try {
    if (killChild) {
      const pid = webTools.pid;
      if (pid === undefined) throw new Error("the web MCP child has no process ID");
      process.kill(pid, "SIGKILL");
      const deadline = Date.now() + 5_000;
      while (webTools.connected && Date.now() < deadline) await sleep(25);
      if (webTools.connected) throw new Error("the web MCP child did not exit");
    }

    const result = await entry.tool.execute(toolArguments, {}, {});
    console.log(JSON.stringify({ tool: name, result }, null, 2));

    if (killChild) {
      const text = Array.isArray(result.output)
        ? result.output
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n")
        : "";
      if (result.isError !== true || !text.includes("web tools are starting")) {
        console.error("expected a graceful 'web tools are starting' error result");
        process.exitCode = 1;
      }
    }
  } finally {
    await webTools.close();
  }
}

try {
  await main();
} finally {
  await unregister();
}
