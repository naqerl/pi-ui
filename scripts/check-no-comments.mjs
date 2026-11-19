import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import ts from "typescript";

const ROOT = process.cwd();
const SKIPPED_DIRS = new Set([
  ".git",
  ".e2e",
  ".idea",
  ".vscode",
  "coverage",
  "data",
  "dist",
  "node_modules",
  "work",
]);
const SKIPPED_FILES = new Set(["package-lock.json"]);
const HASH_FILES = new Set([".dockerignore", ".gitignore"]);
const JS_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const SHELL_EXTENSIONS = new Set([".bash", ".sh", ".zsh"]);
const HASH_EXTENSIONS = new Set([".toml", ".yaml", ".yml"]);
const SCANNED_EXTENSIONS = new Set([
  ...JS_EXTENSIONS,
  ...SHELL_EXTENSIONS,
  ...HASH_EXTENSIONS,
  ".css",
  ".grit",
  ".html",
  ".lua",
]);

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) files.push(...walk(join(dir, entry.name)));
      continue;
    }
    if (entry.isFile() && !SKIPPED_FILES.has(entry.name)) files.push(join(dir, entry.name));
  }
  return files;
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function locate(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle] <= index) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: index - starts[low] + 1 };
}

function scriptKind(file) {
  const extension = extname(file);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return ts.ScriptKind.JS;
  }
  if (extension === ".mts") return ts.ScriptKind.MTS;
  if (extension === ".cts") return ts.ScriptKind.CTS;
  return ts.ScriptKind.TS;
}

function jsCommentIndexes(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKind(file));
  const found = new Map();
  const add = (reader, position) => {
    for (const range of reader(text, position) ?? []) found.set(range.pos, range);
  };
  const visit = (node) => {
    const children = node.getChildren(source);
    if (children.length === 0) {
      add(ts.getLeadingCommentRanges, node.getFullStart());
      add(ts.getTrailingCommentRanges, node.getEnd());
      return;
    }
    for (const child of children) visit(child);
  };
  visit(source);
  return [...found.values()].map((range) => range.pos);
}

function cssCommentIndexes(text) {
  const indexes = [];
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quote !== null) {
      if (character === "\\") i++;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "/" && text[i + 1] === "*") {
      indexes.push(i);
      const end = text.indexOf("*/", i + 2);
      if (end === -1) return indexes;
      i = end + 1;
    }
  }
  return indexes;
}

function htmlCommentIndexes(text) {
  const indexes = [];
  let position = text.indexOf("<!--");
  while (position !== -1) {
    indexes.push(position);
    const end = text.indexOf("-->", position + 4);
    if (end === -1) break;
    position = text.indexOf("<!--", end + 3);
  }
  return indexes;
}

function shellCommentIndexes(text) {
  const indexes = [];
  let quote = null;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (i === 0 && character === "#" && text[1] === "!") {
      const end = text.indexOf("\n", 2);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (quote !== null) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#" && (i === 0 || /[\s;|&()]/.test(text[i - 1]))) {
      indexes.push(i);
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
    }
  }
  return indexes;
}

function hashCommentIndexes(text) {
  const indexes = [];
  const lines = text.split("\n");
  let offset = 0;
  let quote = null;
  let escaped = false;
  for (const line of lines) {
    quote = null;
    escaped = false;
    for (let i = 0; i < line.length; i++) {
      const character = line[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (quote !== null) {
        if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        continue;
      }
      if (character === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
        indexes.push(offset + i);
        break;
      }
    }
    offset += line.length + 1;
  }
  return indexes;
}

function luaCommentIndexes(text) {
  const indexes = [];
  for (let i = 0; i < text.length - 1; i++) {
    if (text[i] === "-" && text[i + 1] === "-") {
      indexes.push(i);
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
    }
  }
  return indexes;
}

function gritCommentIndexes(text) {
  const indexes = [];
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const character = text[i];
    if (quote !== null) {
      if (character === "\\") i++;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      continue;
    }
    if (character === "/" && text[i + 1] === "/") {
      indexes.push(i);
      const end = text.indexOf("\n", i);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (character === "/" && text[i + 1] === "*") {
      indexes.push(i);
      const end = text.indexOf("*/", i + 2);
      if (end === -1) return indexes;
      i = end + 1;
    }
  }
  return indexes;
}

function commentIndexes(file, text) {
  const extension = extname(file);
  if (JS_EXTENSIONS.has(extension)) return jsCommentIndexes(file, text);
  if (extension === ".css") return cssCommentIndexes(text);
  if (extension === ".html") return htmlCommentIndexes(text);
  if (SHELL_EXTENSIONS.has(extension)) return shellCommentIndexes(text);
  if (HASH_EXTENSIONS.has(extension)) return hashCommentIndexes(text);
  if (extension === ".lua") return luaCommentIndexes(text);
  if (extension === ".grit") return gritCommentIndexes(text);
  if (
    basename(file) === "Dockerfile" ||
    basename(file).startsWith("Dockerfile.") ||
    HASH_FILES.has(basename(file))
  ) {
    return hashCommentIndexes(text);
  }
  return [];
}

const problems = [];
for (const file of walk(ROOT)) {
  const name = basename(file);
  const dockerfile = name === "Dockerfile" || name.startsWith("Dockerfile.");
  if (!SCANNED_EXTENSIONS.has(extname(file)) && !dockerfile && !HASH_FILES.has(name)) continue;
  const text = readFileSync(file, "utf8");
  const starts = lineStarts(text);
  for (const index of commentIndexes(file, text)) {
    const { line, column } = locate(starts, index);
    problems.push(`${relative(ROOT, file)}:${line}:${column}`);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error(`${problems.length} comment(s) found`);
  process.exitCode = 1;
}
