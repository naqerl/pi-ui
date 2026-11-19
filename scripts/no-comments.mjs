import { glob, readFile } from "node:fs/promises";
import ts from "typescript";

const TS_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

const SKIP_DIRECTORIES = [
  "node_modules",
  "dist",
  "data",
  ".e2e",
  ".npm-cache",
  ".git",
  "coverage",
  "work",
];

const CODE_ROOTS = ["src", "e2e", "scripts", "public", "themes", ".github/workflows"];

const ROOT_FILES = [
  "Dockerfile",
  "docker-compose.yml",
  "index.html",
  "e2e.config.ts",
  "vite.config.ts",
  "biome.json",
  "biome-plugins/spacing.grit",
  ".gitignore",
  ".dockerignore",
];

function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

function tsComments(text, fileName) {
  const scriptKind = fileName.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind);
  const found = new Map();
  const add = (ranges) => {
    for (const range of ranges ?? []) found.set(range.pos, range);
  };
  const visit = (node) => {
    add(ts.getLeadingCommentRanges(text, node.pos));
    add(ts.getTrailingCommentRanges(text, node.end));
    for (const child of node.getChildren(source)) {
      add(ts.getLeadingCommentRanges(text, child.pos));
      add(ts.getTrailingCommentRanges(text, child.end));
    }
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return [...found.values()].map((range) => ({
    line: lineAt(text, range.pos),
    text: text.slice(range.pos, range.end).split("\n")[0],
  }));
}

function cssComments(text) {
  const comments = [];
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const start = i;
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
      comments.push({ line: lineAt(text, start), text: text.slice(start, i + 1).split("\n")[0] });
    }
  }
  return comments;
}

function htmlComments(text) {
  const comments = [];
  const pattern = /<!--[\s\S]*?-->/g;
  for (const match of text.matchAll(pattern)) {
    comments.push({
      line: lineAt(text, match.index),
      text: match[0].split("\n")[0],
    });
  }
  return comments;
}

function hashComments(text, { shebang = false } = {}) {
  const comments = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (shebang && index === 0 && line.startsWith("#!")) continue;
    let quote = null;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quote) {
        if (ch === "\\" && quote === '"') i += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        continue;
      }
      if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) {
        comments.push({ line: index + 1, text: line.slice(i) });
        break;
      }
    }
  }
  return comments;
}

function dockerComments(text) {
  const comments = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*#/.test(lines[index])) comments.push({ line: index + 1, text: lines[index].trim() });
  }
  return comments;
}

function luaComments(text) {
  const comments = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    let quote = null;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quote) {
        if (ch === "\\") i += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        continue;
      }
      if (ch === "-" && line[i + 1] === "-") {
        comments.push({ line: index + 1, text: line.slice(i) });
        break;
      }
    }
  }
  return comments;
}

function commentsFor(file, text) {
  const name = file.split("/").pop() ?? file;
  const extension = file.slice(file.lastIndexOf("."));
  if (TS_EXTENSIONS.has(extension)) return tsComments(text, file);
  if (extension === ".css") return cssComments(text);
  if (extension === ".html") return htmlComments(text);
  if (name === "Dockerfile") return dockerComments(text);
  if (name === ".gitignore" || name === ".dockerignore") return hashComments(text);
  if (extension === ".yml" || extension === ".yaml" || extension === ".toml")
    return hashComments(text);
  if (extension === ".sh" || extension === ".bash") return hashComments(text, { shebang: true });
  if (extension === ".lua") return luaComments(text);
  return [];
}

const files = new Set(ROOT_FILES);
for await (const file of glob("*")) {
  if (!file.includes("/")) files.add(file);
}
for (const root of CODE_ROOTS) {
  for await (const file of glob(`${root}/**/*`)) {
    if (SKIP_DIRECTORIES.some((dir) => file.split("/").includes(dir))) continue;
    files.add(file);
  }
}

const failures = [];
for (const file of [...files].sort()) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    continue;
  }
  for (const comment of commentsFor(file, text)) {
    failures.push(`${file}:${comment.line}: ${comment.text.trim()}`);
  }
}

if (failures.length > 0) {
  console.error("Comments are not allowed in this repository:");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exitCode = 1;
}
