import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export const JAVASCRIPT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const SHELL_EXTENSIONS = new Set([".sh", ".bash"]);
const CSS_EXTENSIONS = new Set([".css"]);
const YAML_EXTENSIONS = new Set([".yml", ".yaml"]);

export function classify(file) {
  const normalized = file.split(path.sep).join("/");
  const base = path.posix.basename(normalized);
  const extension = path.posix.extname(base).toLowerCase();
  if (JAVASCRIPT_EXTENSIONS.has(extension)) return "javascript";
  if (CSS_EXTENSIONS.has(extension)) return "css";
  if (SHELL_EXTENSIONS.has(extension)) return "shell";
  if (base === "Dockerfile" || base.startsWith("Dockerfile.") || extension === ".dockerfile") {
    return "dockerfile";
  }
  if (YAML_EXTENSIONS.has(extension)) {
    if (normalized.startsWith(".github/workflows/")) return "yaml";
    if (/^(docker-)?compose[^/]*\.ya?ml$/.test(base)) return "yaml";
  }
  return null;
}

function scriptKind(file) {
  const extension = path.posix.extname(file).toLowerCase();
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".ts" || extension === ".mts" || extension === ".cts") return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function mask(source, start, end) {
  for (let index = start; index < end; index += 1) {
    if (source[index] !== "\n" && source[index] !== "\r") source[index] = " ";
  }
}

function javascriptComments(text, file) {
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    false,
    scriptKind(file),
  );
  const source = text.split("");
  const ranges = [];
  const literalKinds = new Set([
    ts.SyntaxKind.StringLiteral,
    ts.SyntaxKind.NoSubstitutionTemplateLiteral,
    ts.SyntaxKind.RegularExpressionLiteral,
    ts.SyntaxKind.TemplateHead,
    ts.SyntaxKind.TemplateMiddle,
    ts.SyntaxKind.TemplateTail,
    ts.SyntaxKind.JsxText,
  ]);
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.JsxExpression && node.expression === undefined) {
      const start = node.getStart(sourceFile);
      ranges.push({ start, end: node.end, kind: "jsx" });
      mask(source, start, node.end);
    } else if (literalKinds.has(node.kind)) {
      mask(source, node.getStart(sourceFile), node.end);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const masked = source.join("");
  let index = 0;
  while (index < masked.length) {
    if (masked[index] === "/" && masked[index + 1] === "/") {
      const start = index;
      index += 2;
      while (index < masked.length && masked[index] !== "\n" && masked[index] !== "\r") {
        index += 1;
      }
      ranges.push({ start, end: index, kind: "line" });
      continue;
    }
    if (masked[index] === "/" && masked[index + 1] === "*") {
      const start = index;
      const end = masked.indexOf("*/", index + 2);
      index = end === -1 ? masked.length : end + 2;
      ranges.push({ start, end: index, kind: "block" });
      continue;
    }
    index += 1;
  }
  return ranges;
}

function cssComments(text) {
  const ranges = [];
  let index = 0;
  let quote = null;
  while (index < text.length) {
    const character = text[index];
    if (quote !== null) {
      if (character === "\\") {
        index += 2;
        continue;
      }
      if (character === quote) quote = null;
      index += 1;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      index += 1;
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      const start = index;
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
      ranges.push({ start, end: index, kind: "block" });
      continue;
    }
    index += 1;
  }
  return ranges;
}

function shellComments(text) {
  const ranges = [];
  let index = text.startsWith("#!") ? text.indexOf("\n") + 1 || text.length : 0;
  let quote = null;
  while (index < text.length) {
    const character = text[index];
    if (quote === "'") {
      if (character === "'") quote = null;
      index += 1;
      continue;
    }
    if (quote === '"') {
      if (character === "\\") {
        index += 2;
        continue;
      }
      if (character === '"') quote = null;
      index += 1;
      continue;
    }
    if (quote === "`") {
      if (character === "\\") {
        index += 2;
        continue;
      }
      if (character === "`") quote = null;
      index += 1;
      continue;
    }
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      index += 1;
      continue;
    }
    if (character === "#" && (index === 0 || /[\s;&|()]/.test(text[index - 1]))) {
      const start = index;
      while (index < text.length && text[index] !== "\n" && text[index] !== "\r") index += 1;
      ranges.push({ start, end: index, kind: "line" });
      continue;
    }
    index += 1;
  }
  return ranges;
}

function dockerfileComments(text) {
  const ranges = [];
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(lineStart, lineEnd);
    const match = /^[ \t]*#/.exec(line);
    if (match) ranges.push({ start: lineStart + match[0].length - 1, end: lineEnd, kind: "line" });
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return ranges;
}

function yamlComments(text) {
  const ranges = [];
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? text.length : newline;
    let quote = null;
    for (let index = lineStart; index < lineEnd; index += 1) {
      const character = text[index];
      if (quote === "'") {
        if (character === "'") {
          if (text[index + 1] === "'") index += 1;
          else quote = null;
        }
        continue;
      }
      if (quote === '"') {
        if (character === "\\") index += 1;
        else if (character === '"') quote = null;
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
        continue;
      }
      if (character === "#" && (index === lineStart || /\s/.test(text[index - 1]))) {
        ranges.push({ start: index, end: lineEnd, kind: "line" });
        break;
      }
    }
    if (newline === -1) break;
    lineStart = newline + 1;
  }
  return ranges;
}

export function findComments(file, text) {
  const kind = classify(file);
  if (kind === null) return [];
  if (kind === "javascript") return javascriptComments(text, file);
  if (kind === "css") return cssComments(text);
  if (kind === "shell") return shellComments(text);
  if (kind === "dockerfile") return dockerfileComments(text);
  return yamlComments(text);
}

function location(text, offset) {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return `${line}:${column}`;
}

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".e2e",
  "node_modules",
  "dist",
  "data",
  "work",
  "coverage",
]);

function walkFiles(repository) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) visit(path.join(directory, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(repository, absolute).split(path.sep).join("/");
      if (classify(relative) !== null) files.push(relative);
    }
  };
  visit(repository);
  return files.sort();
}

function repositoryFiles(repository) {
  try {
    const output = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return output.split("\0").filter(Boolean);
  } catch {
    return walkFiles(repository);
  }
}

export function check(repository) {
  const failures = [];
  for (const file of repositoryFiles(repository)) {
    if (classify(file) === null) continue;
    const absolute = path.join(repository, file);
    let text;
    try {
      text = readFileSync(absolute, "utf8");
    } catch {
      continue;
    }
    for (const range of findComments(file, text)) {
      failures.push({
        file,
        line: location(text, range.start),
        text: text.slice(range.start, range.end).split(/\r?\n/, 1)[0],
      });
    }
  }
  return failures;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  const failures = check(process.cwd());
  if (failures.length === 0) process.exit(0);
  for (const failure of failures) {
    process.stderr.write(`${failure.file}:${failure.line}: comment: ${failure.text}\n`);
  }
  process.stderr.write(`\n${failures.length} comment(s) found.\n`);
  process.exit(1);
}
