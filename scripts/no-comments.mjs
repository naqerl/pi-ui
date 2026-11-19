import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const TS_LIKE = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SHELL_OPERATORS = new Set([";", "|", "&", "(", ")", "<", ">"]);

function languageFor(file) {
  const base = path.basename(file);
  const ext = path.extname(file).toLowerCase();
  if (TS_LIKE.has(ext)) return "ts";
  if (ext === ".css") return "css";
  if (base === "Dockerfile" || base.endsWith(".Dockerfile")) return "docker";
  if (ext === ".yml" || ext === ".yaml") return "yaml";
  if (ext === ".sh" || ext === ".bash") return "shell";
  if (ext === ".toml") return "toml";
  if (ext === ".lua") return "lua";
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".grit") return "slash";
  return null;
}

function scriptKind(file, language) {
  if (language === "tsx") return ts.ScriptKind.TSX;
  if (language === "jsx") return ts.ScriptKind.JSX;
  if (language === "js") return ts.ScriptKind.JS;
  if (file.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (file.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs"))
    return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function lineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) starts.push(index + 1);
  }
  return starts;
}

function locate(starts, position) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle] <= position) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: position - starts[low] + 1 };
}

function scanTs(text, file, starts, language) {
  const found = [];
  const seen = new Set();
  const jsxText = [];
  const source = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(file, language),
  );
  const add = (range) => {
    if (range === undefined || range.kind === ts.SyntaxKind.ShebangTrivia) return;
    const key = `${range.pos}:${range.end}`;
    if (seen.has(key)) return;
    seen.add(key);
    const at = locate(starts, range.pos);
    found.push({ ...at, text: text.slice(range.pos, range.end) });
  };
  const visit = (node) => {
    if (ts.isJsxText(node)) jsxText.push([node.getStart(source), node.end]);
    for (const range of ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []) add(range);
    for (const range of ts.getTrailingCommentRanges(text, node.end) ?? []) add(range);
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  return found
    .filter((comment) => {
      const position = starts[comment.line - 1] + comment.column - 1;
      return !jsxText.some(([start, end]) => position >= start && position < end);
    })
    .sort((left, right) => left.line - right.line || left.column - right.column);
}

function scanSlash(text, starts) {
  const found = [];
  let quote = null;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (quote !== null) {
      if (character === "\\") index += 2;
      else {
        if (character === quote) quote = null;
        index += 1;
      }
      continue;
    }
    if (character === '"' || character === "'" || character === "`") {
      quote = character;
      index += 1;
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      const newline = text.indexOf("\n", index + 2);
      const stop = newline < 0 ? text.length : newline;
      const at = locate(starts, index);
      found.push({ ...at, text: text.slice(index, stop) });
      index = stop;
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end < 0 ? text.length : end + 2;
      const at = locate(starts, index);
      found.push({ ...at, text: text.slice(index, stop) });
      index = stop;
      continue;
    }
    index += 1;
  }
  return found;
}

function scanCss(text, starts) {
  const found = [];
  let quote = null;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (quote !== null) {
      if (character === "\\") index += 2;
      else {
        if (character === quote) quote = null;
        index += 1;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      index += 1;
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end < 0 ? text.length : end + 2;
      const at = locate(starts, index);
      found.push({ ...at, text: text.slice(index, stop) });
      index = stop;
      continue;
    }
    index += 1;
  }
  return found;
}

