#!/usr/bin/env node
import { execFileSync } from "node:child_process";
// Prepare / commit a consolidation pass over the memory journal.
//   node dream.mjs            → writes .dream/queue-YYYY-MM-DD.md
//   node dream.mjs --commit   → archives consumed daily logs, updates state, rebuilds the map
//
// The point of the prepare step is not to summarise: it attaches every journalled line to the
// topic file it most likely belongs to, so the merge is "edit these files" rather than "sort a pile".
import fs from "node:fs";
import path from "node:path";

const MEM = (() => {
  const eq = process.argv.find((a) => a.startsWith("--memory="));
  const dir = eq
    ? eq.slice(9)
    : process.env.PI_MEMORY_DIR || path.join(process.env.HOME || "/tmp", ".pi/agent/memory");
  return path.resolve(dir);
})();
const STATE = path.join(MEM, ".dream-state.json");
const QUEUE_DIR = path.join(MEM, ".dream");
const TODAY = new Date().toISOString().slice(0, 10);
const COMMIT = process.argv.includes("--commit");
const EMIT = process.argv.includes("--emit")
  ? process.argv[process.argv.indexOf("--emit") + 1]
  : null;

const readJSON = (p, fb) => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fb;
  }
};
const state = readJSON(STATE, { version: 1, lastRunAt: null, consumed: [] });
const consumed = new Set(state.consumed || []);

