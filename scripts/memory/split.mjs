#!/usr/bin/env node
// Split MEMORY.md into a two-level index: MEMORY.md (rules + map) and
// topics/<scope>/<topic>.md bodies with a per-scope INDEX.md.
// Usage: node split.mjs [--apply]
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
const raw = fs.readFileSync(path.join(MEM, "MEMORY.md"), "utf8");

// --- parse ---------------------------------------------------------------
const marks = [];
const re = /^## (.+)$/gm;
let _m;
for (let m = re.exec(raw); m !== null; m = re.exec(raw))
  marks.push({ title: m[1].trim(), start: m.index });
const _preamble = marks.length ? raw.slice(0, marks[0].start) : raw;
const sections = marks.map((mk, i) => {
  const end = i + 1 < marks.length ? marks[i + 1].start : raw.length;
  const body = `${raw.slice(mk.start, end).replace(/\s+$/, "")}\n`;
  return { title: mk.title, body, letters: body.replace(/^## .+$/m, "").trim() };
});

// --- scope assignment (ordered, first match wins) ------------------------
const DEFAULT_RULES = [
  ["core", /^(Standing rules|Who the user is|Operating role|Rules that always apply)\b/i],
  ["harness", /^Pi\b|pi MCP|qmd|^Skills$|skill discovery/i],
  [
    "forge",
    /Git forge|Gitea|GitHub|Forgejo|gh (CLI|pr)|Authorship|^Never merge|stacked PR|delivery lane/i,
  ],
  ["machines", /^(Machine:|Where the code lives)(?=[\s:—]|$)/i],
  ["prefs", /^Contact note|preference|^Working style|End-of-turn|tmux status bar/i],
];
// scopes.json in the memory dir wins: [[scope, "regex"], …] — same shape, ordered, first match wins.
const SCOPES_FILE = path.join(MEM, "scopes.json");
const RULES = fs.existsSync(SCOPES_FILE)
  ? JSON.parse(fs.readFileSync(SCOPES_FILE, "utf8")).map(([scope, pattern]) => [
      scope,
      new RegExp(pattern, "i"),
    ])
  : DEFAULT_RULES;
const slug = (s) =>
  s
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 58) || "topic";
const scopeOf = (title) => {
  for (const [scope, rx] of RULES) if (rx.test(title)) return scope;
  return "misc";
};
const DESCRIPTION = {
  core: "who the user is, how to work",
  machines: "operator infrastructure",
  storefront: "project",
  zeroshot: "project",
  projects: "project",
  forge: "delivery lanes",
  gateway: "project",
  harness: "pi harness",
  prefs: "operator preferences",
  misc: "unclassified",
};
const MAX = 8000;

// --- bucket --------------------------------------------------------------
const buckets = new Map();
for (const s of sections) {
  const scope = scopeOf(s.title);
  if (scope === "core" && /^Standing rules/.test(s.title)) continue; // stays inline
  if (!buckets.has(scope)) buckets.set(scope, []);
  buckets.get(scope).push({ ...s, scope });
}

// oversized topics: split on headings, then on paragraphs, so no body is a blob
function carve(t) {
  if (t.body.length <= MAX) return [{ ...t, file: `${slug(t.title)}.md` }];
  let parts = t.body.split(/^(?=#{1,3} )/m);
  if (parts.length < 2) parts = [t.body];
  const out = [];
  for (const part of parts) {
    const head = (part.match(/^#{1,3} (.+)$/m) || [])[1];
    const title = head && parts.length > 1 ? `${t.title} — ${head}` : t.title;
    if (part.length <= MAX) {
      out.push({ ...t, title, body: part, letters: part });
      continue;
    }
    const paras = part.split(/\n\s*\n/);
    let buf = "";
    for (const p of paras) {
      if (buf.length + p.length > MAX && buf) {
        out.push({ ...t, title, body: buf, letters: buf });
        buf = "";
      }
      buf += `${p}\n\n`;
    }
    if (buf.trim()) out.push({ ...t, title, body: buf, letters: buf });
  }
  const used = new Set();
  return out.map((p, i) => {
    const base = slug(p.title).slice(0, 44) || slug(t.title).slice(0, 44);
    let file = out.length > 1 ? `${base}-p${i + 1}.md` : `${base}.md`;
    while (used.has(file)) file = file.replace(/\.md$/, "-2.md");
    used.add(file);
    return { ...p, file };
  });
}
for (const [scope, list] of buckets) buckets.set(scope, list.flatMap(carve));

// --- plan ----------------------------------------------------------------
const inline = sections.filter((s) => /^Standing rules/.test(s.title));
let moved = 0;
console.log(`source ${raw.length} chars, ${sections.length} sections`);
console.log(
  `inline: ${inline.length} section (${inline.reduce((a, s) => a + s.body.length, 0)} chars)`,
);
for (const [scope, list] of [...buckets].sort()) {
  const bytes = list.reduce((a, t) => a + t.body.length, 0);
  moved += bytes;
  console.log(
    `\n${scope.padEnd(9)} ${String(list.length).padStart(2)} topics ${String(bytes).padStart(6)} chars  (${DESCRIPTION[scope]})`,
  );
  for (const t of list)
    console.log(
      `   ${String(t.body.length).padStart(6)}  ${t.file.padEnd(48)} ${t.title.slice(0, 60)}`,
    );
}
console.log(`\nmoved ${moved}, inline ${raw.length - moved}`);
if (!APPLY) {
  console.log("\n(dry run — pass --apply)");
  process.exit(0);
}

// --- write ---------------------------------------------------------------
const today = new Date().toISOString().slice(0, 10);
const oneLine = (text) => {
  const first =
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && !l.startsWith("<!--"))[0] || "";
  return first
    .replace(/^[-*]\s*/, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 90);
};
for (const [scope, list] of buckets) {
  const dir = path.join(MEM, "topics", scope);
  fs.mkdirSync(dir, { recursive: true });
  const index = [`# ${scope} — ${DESCRIPTION[scope]} (${list.length} topics)`, ""];
  for (const t of list) {
    fs.writeFileSync(
      path.join(dir, t.file),
      `---\ntopic: ${JSON.stringify(t.title)}\nscope: ${scope}\nupdated: ${today}\n---\n\n${t.body}`,
    );
    index.push(`- [${t.title}](${t.file}) — ${oneLine(t.letters)}`);
  }
  fs.writeFileSync(path.join(dir, "INDEX.md"), `${index.join("\n")}\n`);
}
fs.writeFileSync(
  path.join(MEM, "topics", "INDEX.md"),
  `${[
    "# topics",
    "",
    ...[...buckets.keys()]
      .sort()
      .map((s) => `- [${s}](${s}/INDEX.md) — ${DESCRIPTION[s]}, ${buckets.get(s).length} topics`),
  ].join("\n")}\n`,
);
console.log(
  `\nwrote ${[...buckets.values()].reduce((a, l) => a + l.length, 0)} topic files under ${MEM}/topics`,
);
