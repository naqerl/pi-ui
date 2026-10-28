#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const unregister = register({ tsconfig: resolve(root, "tsconfig.json") });

function usage() {
  console.error(
    "usage: node scripts/try-tool.mjs <tool> [json arguments]\n" +
      '  example: node scripts/try-tool.mjs web_search \'{"query":"pi coding agent","provider":"duckduckgo"}\'\n' +
      "  tool names are <server>__<tool> (or a bare web tool for the built-in web server)",
  );
}

async function main() {
  const args = process.argv.slice(2);
  const requested = args[0];
  if (!requested) {
    usage();
    process.exitCode = 1;
    return;
  }

  let toolArguments = {};
  if (args[1] !== undefined) {
    try {
      const parsed = JSON.parse(args[1]);
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

  const { mcp } = await import(new URL("../src/server/app-registry.ts", import.meta.url).href).then(
    (module) => module.createAppRegistry(),
  );
  try {
    const name = requested.includes("__") ? requested : `web__${requested}`;
    const tool = mcp.tools.find((candidate) => candidate.name === name);
    if (tool === undefined) {
      console.error(`unknown tool: ${name}`);
      console.error(`available: ${mcp.toolNames.join(", ")}`);
      process.exitCode = 1;
      return;
    }

    const result = await tool.execute(
      toolArguments,
      { callId: "try-tool" },
      { abortSignal: new AbortController().signal },
    );
    console.log(JSON.stringify({ tool: name, result }, null, 2));
  } finally {
    await mcp.close();
  }
}

try {
  await main();
} finally {
  await unregister();
}
