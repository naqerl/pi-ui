import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "data", ".e2e"]);
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);

const violations = [];
let checked = 0;

function lineAt(text, position) {
  return text.slice(0, position).split("\n").length;
}

function record(file, text, position, kind) {
  violations.push({
    file: path.relative(ROOT, file),
    line: lineAt(text, position),
    kind,
  });
}

function scanCode(file, text) {
  let kind = ts.ScriptKind.TS;
  if (file.endsWith(".tsx") || file.endsWith(".jsx")) kind = ts.ScriptKind.TSX;
  else if (/\.(mjs|cjs|js)$/.test(file)) kind = ts.ScriptKind.JS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const ranges = new Map();
  const add = (items) => {
    for (const item of items ?? []) ranges.set(item.pos, item);
  };
  add(ts.getLeadingCommentRanges(text, 0));
  const visit = (node) => {
    add(ts.getLeadingCommentRanges(text, node.getFullStart()));
    add(ts.getLeadingCommentRanges(text, node.pos));
    add(ts.getTrailingCommentRanges(text, node.end));
    const children = node.getChildren(source);
    if (children.length === 0) return;
    for (const child of children) visit(child);
  };
  visit(source);
  for (const range of ranges.values()) {
    record(
      file,
      text,
      range.pos,
      text.slice(range.pos, range.end).startsWith("//") ? "line" : "block",
    );
  }
}

function scanCss(file, text) {
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      record(file, text, i, "block");
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
    }
  }
}

function scanHtml(file, text) {
  let index = text.indexOf("<!--");
  while (index !== -1) {
    record(file, text, index, "block");
    index = text.indexOf("<!--", index + 4);
  }
}

function scanHashComments(file, text, allowShebang) {
  const lines = text.split("\n");
  let quote = "";
  let offset = 0;
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row];
    if (allowShebang && row === 0 && line.startsWith("#!")) {
      offset += line.length + 1;
      continue;
    }
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (quote === "'" && ch === "'" && line[i + 1] === "'") {
          i++;
          continue;
        }
        if (quote === '"' && ch === "\\") {
          i++;
          continue;
        }
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        continue;
      }
      if (ch === "#") {
        const previous = i === 0 ? "" : line[i - 1];
        if (i === 0 || /\s/.test(previous)) record(file, text, offset + i, "line");
      }
    }
    offset += line.length + 1;
  }
}

function scanShell(file, text) {
  const lines = text.split("\n");
  let quote = "";
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row];
    if (row === 0 && line.startsWith("#!")) continue;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (quote === '"' && ch === "\\") {
          i++;
          continue;
        }
        if (ch === quote) quote = "";
        continue;
      }
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        continue;
      }
      if (ch === "#") {
        const previous = i === 0 ? "" : line[i - 1];
        if (i === 0 || /[\s;|&()]/.test(previous)) {
          const offset = lines.slice(0, row).reduce((sum, item) => sum + item.length + 1, 0);
          record(file, text, offset + i, "line");
        }
      }
    }
  }
}

function scanDockerfile(file, text) {
  const lines = text.split("\n");
  let offset = 0;
  for (const line of lines) {
    if (/^\s*#/.test(line)) record(file, text, offset, "line");
    offset += line.length + 1;
  }
}

function scanLua(file, text) {
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "-" && text[i + 1] === "-") {
      record(file, text, i, "line");
      if (text[i + 2] === "[") {
        const end = text.indexOf("]]", i + 3);
        i = end === -1 ? text.length : end + 1;
      } else {
        const end = text.indexOf("\n", i);
        i = end === -1 ? text.length : end;
      }
    }
  }
}

function scan(file, text) {
  checked++;
  const extension = path.extname(file);
  const name = path.basename(file);
  if (CODE_EXTENSIONS.has(extension)) return scanCode(file, text);
  if (extension === ".css") return scanCss(file, text);
  if (extension === ".html") return scanHtml(file, text);
  if (extension === ".yml" || extension === ".yaml") return scanHashComments(file, text, false);
  if (extension === ".toml") return scanHashComments(file, text, false);
  if (extension === ".sh" || extension === ".bash") return scanShell(file, text);
  if (extension === ".lua") return scanLua(file, text);
  if (name === "Dockerfile" || name.startsWith("Dockerfile.")) return scanDockerfile(file, text);
}

function walk(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(target);
      continue;
    }
    if (entry.name === "package-lock.json") continue;
    const extension = path.extname(entry.name);
    const isDockerfile = entry.name === "Dockerfile" || entry.name.startsWith("Dockerfile.");
    if (!(CODE_EXTENSIONS.has(extension) || isDockerfile)) {
      if (
        ![".css", ".html", ".yml", ".yaml", ".toml", ".sh", ".bash", ".lua"].includes(extension)
      ) {
        continue;
      }
    }
    scan(target, fs.readFileSync(target, "utf8"));
  }
}

walk(ROOT);

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(`${violation.file}:${violation.line}: ${violation.kind} comment`);
  }
  console.error(`${violations.length} comment${violations.length === 1 ? "" : "s"} found`);
  process.exit(1);
}

console.log(`No comments in ${checked} checked files`);
