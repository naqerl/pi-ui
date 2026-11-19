import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".mjs",
  ".cjs",
  ".js",
  ".jsx",
  ".css",
  ".sh",
  ".yml",
  ".yaml",
  ".grit",
]);
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "data",
  "work",
  ".git",
  ".e2e",
  "__screenshots__",
]);
const SKIP_FILES = new Set(["package-lock.json"]);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (!SKIP_FILES.has(entry.name)) out.push(full);
  }
  return out;
}

function scriptKind(file) {
  const ext = extname(file);
  if (ext === ".tsx") return ts.ScriptKind.TSX;
  if (ext === ".jsx") return ts.ScriptKind.JSX;
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function isCode(file) {
  return (
    CODE_EXTENSIONS.has(extname(file)) || file.endsWith(".d.ts") || file.endsWith("Dockerfile")
  );
}

function codeComments(text, file) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const ranges = new Map();
  const add = (items) => {
    for (const item of items ?? []) ranges.set(`${item.pos}:${item.end}`, item);
  };
  const visit = (node) => {
    add(ts.getLeadingCommentRanges(text, node.getFullStart()));
    add(ts.getTrailingCommentRanges(text, node.getEnd()));
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  add(ts.getLeadingCommentRanges(text, text.length));
  return [...ranges.values()];
}

function cssComments(text) {
  const ranges = [];
  let quote = "";
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      ranges.push({ pos: i, end: end === -1 ? text.length : end + 2 });
      if (end === -1) break;
      i = end + 1;
    }
  }
  return ranges;
}

function slashComments(text) {
  const ranges = [];
  let quote = "";
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i + 2);
      ranges.push({ pos: i, end: end === -1 ? text.length : end });
      if (end === -1) break;
      i = end - 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      ranges.push({ pos: i, end: end === -1 ? text.length : end + 2 });
      if (end === -1) break;
      i = end + 1;
    }
  }
  return ranges;
}

function lineCommentColumn(line, mode) {
  let quote = "";
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (mode === "shell" && quote === "'" && ch === "'") {
        quote = "";
        continue;
      }
      if (escaped) {
        escaped = false;
        continue;
      }
      if (ch === "\\" && (quote === '"' || mode === "yaml")) {
        escaped = true;
        continue;
      }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (mode === "shell" && ch === "\\") {
      i += 1;
      continue;
    }
    if (ch !== "#") continue;
    if (mode === "dockerfile") return i;
    if (mode === "yaml") {
      if (i === 0 || /\s/.test(line[i - 1])) return i;
      continue;
    }
    if (i === 0 || /\s/.test(line[i - 1]) || ";|&".includes(line[i - 1])) return i;
  }
  return -1;
}

function lineComments(text, mode, file) {
  const ranges = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (index === 0 && line.startsWith("#!")) continue;
    if (index === 0 && file.endsWith("Dockerfile") && line.startsWith("# syntax=")) continue;
    const start = lineCommentColumn(line, mode);
    if (start === -1) continue;
    if (mode === "dockerfile" && line.slice(0, start).trim() !== "") continue;
    const lineStart = lines.slice(0, index).reduce((sum, item) => sum + item.length + 1, 0);
    ranges.push({ pos: lineStart + start, end: lineStart + line.length });
  }
  return ranges;
}

function lineAndColumn(text, pos) {
  let line = 1;
  let column = 1;
  for (let i = 0; i < pos; i += 1) {
    if (text[i] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

const findings = [];
for (const file of walk(ROOT)) {
  if (!isCode(file)) continue;
  const rel = relative(ROOT, file);
  const text = readFileSync(file, "utf8");
  const ext = extname(file);
  let ranges = [];
  if (ext === ".css") ranges = cssComments(text);
  else if (ext === ".grit") ranges = slashComments(text);
  else if (ext === ".sh") ranges = lineComments(text, "shell", file);
  else if (ext === ".yml" || ext === ".yaml") ranges = lineComments(text, "yaml", file);
  else if (file.endsWith("Dockerfile")) ranges = lineComments(text, "dockerfile", file);
  else ranges = codeComments(text, file);
  for (const range of ranges) findings.push({ file: rel, ...lineAndColumn(text, range.pos) });
}

if (findings.length === 0) {
  console.log("No comments found.");
} else {
  for (const finding of findings)
    console.error(`${finding.file}:${finding.line}:${finding.column}: comment`);
  console.error(
    `${findings.length} comment(s) found. Delete comments and make the code self-evident.`,
  );
  process.exitCode = 1;
}