const STOP = new Set(
  "the a an and or of to in on for with that this it is are was were be been by as at from not no do does did but if then than so we you i my your our their its there these those".split(
    " ",
  ),
);
const tok = (s) =>
  s
    .toLowerCase()
    .replace(/[`*_#>[\]{}()"'’]/g, " ")
    .split(/[^a-z0-9./:_-]+/)
    .map((w) => w.replace(/^[-./:]+|[-./:]+$/g, ""))
    .filter((w) => w.length > 1 && !STOP.has(w));

// --- topic corpus (targets for the merge) --------------------------------
const topicsDir = path.join(MEM, "topics");
const topics = [];
if (fs.existsSync(topicsDir)) {
  for (const scope of fs.readdirSync(topicsDir)) {
    const dir = path.join(topicsDir, scope);
    if (!fs.statSync(dir).isDirectory()) continue;
    const idxText = fs.existsSync(path.join(dir, "INDEX.md"))
      ? fs.readFileSync(path.join(dir, "INDEX.md"), "utf8")
      : "";
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".md") || f === "INDEX.md") continue;
      const raw = fs.readFileSync(path.join(dir, f), "utf8");
      const title = (raw.match(/^topic:\s*"?(.+?)"?$/m) || [undefined, f])[1];
      const tf = new Map();
      for (const w of tok(`${title} ${raw}`)) tf.set(w, (tf.get(w) || 0) + 1);
      topics.push({
        scope,
        file: f,
        rel: `${scope}/${f}`,
        title,
        bytes: raw.length,
        tf,
        indexed: idxText.includes(`](${f})`),
      });
    }
  }
}
const N = Math.max(1, topics.length);
const df = new Map();
for (const t of topics) for (const w of t.tf.keys()) df.set(w, (df.get(w) || 0) + 1);
const idf = (w) => Math.log(1 + N / (1 + (df.get(w) || 0)));

const scoreTopic = (words, t) => {
  let s = 0;
  for (const w of words) {
    const n = t.tf.get(w);
    if (n) s += (1 + Math.log(n)) * idf(w);
    else if (t.title.toLowerCase().includes(w)) s += 1.5 * idf(w);
  }
  return s / Math.sqrt(words.length || 1);
};
const match = (text) => {
  const words = [...new Set(tok(text))];
  return topics
    .map((t) => ({ t, s: scoreTopic(words, t) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 3);
};

// --- sources -------------------------------------------------------------
const dailyDir = path.join(MEM, "daily");
const daily = fs.existsSync(dailyDir)
  ? fs
      .readdirSync(dailyDir)
      .filter((f) => f.endsWith(".md"))
      .sort()
  : [];
const pending = daily.filter((f) => !consumed.has(f));
const todayName = `${TODAY}.md`;

// blocks = pi-memory stamp-delimited entries; each keeps its context
const blocks = [];
for (const f of pending) {
  const txt = fs.readFileSync(path.join(dailyDir, f), "utf8");
  for (const b of txt.split(/^(?=<!-- )/m)) {
    const body = b.replace(/^<!--.*?-->\s*/, "").trim();
    if (!body) continue;
    const heading = (body.match(/^#{1,4} (.+)$/m) || [])[1] || body.split("\n")[0].slice(0, 70);
    const blockLines = body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length >= 30);
    if (!blockLines.length) continue;
    blocks.push({ file: f, heading, text: body, lines: blockLines });
  }
}

const pad = path.join(MEM, "SCRATCHPAD.md");
const openItems = fs.existsSync(pad)
  ? fs
      .readFileSync(pad, "utf8")
      .split("\n")
      .filter((l) => /^\s*-\s*\[ \]/.test(l))
      .map((l) => l.replace(/^\s*-\s*\[ \]\s*/, ""))
  : [];

// --- attach blocks to topics --------------------------------------------
const attached = new Map(); // rel → {topic, blocks}
const unattached = [];
for (const b of blocks) {
  const cands = match(`${b.heading}\n${b.text}`);
  const best = cands[0];
  if (best && best.s >= 1.1) {
    const key = best.t.rel;
    if (!attached.has(key)) attached.set(key, { topic: best.t, blocks: [] });
    attached.get(key).blocks.push(b);
  } else unattached.push(b);
}

// --- duplicate detection within an attachment group ----------------------
const shingles = (s) => {
  const w = tok(s);
  const out = new Set();
  for (let i = 0; i + 4 <= w.length; i++) out.add(w.slice(i, i + 4).join(" "));
  if (!out.size) out.add(w.join(" ") || "x");
  return out;
};
const jaccard = (a, b) => {
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i || 1);
};
const dupes = [];
for (const [rel, g] of attached) {
  const sh = g.blocks.map((b) => shingles(b.text));
  for (let i = 0; i < g.blocks.length; i++)
    for (let j = i + 1; j < g.blocks.length; j++) {
      const s = jaccard(sh[i], sh[j]);
      if (s >= 0.7) dupes.push({ rel, score: s, a: g.blocks[i], b: g.blocks[j] });
    }
}

const oversized = topics.filter((t) => t.bytes > 6000).sort((a, b) => b.bytes - a.bytes);
const unindexed = topics.filter((t) => !t.indexed);

// --- report --------------------------------------------------------------
const out = [
  `# Dream queue — ${TODAY}`,
  "",
  `Prepared ${new Date().toISOString()}. Merge, then \`node dream.mjs --commit\`.`,
  "",
  `## Sources`,
  "",
  `- daily logs pending: **${pending.length}**`,
  `- journalled blocks: **${blocks.length}** · lines: ${blocks.reduce((a, b) => a + b.lines.length, 0)}`,
  `- attached to an existing topic: **${[...attached.values()].reduce((a, g) => a + g.blocks.length, 0)}** (${attached.size} topics)`,
  `- candidates for a new topic: **${unattached.length}**`,
  `- open scratchpad items: ${openItems.length}`,
  `- topics: ${topics.length} · oversized (>6k): ${oversized.length} · index drift: ${unindexed.length}`,
  "",
  `## Merge targets (in order of volume)`,
  "",
];
const groups = [...attached].sort((a, b) => b[1].blocks.length - a[1].blocks.length);
for (const [rel, g] of groups) {
  out.push(`### topics/${rel} — ${g.blocks.length} blocks · ${g.topic.bytes} chars`);
  out.push(`_${g.topic.title}_`);
  for (const b of g.blocks.slice(0, 12)) {
    out.push(`- **${b.heading.slice(0, 90)}** (${b.file})`);
    for (const l of b.lines.slice(0, 6)) out.push(`  - ${l.slice(0, 200)}`);
    if (b.lines.length > 6) out.push(`  - … ${b.lines.length - 6} more lines`);
  }
  if (g.blocks.length > 12) out.push(`- … ${g.blocks.length - 12} more blocks`);
  out.push("");
}
out.push(`## New-topic candidates`, "");
if (!unattached.length) out.push("none");
for (const b of unattached.slice(0, 25)) {
  out.push(`- **${b.heading.slice(0, 100)}** (${b.file}) — ${b.lines[0].slice(0, 160)}`);
}
if (unattached.length > 25) out.push(`- … ${unattached.length - 25} more`);
out.push("");
out.push(`## Near-duplicates (≥0.70 shingle overlap, same topic)`, "");
if (!dupes.length) out.push("none");
for (const d of dupes.sort((a, b) => b.score - a.score).slice(0, 20))
  out.push(
    `- ${d.score.toFixed(2)} topics/${d.rel}: "${d.a.heading.slice(0, 70)}" ↔ "${d.b.heading.slice(0, 70)}"`,
  );
