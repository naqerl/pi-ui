#!/usr/bin/env node
// Fails the first launch (the boot probe) and serves the stub afterwards, so a
// later events-protocol connection proves the server is reachable again.
import { existsSync, writeFileSync } from "node:fs";

const marker = process.env.RECOVERING_MCP_MARKER;
if (marker === undefined || marker.length === 0) {
  process.stderr.write("RECOVERING_MCP_MARKER is required\n");
  process.exit(1);
}
if (!existsSync(marker)) {
  writeFileSync(marker, "1");
  process.exit(1);
}

await import("./stub-mcp.mjs");
