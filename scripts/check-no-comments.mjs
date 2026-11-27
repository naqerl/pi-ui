import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import ts from "typescript";

const root = process.cwd();
const scriptExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const cssExtensions = new Set([".css"]);
const yamlExtensions = new Set([".yml", ".yaml"]);
const shellExtensions = new Set([".sh", ".bash"]);
const slashExtensions = new Set([".json", ".webmanifest", ".grit"]);
const hashExtensions = new Set([".toml"]);
const skipDirectories = new Set([
  "node_modules",
  ".git",
  "dist",
  "data",
  ".e2e",
  "coverage",
  "work",
]);

function collectFiles(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skipDirectories.has(entry.name)) collectFiles(join(directory, entry.name), files);
    } else {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

function scriptKind(file) {
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".ts") || file.endsWith(".mts") || file.endsWith(".cts"))
    return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function scriptComments(text, file) {
  const sourceFile = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file),
  );
  const ranges = new Map();
  const add = (list) => {
    for (const range of list ?? []) ranges.set(range.pos, range);
  };
  const visit = (node) => {
    add(ts.getLeadingCommentRanges(text, node.getFullStart()));
    add(ts.getTrailingCommentRanges(text, node.getEnd()));
    for (const child of node.getChildren(sourceFile)) visit(child);
  };
  visit(sourceFile);
  add(ts.getLeadingCommentRanges(text, sourceFile.endOfFileToken.getFullStart()));
  return [...ranges.values()].sort((left, right) => left.pos - right.pos).map((range) => range.pos);
}

function quotedIndexes(text, marker, isCommentStart) {
  const indexes = [];
  let single = false;
  let double = false;
  let template = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (single) {
      if (character === "\\") index++;
      else if (character === "'") single = false;
      continue;
    }
    if (double) {
      if (character === "\\") index++;
      else if (character === '"') double = false;
      continue;
    }
    if (template) {
      if (character === "\\") index++;
      else if (character === "`") template = false;
      continue;
    }
    if (character === "'") {
      single = true;
      continue;
    }
    if (character === '"') {
      double = true;
      continue;
    }
    if (character === "`") {
      template = true;
      continue;
    }
    if (text.startsWith(marker, index) && isCommentStart(text, index)) {
      indexes.push(index);
      const lineEnd = text.indexOf("\n", index);
      index = lineEnd === -1 ? text.length : lineEnd;
    }
  }
  return indexes;
}

function cssComments(text) {
  const indexes = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] === "/" && text[index + 1] === "*") {
      indexes.push(index);
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    if (text[index] === '"' || text[index] === "'") {
      const quote = text[index];
      index++;
      while (index < text.length) {
        if (text[index] === "\\") index += 2;
        else if (text[index] === quote) {
          index++;
          break;
        } else index++;
      }
      continue;
    }
    index++;
  }
  return indexes;
}

function blockScalarKey(line) {
  const match = /^\s*(?:-\s+)?(?:"([^"]*)"|'([^']*)'|([A-Za-z0-9_.-]+))\s*:(.*)$/.exec(line);
  if (!match) return null;
  const value = match[4].trim();
  if (!/^(?:(?:![^\s]+|&[^\s]+)\s+)*[|>]/.test(value)) return null;
  return match[1] ?? match[2] ?? match[3];
}

