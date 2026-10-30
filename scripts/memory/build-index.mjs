#!/usr/bin/env node
// Regenerate the map section of MEMORY.md from topics/. Idempotent: everything
// outside <!-- MAP:BEGIN --> … <!-- MAP:END --> is preserved.
// Usage: node build-index.mjs [--apply]
import fs from "node:fs";
import path from "node:path";

const MEM = (() => {
  const eq = process.argv.find((a) => a.startsWith("--memory="));
  const dir = eq
    ? eq.slice(9)
    : process.env.PI_MEMORY_DIR || path.join(process.env.HOME || "/tmp", ".pi/agent/memory");
  return path.resolve(dir);
})();
const APPLY = process.argv.includes("--apply");
const BEGIN = "<!-- MAP:BEGIN -->";
const END = "<!-- MAP:END -->";
const file = path.join(MEM, "MEMORY.md");

const PROTOCOL = `## How this file works

Only this file is injected each turn (4 KB budget, middle-truncated) — a **map, not a store**.

- Bodies: \`topics/<scope>/<topic>.md\`, one \`INDEX.md\` per scope. Search with
  \`node ~/.pi/agent/memory/find.mjs "terms"\` (TF-IDF + recency, access counts in \`.usage.json\`).
- New durable fact → append to its topic file, not here. Changed standing rule → edit the section
  above. New area → add a topic file and re-run \`node /workspace/memory-tools/build-index.mjs --apply\`.
- Consolidation protocol (the dream pass), triggers and do-nots: \`topics/harness/memory-system.md\`.`;

function mapSection() {
  const dir = path.join(MEM, "topics");
  if (!fs.existsSync(dir))
    return `${BEGIN}\n## Memory map\n\n(no topics yet — run split.mjs)\n${END}`;
  const scopes = fs
    .readdirSync(dir)
    .filter((n) => fs.statSync(path.join(dir, n)).isDirectory())
    .sort();
  const lines = [`## Memory map`, ""];
  let _total = 0;
  const _summary = [];
  for (const scope of scopes) {
    const idxPath = path.join(dir, scope, "INDEX.md");
    if (!fs.existsSync(idxPath)) continue;
    const idx = fs.readFileSync(idxPath, "utf8").split("\n");
    const entries = idx.filter((l) => l.startsWith("- ["));
    _total += entries.length;
    const desc = (idx[0] || "").replace(/^#\s*/, "").replace(/^\S+\s+—\s+/, "");
    lines.push(
      `- **${scope}** (${entries.length}) — ${desc.replace(/\s*\(\d+ topics\)$/, "")} → \`topics/${scope}/INDEX.md\``,
    );
  }
  lines.push("");
  return `${BEGIN}\n${lines.join("\n")}\n${END}`;
}

let text = fs.readFileSync(file, "utf8");
const map = mapSection();
if (text.includes(BEGIN) && text.includes(END)) {
  text = text.replace(new RegExp(`${BEGIN}[\\s\\S]*?${END}`), map);
} else {
  // first run: keep the title and the Standing rules section, then protocol + map
  const cut = text.indexOf("## ", text.indexOf("# MEMORY.md"));
  const second = text.indexOf("\n## ", cut + 1);
  const head = second > 0 ? text.slice(0, second) : text.slice(0, cut);
  text = `${head.trimEnd()}\n\n${PROTOCOL}\n\n${map}\n`;
}
const size = Buffer.byteLength(text);
console.log(`MEMORY.md → ${size} chars (budget 4000, middle-truncated)`);
if (size > 4000)
  console.log(`WARNING: over budget by ${size - 4000} chars — trim the map or the rules`);
if (!APPLY) {
  console.log("(dry run — pass --apply)");
  console.log(`${text.slice(0, 1200)}\n…`);
  process.exit(0);
}
fs.writeFileSync(file, text);
console.log("written");