out.push("");
out.push(`## Topics to compress or split`, "");
if (!oversized.length) out.push("none");
for (const t of oversized) out.push(`- ${t.bytes} chars — \`topics/${t.rel}\``);
out.push("");
out.push(`## Index drift`, "");
if (!unindexed.length) out.push("none");
for (const t of unindexed) out.push(`- missing from \`topics/${t.scope}/INDEX.md\`: ${t.file}`);
out.push("");
out.push(`## Open scratchpad items`, "");
if (!openItems.length) out.push("none");
for (const i of openItems.slice(0, 40)) out.push(`- ${i.slice(0, 200)}`);
out.push("");
out.push(`## Checklist`, "");
out.push(
  "- [ ] for each merge target: fold new facts into the body, drop what the body already says",
  "- [ ] contradictions: keep only the current truth, note the date it changed",
  '- [ ] absolute dates; no "yesterday", no "next steps", no message counts',
  "- [ ] new-topic candidates: create `topics/<scope>/<slug>.md` + an INDEX line, or drop them",
  "- [ ] oversized topics: split on headings, not on paragraph count",
  "- [ ] finish with `node dream.mjs --commit` (archives daily logs, rebuilds the map)",
);
const report = `${out.join("\n")}\n`;

if (EMIT) {
  // one work item per merge target, so a single agent turn can fold one topic
  fs.mkdirSync(EMIT, { recursive: true });
  const emitted = [];
  for (const [rel, g] of groups) {
    const _body = topics.find((t) => t.rel === rel);
    const current = fs.readFileSync(path.join(topicsDir, rel), "utf8");
    const item = [
      `# Merge into topics/${rel}`,
      "",
      `Current body: ${current.length} chars. Blocks to fold: ${g.blocks.length}.`,
      "",
      "## Rules",
      "",
      "1. Rewrite the body so it states the current truth once; delete what it already says.",
      "2. Keep decisions, their rationale, file paths, exact values (versions, ids, thresholds).",
      "3. Drop greetings, tool noise, message counts, next-steps, session metadata.",
      "4. Absolute dates only. Resolve contradictions — the newer statement wins, note the date.",
      "5. Do not grow past ~6000 chars: split on headings into a new topic + INDEX line instead.",
      "6. Write back with: node mwrite.mjs topics/<scope>/<file>.md   (stdin → body)",
      "",
      `## Current body`,
      "",
      current.replace(/^---[\s\S]*?---\n/, "").trim(),
      "",
      `## Blocks to fold (${g.blocks.length})`,
      "",
    ];
    for (const b of g.blocks) {
      item.push(`<!-- from ${b.file} -->`, `### ${b.heading}`, "");
      for (const l of b.lines) item.push(l);
      item.push("");
    }
    const name = rel.replace(/\//g, "--").replace(/\.md$/, ".md");
    const file = path.join(EMIT, name);
    fs.writeFileSync(file, `${item.join("\n")}\n`);
    emitted.push({ file, chars: item.join("\n").length, blocks: g.blocks.length });
  }
  for (const e of emitted.sort((a, b) => b.blocks - a.blocks))
    console.log(
      `${String(e.blocks).padStart(4)} blocks  ${(e.chars / 1000).toFixed(0).padStart(5)}k  ${e.file}`,
    );
  console.log(`\n${emitted.length} work items → ${EMIT}`);
} else if (COMMIT) {
  const archDir = path.join(MEM, "archive", TODAY.slice(0, 7));
  fs.mkdirSync(archDir, { recursive: true });
  const moved = [];
  for (const f of pending) {
    if (f === todayName) continue;
    fs.renameSync(path.join(dailyDir, f), path.join(archDir, f));
    moved.push(f);
  }
  fs.writeFileSync(
    STATE,
    `${JSON.stringify(
      {
        version: 1,
        lastRunAt: new Date().toISOString(),
        lastRunDate: TODAY,
        consumed: [...consumed, ...moved].sort(),
        lastBlocks: blocks.length,
      },
      null,
      2,
    )}\n`,
  );
  if (fs.existsSync(QUEUE_DIR))
    for (const f of fs.readdirSync(QUEUE_DIR))
      if (f.endsWith(".md"))
        fs.renameSync(path.join(QUEUE_DIR, f), path.join(archDir, `queue-${f}`));
  console.log(`archived ${moved.length} daily logs → ${archDir}`);
  try {
    execFileSync(process.execPath, [path.join(MEM, "build-index.mjs"), "--apply"], {
      stdio: "inherit",
    });
  } catch (e) {
    console.warn("map rebuild skipped:", e.message);
  }
} else {
  fs.mkdirSync(QUEUE_DIR, { recursive: true });
  const file = path.join(QUEUE_DIR, `queue-${TODAY}.md`);
  fs.writeFileSync(file, report);
  console.log(report.split("\n").slice(0, 14).join("\n"));
  console.log(`…\n→ ${file} (${report.length} chars)`);
}
