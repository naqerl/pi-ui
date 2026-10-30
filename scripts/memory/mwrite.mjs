#!/usr/bin/env node
// Write a topic body safely: node mwrite.mjs topics/<scope>/<file>.md < newbody
// Keeps the front matter, stamps `updated`, writes tmp+rename (no half-written topic),
// then refreshes that scope's INDEX.md line for the topic.
import fs from "node:fs";
import path from "node:path";

const MEM = (() => {
  const eq = process.argv.find((a) => a.startsWith("--memory="));
  const dir = eq
    ? eq.slice(9)
    : process.env.PI_MEMORY_DIR || path.join(process.env.HOME || "/tmp", ".pi/agent/memory");
  return path.resolve(dir);
})();
const rel = process.argv[2];
if (!rel) {
  console.error("usage: node mwrite.mjs topics/<scope>/<file>.md  (body on stdin)");
  process.exit(2);
}
const file = path.isAbsolute(rel) ? rel : path.join(MEM, rel);
if (!fs.existsSync(file)) {
  console.error(`no such topic: ${file}`);
  process.exit(1);
}

const body = fs.readFileSync(0, "utf8").trim();
if (!body) {
  console.error("empty body — refusing to blank a topic");
  process.exit(1);
}

const old = fs.readFileSync(file, "utf8");
const fmRaw = (old.match(/^---\n([\s\S]*?)\n---\n/) || ["", ""])[1];
const fm = new Map(
  fmRaw
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf(":");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
    }),
);
fm.set("updated", new Date().toISOString().slice(0, 10));
if (!fm.has("topic")) fm.set("topic", JSON.stringify(path.basename(file, ".md")));
if (!fm.has("scope")) fm.set("scope", path.basename(path.dirname(file)));
// the first markdown heading of the new body is the authoritative title
const headingTitle = body.split("\n").find((l) => /^#{1,3} /.test(l));
if (headingTitle) fm.set("topic", JSON.stringify(headingTitle.replace(/^#{1,3} /, "").trim()));
const front = `---\n${[...fm].map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n`;

const tmp = `${file}.tmp-${process.pid}`;
fs.writeFileSync(tmp, `${front}\n${body}\n`);
fs.renameSync(tmp, file);

// keep the scope index in step
const scope = path.basename(path.dirname(file));
const idxFile = path.join(MEM, "topics", scope, "INDEX.md");
const name = path.basename(file);
const firstLine =
  body.split("\n").find((l) => l.trim() && !l.startsWith("#")) || body.split("\n")[0];
const desc = firstLine.replace(/[*`#]/g, "").trim().slice(0, 110);
if (fs.existsSync(idxFile)) {
  const line = `- [${fm.get("topic")?.replace(/^"|"$/g, "")}](${name}) — ${desc}`;
  const idx = fs.readFileSync(idxFile, "utf8").split("\n");
  const at = idx.findIndex((l) => l.includes(`](${name})`));
  if (at >= 0) idx[at] = line;
  else idx.push(line);
  fs.writeFileSync(idxFile, idx.join("\n"));
}
console.log(`wrote ${rel} (${body.length} chars, updated ${fm.get("updated")})`);