function yamlComments(text) {
  const indexes = [];
  let offset = 0;
  let quote = null;
  let blockIndent = -1;
  let blockMin = 0;
  let blockShell = false;
  let flowDepth = 0;
  for (const line of text.split("\n")) {
    const indentation = line.length - line.trimStart().length;
    if (blockIndent >= 0) {
      if (line.trim() === "" || indentation >= blockMin) {
        if (blockShell) {
          const index = hashCommentIndex(line, true);
          if (index !== -1) indexes.push(offset + index);
        }
        offset += line.length + 1;
        continue;
      }
      blockIndent = -1;
      blockShell = false;
    }
    let tokenStart = true;
    let pendingBlock = false;
    let pendingIndicator = 0;
    let index = 0;
    while (index < line.length) {
      const character = line[index];
      if (quote === "'") {
        if (character === "'") {
          if (line[index + 1] === "'") index += 2;
          else {
            quote = null;
            index++;
          }
        } else index++;
        continue;
      }
      if (quote === '"') {
        if (character === "\\") index += 2;
        else {
          if (character === '"') quote = null;
          index++;
        }
        continue;
      }
      if (character === "#" && (index === 0 || /\s/.test(line[index - 1]))) {
        indexes.push(offset + index);
        break;
      }
      if ((character === "]" || character === "}") && flowDepth > 0) {
        flowDepth--;
        tokenStart = false;
        index++;
        continue;
      }
      if (character === "," && flowDepth > 0) {
        tokenStart = true;
        index++;
        continue;
      }
      if (
        character === ":" &&
        (line[index + 1] === undefined ||
          /\s/.test(line[index + 1]) ||
          /["'[{]/.test(line[index + 1]))
      ) {
        tokenStart = true;
        index++;
        continue;
      }
      if (tokenStart) {
        if (character === "'" || character === '"') {
          quote = character;
          tokenStart = false;
          index++;
          continue;
        }
        if (character === "!" || character === "&") {
          index++;
          while (index < line.length && !/\s/.test(line[index])) index++;
          tokenStart = true;
          continue;
        }
        if (character === "|" || character === ">") {
          pendingBlock = true;
          index++;
          while (index < line.length && /[1-9+-]/.test(line[index])) {
            if (/[1-9]/.test(line[index])) pendingIndicator = Number(line[index]);
            index++;
          }
          tokenStart = false;
          continue;
        }
        if (
          (character === "-" || character === "?") &&
          (line[index + 1] === undefined || /\s/.test(line[index + 1]))
        ) {
          index++;
          tokenStart = true;
          continue;
        }
        if (character === "[") {
          flowDepth++;
          index++;
          tokenStart = true;
          continue;
        }
        if (character === "{") {
          flowDepth++;
          index++;
          tokenStart = true;
          continue;
        }
        if (/\s/.test(character)) {
          index++;
          continue;
        }
        tokenStart = false;
        index++;
        continue;
      }
      tokenStart = false;
      index++;
    }
    if (pendingBlock) {
      blockIndent = indentation;
      blockMin = blockIndent + (pendingIndicator || 1);
      blockShell = blockScalarKey(line) === "run";
    }
    offset += line.length + 1;
  }
  return indexes;
}

function hashCommentIndex(line, shell) {
  let single = false;
  let double = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (double) {
      if (character === "\\") index++;
      else if (character === '"') double = false;
      continue;
    }
    if (single) {
      if (character === "'") single = false;
      continue;
    }
    if (character === '"') {
      double = true;
      continue;
    }
    if (character === "'") {
      single = true;
      continue;
    }
    if (character !== "#") continue;
    const previous = line[index - 1];
    if (!shell && (index === 0 || /\s/.test(previous))) return index;
    if (shell && (index === 0 || /[\s;&|()<>]/.test(previous))) return index;
  }
  return -1;
}

function hashComments(text, shell, shebang) {
  const indexes = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    if (!(shebang && offset === 0 && line.startsWith("#!"))) {
      const index = hashCommentIndex(line, shell);
      if (index !== -1) indexes.push(offset + index);
    }
    offset += line.length + 1;
  }
  return indexes;
}

function slashComments(text) {
  return quotedIndexes(text, "//", (value, index) => !value.startsWith("://", index - 1)).concat(
    cssComments(text).filter((index) => text.startsWith("/*", index)),
  );
}

function luaComments(text) {
  return quotedIndexes(text, "--", () => true);
}

function dockerComments(text) {
  const directives = new Set();
  let offset = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") break;
    if (!/^#\s*(?:syntax|escape|check)\s*=/i.test(line)) break;
    directives.add(offset);
    offset += line.length + 1;
  }
  return hashComments(text, false, false).filter((index) => !directives.has(index));
}

function htmlComments(text) {
  const indexes = [];
  let offset = 0;
  while (true) {
    const index = text.indexOf("<!--", offset);
    if (index === -1) return indexes;
    indexes.push(index);
    const end = text.indexOf("-->", index + 4);
    offset = end === -1 ? text.length : end + 3;
  }
}

function commentIndexes(file, text) {
  const extension = extname(file);
  const name = file.slice(file.lastIndexOf("/") + 1);
  if (scriptExtensions.has(extension)) return scriptComments(text, file);
  if (cssExtensions.has(extension)) return cssComments(text);
  if (yamlExtensions.has(extension)) return yamlComments(text);
  if (shellExtensions.has(extension)) return hashComments(text, true, true);
  if (slashExtensions.has(extension)) return slashComments(text);
  if (hashExtensions.has(extension)) return hashComments(text, false, false);
  if (extension === ".lua") return luaComments(text);
  if (extension === ".html") return htmlComments(text);
  if (name === "Dockerfile" || name.startsWith("Dockerfile.")) return dockerComments(text);
  if (name === ".gitignore" || name === ".dockerignore") return hashComments(text, false, false);
  return [];
}

function lineNumber(text, index) {
  let line = 1;
  for (let offset = 0; offset < index; offset++) if (text[offset] === "\n") line++;
  return line;
}

const problems = [];
for (const file of collectFiles(root)) {
  const text = readFileSync(file, "utf8");
  for (const index of commentIndexes(file, text)) {
    const line = lineNumber(text, index);
    const end = text.indexOf("\n", index);
    const excerpt = text.slice(index, end === -1 ? text.length : end).trim();
    problems.push(`${relative(root, file)}:${line}: ${excerpt}`);
  }
}

if (problems.length > 0) {
  console.error("Comments are not allowed in this repository:");
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log("No comments found.");
