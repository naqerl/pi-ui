#!/usr/bin/env node
// TF-IDF search over memory/topics. Records what was asked in .usage.json so the
// index can rank by recall the way Grok Build's /memory does.
//   node find.mjs "delivery stall verifier"
//   node find.mjs --json "mcp session"
import fs from "node:fs";
import path from "node:path";

const MEM = (() => {
  const eq = process.argv.find((a) => a.startsWith("--memory="));
  const dir = eq
    ? eq.slice(9)
    : process.env.PI_MEMORY_DIR || path.join(process.env.HOME || "/tmp", ".pi/agent/memory");
  return path.resolve(dir);
})();
const TOPICS = path.join(MEM, "topics");
const USAGE = path.join(MEM, ".usage.json");
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes("--json");
const terms = argv.filter((a) => !a.startsWith("--"));
const query = terms.join(" ").trim();
if (!query) {
  console.error('usage: node find.mjs "terms" [--json]');
  process.exit(2);
}

const STOP = new Set(
  "the a an and or of to in on for with that this it is are was were be been by as at from not no do does did but if then than so we you i my your our their its".split(
    " ",
  ),
);
const tokenize = (s) =>
  s
    .toLowerCase()
    .replace(/[`*_#>[\](){}"'’]/g, " ")
    .split(/[^a-z0-9./:_-]+/)
    .map((w) => w.replace(/^[-./:]+|[-./:]+$/g, ""))
    .filter((w) => w.length > 1 && !STOP.has(w));

const docs = [];
if (fs.existsSync(TOPICS)) {
  for (const scope of fs.readdirSync(TOPICS)) {
    const dir = path.join(TOPICS, scope);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md") || f === "INDEX.md") continue;
      const full = path.join(dir, f);
      const raw = fs.readFileSync(full, "utf8");
      const title = (raw.match(/^topic:\s*"?(.+?)"?$/m) || [undefined, f])[1];
      const updated = (raw.match(/^updated:\s*(\S+)$/m) || [undefined, ""])[1];
      const body = raw.replace(/^---[\s\S]*?---\n/, "");
      const lines = body.split("\n");
      const tf = new Map();
      for (const w of tokenize(`${title} ${body}`)) tf.set(w, (tf.get(w) || 0) + 1);
      docs.push({
        scope,
        file: f,
        rel: `${scope}/${f}`,
        full,
        title,
        updated,
        lines,
        tf,
        len: lines.length,
      });
    }
  }
}
if (!docs.length) {
  console.error("no topics found — run split.mjs first");
  process.exit(1);
}

const N = docs.length;
const df = new Map();
for (const d of docs) for (const w of d.tf.keys()) df.set(w, (df.get(w) || 0) + 1);
const idf = (w) => Math.log(1 + N / (1 + (df.get(w) || 0)));
const qTerms = [...new Set(tokenize(query))];
const usage = (() => {
  try {
    return JSON.parse(fs.readFileSync(USAGE, "utf8"));
  } catch {
    return { version: 1, hits: {} };
  }
})();

const now = Date.now();
const results = docs
  .map((d) => {
    let score = 0;
    for (const q of qTerms) {
      const exact = d.tf.get(q) || 0;
      if (exact) score += (1 + Math.log(exact)) * idf(q) * 2.2;
      else {
        // prefix match keeps "verif" → "verifier" working without a stemmer
        for (const [w, n] of d.tf)
          if (w.startsWith(q) || q.startsWith(w)) score += (1 + Math.log(n)) * idf(w) * 0.6;
      }
      if (d.title.toLowerCase().includes(q)) score += 3.5;
      if (d.file.includes(q)) score += 2.0;
    }
    if (!score) return null;
    // recency and recall nudges, both small relative to term match
    const ageDays = d.updated ? Math.max(0, (now - Date.parse(d.updated)) / 86400000) : 90;
    score *= 1 + 0.25 * Math.exp(-ageDays / 45);
    const hits = usage.hits?.[d.rel]?.count || 0;
    score *= 1 + 0.15 * Math.min(4, hits);
    return { ...d, score };
  })
  .filter(Boolean)
  .sort((a, b) => b.score - a.score);

const best = results.slice(0, JSON_OUT ? 20 : 6);
if (!best.length) {
  console.log(`no match for: ${query}`);
  process.exit(1);
}

const snippet = (d) => {
  let bestLine = 0,
    bestScore = -1;
  d.lines.forEach((l, i) => {
    const t = tokenize(l);
    if (!t.length) return;
    let s = 0;
    for (const q of qTerms) if (t.some((w) => w.startsWith(q))) s++;
    if (s > bestScore) {
      bestScore = s;
      bestLine = i;
    }
  });
  const start = Math.max(0, bestLine - 1);
  return d.lines
    .slice(start, start + 3)
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n    ")
    .slice(0, 300);
};

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      best.map((d) => ({
        rel: d.rel,
        title: d.title,
        updated: d.updated,
        score: +d.score.toFixed(3),
      })),
      null,
      2,
    ),
  );
} else {
  for (const d of best) {
    console.log(`\n${d.score.toFixed(1).padStart(6)}  topics/${d.rel}`);
    console.log(`        ${d.title}${d.updated ? `  ·  ${d.updated}` : ""}`);
    console.log(`    ${snippet(d)}`);
  }
  console.log(
    `\n${results.length} match(es), ${N} topics searched. Read: memory_read on topics/${best[0].rel}`,
  );
}

usage.version = 1;
usage.hits = usage.hits || {};
usage.updatedAt = new Date().toISOString();
for (const d of best.slice(0, 3)) {
  const cur = usage.hits[d.rel] || { count: 0 };
  usage.hits[d.rel] = {
    count: cur.count + 1,
    lastAt: usage.updatedAt,
    lastQuery: query.slice(0, 120),
  };
}
fs.writeFileSync(USAGE, `${JSON.stringify(usage, null, 2)}\n`);