function scanHtml(text, starts) {
  const found = [];
  let index = 0;
  while (index < text.length) {
    if (text.startsWith("<!--", index)) {
      const close = text.indexOf("-->", index + 4);
      const stop = close < 0 ? text.length : close + 3;
      const at = locate(starts, index);
      found.push({ ...at, text: text.slice(index, stop) });
      index = stop;
      continue;
    }
    if (text[index] === "<" && /[A-Za-z!/?]/.test(text[index + 1] ?? "")) {
      let quote = null;
      let cursor = index + 1;
      while (cursor < text.length) {
        const character = text[cursor];
        if (quote !== null) {
          if (character === quote) quote = null;
          cursor += 1;
          continue;
        }
        if (character === '"' || character === "'") {
          quote = character;
          cursor += 1;
          continue;
        }
        if (character === ">") {
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      index = cursor;
      continue;
    }
    index += 1;
  }
  return found;
}

function scanLua(text, starts) {
  const found = [];
  let index = 0;
  let quote = null;
  while (index < text.length) {
    const character = text[index];
    if (quote !== null) {
      if (character === "\\") index += 2;
      else {
        if (character === quote) quote = null;
        index += 1;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      index += 1;
      continue;
    }
    if (character === "[" && text[index + 1] === "[") {
      const close = text.indexOf("]]", index + 2);
      index = close < 0 ? text.length : close + 2;
      continue;
    }
    if (character === "-" && text[index + 1] === "-") {
      let stop = index + 2;
      if (text[stop] === "[") {
        const brackets = /^\[(=*)\[/.exec(text.slice(stop));
        if (brackets !== null) {
          const close = `]${brackets[1]}]`;
          const end = text.indexOf(close, stop + brackets[0].length);
          stop = end < 0 ? text.length : end + close.length;
        }
      }
      if (stop === index + 2) {
        const newline = text.indexOf("\n", stop);
        stop = newline < 0 ? text.length : newline;
      }
      const at = locate(starts, index);
      found.push({ ...at, text: text.slice(index, stop) });
      index = stop;
      continue;
    }
    index += 1;
  }
  return found;
}

function scanToml(text, starts) {
  const found = [];
  let index = 0;
  let quote = null;
  while (index < text.length) {
    const character = text[index];
    if (quote !== null) {
      if (quote.length === 3) {
        if (character === "\\" && quote === '"""') {
          index += 2;
          continue;
        }
        if (text.startsWith(quote, index)) {
          index += 3;
          quote = null;
          continue;
        }
        index += 1;
        continue;
      }
      if (character === "\\" && quote === '"') index += 2;
      else {
        if (character === quote) quote = null;
        index += 1;
      }
      continue;
    }
    if (text.startsWith('"""', index) || text.startsWith("'''", index)) {
      quote = text.slice(index, index + 3);
      index += 3;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      index += 1;
      continue;
    }
    if (character === "#") {
      const newline = text.indexOf("\n", index);
      const stop = newline < 0 ? text.length : newline;
      const at = locate(starts, index);
      found.push({ ...at, text: text.slice(index, stop) });
      index = stop;
      continue;
    }
    index += 1;
  }
  return found;
}

function scanHash(text, mode, starts) {
  const found = [];
  const lines = text.split("\n");
  let offset = 0;
  let quote = null;
  let heredoc = null;
  let blockIndent = null;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const lineStart = offset;
    offset += line.length + 1;
    if (heredoc !== null) {
      if (line.replace(/^\t+/, "").trim() === heredoc) heredoc = null;
      continue;
    }
    if (mode === "yaml" && blockIndent !== null) {
      const indent = line.length - line.trimStart().length;
      if (line.trim() === "" || indent > blockIndent) continue;
      blockIndent = null;
    }
    let commentAt = -1;
    let index = 0;
    while (index < line.length) {
      const character = line[index];
      if (quote !== null) {
        if (character === "\\" && quote === '"') index += 2;
        else {
          if (character === quote) quote = null;
          index += 1;
        }
        continue;
      }
      if (character === '"' || character === "'") {
        quote = character;
        index += 1;
        continue;
      }
      if (character === "#") {
        const first = line.search(/\S/);
        if (mode === "docker") {
          if (index === first) commentAt = index;
        } else {
          const previous = index === 0 ? "" : line[index - 1];
          if (index === first || /\s/.test(previous) || SHELL_OPERATORS.has(previous)) {
            commentAt = index;
          }
        }
        break;
      }
      index += 1;
    }
    if (commentAt >= 0) {
      if (lineIndex === 0 && line.startsWith("#!")) continue;
      const at = locate(starts, lineStart + commentAt);
      found.push({ ...at, text: line.slice(commentAt) });
      continue;
    }
    if (mode === "shell" || mode === "docker") {
      const match = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(line);
      if (match !== null) heredoc = match[2];
    }
    if (mode === "yaml" && /(?:^|:\s+|-\s+)[|>][+-]?\s*$/.test(line)) {
      blockIndent = line.length - line.trimStart().length;
    }
  }
  return found;
}

function scan(text, file, language) {
  const starts = lineStarts(text);
  if (language === "ts" || language === "tsx" || language === "js" || language === "jsx") {
    return scanTs(text, file, starts, language);
  }
  if (language === "css") return scanCss(text, starts);
  if (language === "slash") return scanSlash(text, starts);
  if (language === "html") return scanHtml(text, starts);
  if (language === "lua") return scanLua(text, starts);
  if (language === "toml") return scanToml(text, starts);
  return scanHash(text, language, starts);
}

function trackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" });
  return output.split("\0").filter((file) => file !== "" && languageFor(file) !== null);
}

function report(file, found) {
  for (const comment of found) {
    console.error(`${file}:${comment.line}:${comment.column}: ${comment.text.trim()}`);
  }
  return found.length;
}

function readStdin() {
  return readFileSync(0, "utf8");
}

const argumentsList = process.argv.slice(2);
let failures = 0;
if (argumentsList[0] === "--stdin") {
  const language = argumentsList[1];
  if (language === undefined) {
    console.error("no-comments: --stdin needs a language");
    process.exit(2);
  }
  failures += report("<stdin>", scan(readStdin(), "<stdin>", language));
} else {
  for (const file of trackedFiles()) {
    const language = languageFor(file);
    failures += report(file, scan(readFileSync(file, "utf8"), file, language));
  }
}

if (failures > 0) {
  console.error(`no-comments: ${failures} comment${failures === 1 ? "" : "s"} found`);
  process.exit(1);
}
