import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, relative, resolve } from "node:path";
import ts from "typescript";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const WRITE = process.argv.includes("--write");
const SKIP_DIRS = new Set([".git", ".e2e", "coverage", "data", "dist", "node_modules", "work"]);
const SKIP_FILES = new Set(["package-lock.json"]);
const JS_EXTENSIONS = new Set([".cjs", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);
const HASH_EXTENSIONS = new Set([".bash", ".sh", ".toml", ".yml", ".yaml"]);
const VERBATIM_EXTENSIONS = new Set([".png"]);

function scriptKind(fileName) {
  switch (extname(fileName)) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    case ".mts":
      return ts.ScriptKind.MTS;
    default:
      return ts.ScriptKind.TS;
  }
}

function addRange(ranges, start, end) {
  if (end > start) ranges.push({ start, end });
}

function mergeRanges(ranges) {
  const sorted = [...ranges].sort(
    (left, right) => left.start - right.start || left.end - right.end,
  );
  const merged = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function jsCommentRanges(text, fileName) {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName),
  );
  const ranges = [];
  const protectedRanges = [];
  const seen = new Set();
  const addComments = (list) => {
    for (const range of list ?? []) {
      if (
        range.kind !== ts.SyntaxKind.SingleLineCommentTrivia &&
        range.kind !== ts.SyntaxKind.MultiLineCommentTrivia
      ) {
        continue;
      }
      const key = `${range.pos}:${range.end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      addRange(ranges, range.pos, range.end);
    }
  };
  const visit = (node) => {
    addComments(ts.getLeadingCommentRanges(text, node.getFullStart()));
    addComments(ts.getTrailingCommentRanges(text, node.getEnd()));
    if (ts.isJsxText(node)) {
      addRange(protectedRanges, node.getStart(sourceFile), node.getEnd());
    }
    if (ts.isJsxExpression(node) && node.expression === undefined) {
      addRange(ranges, node.getStart(sourceFile), node.getEnd());
    }
    for (const child of node.getChildren(sourceFile)) visit(child);
  };
  visit(sourceFile);
  return ranges.filter(
    (range) =>
      !protectedRanges.some(
        (protectedRange) => range.start < protectedRange.end && range.end > protectedRange.start,
      ),
  );
}

function quotedRanges(text, quotes) {
  const ranges = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (quotes.includes(char)) {
      const start = index;
      index++;
      while (index < text.length) {
        if (char === '"' && text[index] === "\\") {
          index += 2;
          continue;
        }
        if (
          char === "'" &&
          quotes.includes("'") &&
          text[index] === "'" &&
          text[index + 1] === "'"
        ) {
          index += 2;
          continue;
        }
        if (text[index] === char) {
          index++;
          break;
        }
        index++;
      }
      addRange(ranges, start, index);
      continue;
    }
    index++;
  }
  return ranges;
}

function maskQuoted(text, quotes) {
  const chars = [...text];
  for (const range of quotedRanges(text, quotes)) {
    for (let index = range.start; index < range.end; index++) chars[index] = " ";
  }
  return chars.join("");
}

function skipQuoted(text, index, quote) {
  index++;
  while (index < text.length) {
    if (quote === '"' && text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === quote) return index + 1;
    index++;
  }
  return text.length;
}

function cssCommentRanges(text) {
  const ranges = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      addRange(ranges, index, end === -1 ? text.length : end + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      index = skipQuoted(text, index, char);
      continue;
    }
    index++;
  }
  return ranges;
}

function htmlCommentRanges(text) {
  const ranges = [];
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf("<!--", index);
    if (start === -1) break;
    const end = text.indexOf("-->", start + 4);
    addRange(ranges, start, end === -1 ? text.length : end + 3);
    index = end === -1 ? text.length : end + 3;
  }
  return ranges;
}

function hashCommentRanges(text, allowShebang) {
  const ranges = [];
  const lines = text.split(/(?<=\n)/);
  let offset = 0;
  for (const line of lines) {
    const shebang = allowShebang && offset === 0 && line.startsWith("#!");
    if (!shebang) {
      const masked = maskQuoted(line, ["'", '"']);
      for (let index = 0; index < masked.length; index++) {
        const char = masked[index];
        if (char !== "#") continue;
        const before = index === 0 ? "" : masked[index - 1];
        if (index === 0 || /\s/.test(before)) {
          addRange(ranges, offset + index, offset + line.replace(/\r?\n$/, "").length);
          break;
        }
      }
    }
    offset += line.length;
  }
  return ranges;
}

function shellCommentRanges(text, allowShebang = true) {
  const ranges = hashCommentRanges(text, allowShebang);
  return ranges;
}

function luaCommentRanges(text) {
  const ranges = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === "'" || char === '"') {
      index = skipQuoted(text, index, char);
      continue;
    }
    if (char !== "-" || text[index + 1] !== "-") {
      index++;
      continue;
    }
    if (text[index + 2] === "[" && text[index + 3] === "[") {
      const end = text.indexOf("]]", index + 4);
      addRange(ranges, index, end === -1 ? text.length : end + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    const newline = text.indexOf("\n", index);
    addRange(ranges, index, newline === -1 ? text.length : newline);
    index = newline === -1 ? text.length : newline;
  }
  return ranges;
}

function tokenBefore(text, index) {
  for (let cursor = index - 1; cursor >= 0; cursor--) {
    if (!/\s/.test(text[cursor])) return text[cursor];
  }
  return "";
}

function tokenAfter(text, index) {
  for (let cursor = index; cursor < text.length; cursor++) {
    if (!/\s/.test(text[cursor])) return text[cursor];
  }
  return "";
}

function applyRanges(text, ranges) {
  const merged = mergeRanges(ranges);
  let output = "";
  let cursor = 0;
  for (const range of merged) {
    if (range.start < cursor) continue;
    const lineStart = text.lastIndexOf("\n", range.start - 1) + 1;
    const lineEnd = text.indexOf("\n", range.end);
    const before = text.slice(lineStart, range.start);
    const after = text.slice(range.end, lineEnd === -1 ? text.length : lineEnd);
    const commentOnlyLine = /^[ \t]*$/.test(before) && /^[ \t\r]*$/.test(after);
    if (commentOnlyLine) {
      output += text.slice(cursor, lineStart);
      cursor = lineEnd === -1 ? text.length : lineEnd + 1;
      continue;
    }
    output += text.slice(cursor, range.start);
    if (text.startsWith("//", range.start) || text.startsWith("--", range.start)) {
      cursor = range.end;
      continue;
    }
    if (text.startsWith("/*", range.start) || text.startsWith("<!--", range.start)) {
      if (!/\s/.test(tokenBefore(text, range.start)) && !/\s/.test(tokenAfter(text, range.end))) {
        output += " ";
      }
      cursor = range.end;
      continue;
    }
    cursor = range.end;
  }
  output += text.slice(cursor);
  return output;
}

function stripHashComments(text, allowShebang) {
  return applyRanges(text, hashCommentRanges(text, allowShebang));
}

function stripShell(text, allowShebang = true) {
  return applyRanges(text, shellCommentRanges(text, allowShebang));
}

function yamlCommentRanges(text) {
  const ranges = [];
  const lines = text.split(/(?<=\n)/);
  let offset = 0;
  let blockIndent = -1;
  let blockShell = false;
  for (const line of lines) {
    const body = line.replace(/\r?\n$/, "");
    const indent = body.match(/^[ \t]*/)[0].length;
    if (blockIndent !== -1) {
      if (body.trim() === "" || indent > blockIndent) {
        if (blockShell) {
          for (const range of hashCommentRanges(line, false)) {
            addRange(ranges, offset + range.start, offset + range.end);
          }
        }
        offset += line.length;
        continue;
      }
      blockIndent = -1;
      blockShell = false;
    }
    const masked = maskQuoted(line, ["'", '"']);
    for (let index = 0; index < masked.length; index++) {
      const char = masked[index];
      if (char !== "#") continue;
      const before = index === 0 ? "" : masked[index - 1];
      if (index === 0 || /\s/.test(before)) {
        addRange(ranges, offset + index, offset + body.length);
        break;
      }
    }
    const block = body.match(/^(\s*(?:-\s*)?(?:run|shell|script|command)\s*:\s*)[|>][+-]?\d*\s*$/);
    if (block !== null) {
      blockIndent = indent;
      blockShell = /(?:run|shell|script|command)\s*:/.test(block[1]);
    }
    offset += line.length;
  }
  return ranges;
}

function stripYaml(text) {
  return applyRanges(text, yamlCommentRanges(text));
}

function stripDockerfile(text) {
  const ranges = [];
  let offset = 0;
  for (const line of text.split(/(?<=\n)/)) {
    if (/^\s*#/.test(line)) addRange(ranges, offset, offset + line.replace(/\r?\n$/, "").length);
    offset += line.length;
  }
  return applyRanges(text, ranges);
}

function stripToml(text) {
  const ranges = [];
  const lines = text.split(/(?<=\n)/);
  let offset = 0;
  for (const line of lines) {
    const masked = maskQuoted(line, ["'", '"']);
    const index = masked.indexOf("#");
    if (index !== -1) addRange(ranges, offset + index, offset + line.replace(/\r?\n$/, "").length);
    offset += line.length;
  }
  return applyRanges(text, ranges);
}

function removeComments(fileName, text) {
  const base = basename(fileName);
  const extension = extname(base);
  if (JS_EXTENSIONS.has(extension)) return applyRanges(text, jsCommentRanges(text, fileName));
  if (extension === ".css") return applyRanges(text, cssCommentRanges(text));
  if (extension === ".html") return applyRanges(text, htmlCommentRanges(text));
  if (extension === ".sh" || extension === ".bash") return stripShell(text);
  if (extension === ".yml" || extension === ".yaml") return stripYaml(text);
  if (extension === ".toml") return stripToml(text);
  if (extension === ".lua") return applyRanges(text, luaCommentRanges(text));
  if (base === "Dockerfile" || base.startsWith("Dockerfile.")) return stripDockerfile(text);
  if (extension === "" && (base.startsWith(".gitignore") || base.startsWith(".dockerignore"))) {
    return stripHashComments(text, false);
  }
  return text;
}

function supported(fileName) {
  const base = basename(fileName);
  const extension = extname(base);
  return (
    JS_EXTENSIONS.has(extension) ||
    HASH_EXTENSIONS.has(extension) ||
    extension === ".css" ||
    extension === ".html" ||
    extension === ".lua" ||
    extension === ".toml" ||
    base === "Dockerfile" ||
    base.startsWith("Dockerfile.") ||
    base.startsWith(".gitignore") ||
    base.startsWith(".dockerignore")
  );
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRS.has(entry) || SKIP_FILES.has(entry)) continue;
    const path = join(directory, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) files.push(...walk(path));
    else if (stat.isFile() && !VERBATIM_EXTENSIONS.has(extname(entry)) && supported(entry)) {
      files.push(path);
    }
  }
  return files;
}

function firstCommentLine(text, cleaned) {
  const before = text.split("\n");
  const after = cleaned.split("\n");
  for (let index = 0; index < before.length; index++) {
    if (before[index] !== after[index]) return index + 1;
  }
  return 1;
}

const failures = [];
let changed = 0;
for (const path of walk(ROOT)) {
  const text = readFileSync(path, "utf8");
  const cleaned = removeComments(path, text);
  if (cleaned === text) continue;
  changed++;
  if (WRITE) writeFileSync(path, cleaned);
  else failures.push(`${relative(ROOT, path)}:${firstCommentLine(text, cleaned)}`);
}

if (WRITE) {
  console.log(`no-comments: removed comments from ${changed} file(s)`);
} else if (failures.length > 0) {
  for (const failure of failures) console.error(`${failure}: comment found`);
  console.error(`no-comments: ${failures.length} file(s) contain comments`);
  process.exitCode = 1;
} else {
  console.log("no-comments: clean");
}
