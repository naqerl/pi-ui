import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const IGNORED_DIRS = new Set([".git", ".e2e", "coverage", "data", "dist", "node_modules", "work"]);
const IGNORED_FILES = new Set(["package-lock.json"]);
const SCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
const STYLE_EXTENSIONS = new Set([".css", ".scss"]);
const SHELL_EXTENSIONS = new Set([".sh", ".bash", ".zsh"]);
const YAML_EXTENSIONS = new Set([".yml", ".yaml"]);
const TOML_EXTENSIONS = new Set([".toml"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const LUA_EXTENSIONS = new Set([".lua"]);
const CODE_EXTENSIONS = new Set([".json", ".jsonc", ".webmanifest", ".grit"]);

const fix = process.argv.includes("--fix");
const problems = [];

function walk(directory) {
  const entries = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      entries.push(...walk(join(directory, entry.name)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (IGNORED_FILES.has(entry.name)) continue;
    entries.push(join(directory, entry.name));
  }
  return entries;
}

function languageFor(file) {
  const name = file.slice(file.lastIndexOf("/") + 1);
  const extension = extname(name);
  const lowerName = name.toLowerCase();
  if (
    lowerName === "dockerfile" ||
    lowerName.startsWith("dockerfile.") ||
    lowerName === "containerfile" ||
    lowerName.startsWith("containerfile.") ||
    lowerName.endsWith(".dockerfile")
  ) {
    return "docker";
  }
  if (SCRIPT_EXTENSIONS.has(extension)) return "script";
  if (STYLE_EXTENSIONS.has(extension)) return "style";
  if (SHELL_EXTENSIONS.has(extension)) return "shell";
  if (YAML_EXTENSIONS.has(extension)) return "yaml";
  if (TOML_EXTENSIONS.has(extension)) return "toml";
  if (HTML_EXTENSIONS.has(extension)) return "html";
  if (LUA_EXTENSIONS.has(extension)) return "lua";
  if (CODE_EXTENSIONS.has(extension)) return "code";
  return null;
}

function scriptKindFor(file) {
  const extension = extname(file);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return ts.ScriptKind.JS;
  if (extension === ".mts" || extension === ".cts") return ts.ScriptKind.TS;
  return ts.ScriptKind.TS;
}

function isInside(offset, ranges) {
  return ranges.some(([start, end]) => offset >= start && offset <= end);
}

function collectScriptRanges(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  const containers = [];
  const jsxText = [];
  const found = [];
  function add(ranges) {
    if (!ranges) return;
    for (const range of ranges) found.push([range.pos, range.end]);
  }
  function visit(node) {
    if (ts.isJsxText(node)) jsxText.push([node.getStart(source), node.end]);
    if (
      ts.isJsxExpression(node) &&
      node.expression === undefined &&
      /\/[/*]/.test(text.slice(node.getStart(source), node.end))
    ) {
      containers.push([node.getStart(source), node.end]);
    }
    const children = node.getChildren(source);
    if (children.length === 0) {
      add(ts.getLeadingCommentRanges(text, node.pos));
      add(ts.getTrailingCommentRanges(text, node.end));
      return;
    }
    for (const child of children) visit(child);
  }
  visit(source);
  const ranges = containers.map(([start, end]) => ({ start, end, block: true, whole: true }));
  const unique = new Map();
  for (const [start, end] of found) {
    if (isInside(start, containers) || isInside(start, jsxText)) continue;
    unique.set(`${start}:${end}`, { start, end, block: true, whole: false });
  }
  ranges.push(...unique.values());
  return ranges;
}

function collectStyleRanges(text, lineComments) {
  const ranges = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'") {
      const quote = char;
      index += 1;
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2;
          continue;
        }
        if (text[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end === -1 ? text.length : end + 2;
      ranges.push({ start: index, end: stop, block: true, whole: false });
      index = stop;
      continue;
    }
    if (
      lineComments &&
      char === "/" &&
      text[index + 1] === "/" &&
      (index === 0 || /[\s;{}]/.test(text[index - 1]))
    ) {
      const end = text.indexOf("\n", index + 2);
      const stop = end === -1 ? text.length : end;
      ranges.push({ start: index, end: stop, block: false, whole: false });
      index = stop;
      continue;
    }
    index += 1;
  }
  return ranges;
}

function findHashComment(line, mode) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote === "'") {
      if (mode === "yaml" && char === "'" && line[index + 1] === "'") {
        index += 1;
        continue;
      }
      if (char === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === '"') quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\\" && mode === "shell") {
      index += 1;
      continue;
    }
    if (char === "#" && (index === 0 || /[\s;|&()<>]/.test(line[index - 1]))) {
      return index;
    }
  }
  return -1;
}

function luaLongBracket(text, index) {
  if (text[index] !== "[") return null;
  let cursor = index + 1;
  while (text[cursor] === "=") cursor += 1;
  if (text[cursor] !== "[") return null;
  return {
    close: `]${"=".repeat(cursor - index - 1)}]`,
    contentStart: cursor + 1,
  };
}

function collectLuaRanges(text) {
  const ranges = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "'" || char === '"') {
      const quote = char;
      index += 1;
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2;
          continue;
        }
        if (text[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    const longString = luaLongBracket(text, index);
    if (longString !== null) {
      const close = text.indexOf(longString.close, longString.contentStart);
      index = close === -1 ? text.length : close + longString.close.length;
      continue;
    }
    if (char !== "-" || text[index + 1] !== "-") {
      index += 1;
      continue;
    }
    const longComment = luaLongBracket(text, index + 2);
    if (longComment !== null) {
      const close = text.indexOf(longComment.close, longComment.contentStart);
      const end = close === -1 ? text.length : close + longComment.close.length;
      ranges.push({ start: index, end, block: true, whole: false });
      index = end;
      continue;
    }
    const newline = text.indexOf("\n", index + 2);
    const end = newline === -1 ? text.length : newline;
    ranges.push({ start: index, end, block: false, whole: false });
    index = end;
  }
  return ranges;
}

function yamlKey(line) {
  const match = line.match(/^\s*(?:-\s+)?(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*:/);
  if (match === null) return null;
  return {
    key: match[1] ?? match[2] ?? match[3],
    indent: line.length - line.trimStart().length,
  };
}

function yamlBlockScalar(line, healthcheckIndent) {
  const match = line.match(
    /^\s*(?:-\s+)?(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*:\s*[|>](?:[1-9][+-]?|[+-][1-9]?)?\s*(?:#.*)?$/,
  );
  if (match === null) return null;
  const key = match[1] ?? match[2] ?? match[3];
  const indent = line.length - line.trimStart().length;
  return {
    indent,
    shell:
      key === "run" ||
      key === "command" ||
      key === "entrypoint" ||
      (key === "test" && healthcheckIndent !== null && indent > healthcheckIndent),
  };
}

function findHeredocStarts(line) {
  const starts = [];
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote !== null) {
      if (char === "\\" && quote === '"') {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char !== "<" || line[index + 1] !== "<") continue;
    if (line[index + 2] === "<") {
      index += 2;
      continue;
    }
    let cursor = index + 2;
    let stripTabs = false;
    if (line[cursor] === "-") {
      stripTabs = true;
      cursor += 1;
    }
    while (line[cursor] === " " || line[cursor] === "\t") cursor += 1;
    let delimiter = "";
    if (line[cursor] === "'" || line[cursor] === '"') {
      const delimiterQuote = line[cursor];
      cursor += 1;
      while (cursor < line.length && line[cursor] !== delimiterQuote) {
        if (line[cursor] === "\\" && delimiterQuote === '"') cursor += 1;
        delimiter += line[cursor];
        cursor += 1;
      }
    } else {
      while (cursor < line.length && !/[\s;|&()<>]/.test(line[cursor])) {
        delimiter += line[cursor];
        cursor += 1;
      }
    }
    if (delimiter.length > 0) starts.push({ delimiter, stripTabs });
    index = cursor - 1;
  }
  return starts;
}

function collectLineRanges(text, mode) {
  const ranges = [];
  const lines = text.split(/(?<=\n)/);
  let offset = 0;
  let blockScalar = null;
  let healthcheckIndent = null;
  let dockerRunContinuation = false;
  const heredocs = [];
  for (const line of lines) {
    const body = line.replace(/\r?\n$/, "");
    const trimmed = body.trimStart();
    if (mode === "shell" && offset === 0 && trimmed.startsWith("#!")) {
      offset += line.length;
      continue;
    }
    if (heredocs.length > 0) {
      const current = heredocs[0];
      const candidate = current.indent > 0 ? body.slice(current.indent) : body;
      const normalized = current.stripTabs ? candidate.replace(/^\t+/, "") : candidate;
      if (normalized === current.delimiter) {
        heredocs.shift();
      } else if (current.scan) {
        const index = findHashComment(body, "shell");
        if (index !== -1) {
          ranges.push({
            start: offset + index,
            end: offset + body.length,
            block: false,
            whole: false,
          });
        }
        const starts = findHeredocStarts(index === -1 ? body : body.slice(0, index));
        heredocs.push(...starts.map((start) => ({ ...start, scan: false, indent: 0 })));
      }
      offset += line.length;
      continue;
    }
    if (mode === "yaml" && blockScalar !== null) {
      if (body.trim().length === 0) {
        offset += line.length;
        continue;
      }
      const indent = body.length - body.trimStart().length;
      if (indent <= blockScalar.indent) {
        blockScalar = null;
      } else {
        if (blockScalar.contentIndent === null) blockScalar.contentIndent = indent;
        const content = body.slice(Math.min(blockScalar.contentIndent, body.length));
        const contentOffset = offset + body.length - content.length;
        if (blockScalar.shell) {
          const index = findHashComment(content, "shell");
          if (index !== -1) {
            ranges.push({
              start: contentOffset + index,
              end: contentOffset + content.length,
              block: false,
              whole: false,
            });
          }
          const starts = findHeredocStarts(index === -1 ? content : content.slice(0, index));
          heredocs.push(
            ...starts.map((start) => ({
              ...start,
              scan: false,
              indent: blockScalar.contentIndent,
            })),
          );
        }
        offset += line.length;
        continue;
      }
    }
    let nextBlockScalar = null;
    if (mode === "yaml") {
      const key = yamlKey(body);
      if (key !== null) {
        if (healthcheckIndent !== null && key.indent <= healthcheckIndent) healthcheckIndent = null;
        if (key.key === "healthcheck") healthcheckIndent = key.indent;
      }
      nextBlockScalar = yamlBlockScalar(body, healthcheckIndent);
    }
    if (mode === "docker") {
      if (/^#\s*(syntax|escape)=/.test(trimmed)) {
        offset += line.length;
        continue;
      }
      if (trimmed.startsWith("#")) {
        const start = offset + body.indexOf("#");
        ranges.push({ start, end: offset + body.length, block: false, whole: false });
        dockerRunContinuation = false;
        offset += line.length;
        continue;
      }
      const runStart = /^RUN(?:\s|$)/i.test(trimmed);
      const runLine = runStart || dockerRunContinuation;
      if (runLine) {
        const runMatch = runStart ? body.match(/^\s*RUN\b/i) : null;
        const shellText = runMatch ? body.slice(runMatch.index + runMatch[0].length) : body;
        const shellOffset = offset + (runMatch ? runMatch.index + runMatch[0].length : 0);
        const commentIndex = findHashComment(shellText, "shell");
        if (commentIndex !== -1) {
          ranges.push({
            start: shellOffset + commentIndex,
            end: offset + body.length,
            block: false,
            whole: false,
          });
        }
        const shellCode = commentIndex === -1 ? shellText : shellText.slice(0, commentIndex);
        dockerRunContinuation = /\\\s*$/.test(shellCode);
        const starts = findHeredocStarts(shellCode);
        heredocs.push(...starts.map((start) => ({ ...start, scan: true, indent: 0 })));
      } else {
        dockerRunContinuation = false;
        const starts = findHeredocStarts(body);
        heredocs.push(...starts.map((start) => ({ ...start, scan: false, indent: 0 })));
      }
      offset += line.length;
      continue;
    }
    const index = findHashComment(body, mode);
    if (index !== -1) {
      ranges.push({ start: offset + index, end: offset + body.length, block: false, whole: false });
    }
    if (mode === "shell") {
      const starts = findHeredocStarts(index === -1 ? body : body.slice(0, index));
      heredocs.push(...starts.map((start) => ({ ...start, scan: false, indent: 0 })));
    }
    if (nextBlockScalar !== null) {
      blockScalar = { ...nextBlockScalar, contentIndent: null };
    }
    offset += line.length;
  }
  return ranges;
}

function collectCodeRanges(text) {
  const ranges = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      index += 1;
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2;
          continue;
        }
        if (text[index] === quote) {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index + 2);
      const stop = end === -1 ? text.length : end;
      ranges.push({ start: index, end: stop, block: false, whole: false });
      index = stop;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end === -1 ? text.length : end + 2;
      ranges.push({ start: index, end: stop, block: true, whole: false });
      index = stop;
      continue;
    }
    index += 1;
  }
  return ranges;
}

function collectHtmlRanges(text) {
  const ranges = [];
  const expression = /<!--[\s\S]*?-->/g;
  for (let match = expression.exec(text); match; match = expression.exec(text)) {
    ranges.push({
      start: match.index,
      end: match.index + match[0].length,
      block: true,
      whole: false,
    });
  }
  return ranges;
}

export function findCommentRanges(file, text) {
  return rangesFor(file, text);
}

function rangesFor(file, text) {
  switch (languageFor(file)) {
    case "script":
      return collectScriptRanges(file, text);
    case "style":
      return collectStyleRanges(text, extname(file) === ".scss");
    case "shell":
      return collectLineRanges(text, "shell");
    case "yaml":
      return collectLineRanges(text, "yaml");
    case "toml":
      return collectLineRanges(text, "toml");
    case "docker":
      return collectLineRanges(text, "docker");
    case "html":
      return collectHtmlRanges(text);
    case "lua":
      return collectLuaRanges(text);
    case "code":
      return collectCodeRanges(text);
    default:
      return [];
  }
}

function applyRanges(text, ranges) {
  const ordered = [...ranges].sort((left, right) => right.start - left.start);
  let result = text;
  for (const range of ordered) {
    const replacement = range.whole || !range.block ? "" : " ";
    result = result.slice(0, range.start) + replacement + result.slice(range.end);
  }
  return result.replace(/[ \t]+$/gm, "");
}

function lineAndColumn(text, offset) {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      column = 1;
      continue;
    }
    column += 1;
  }
  return { line, column };
}

function main() {
  const files = walk(ROOT).filter((file) => languageFor(file) !== null);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const ranges = rangesFor(file, text);
    if (ranges.length === 0) continue;
    const display = relative(ROOT, file);
    if (!fix) {
      for (const range of ranges) {
        const { line, column } = lineAndColumn(text, range.start);
        problems.push(`${display}:${line}:${column}: comment`);
      }
      continue;
    }
    writeFileSync(file, applyRanges(text, ranges));
  }

  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`${problem}\n`);
    process.stderr.write(`${problems.length} comment${problems.length === 1 ? "" : "s"} found\n`);
    process.exit(1);
  }

  if (!fix) process.stdout.write("No comments found\n");
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) main();
