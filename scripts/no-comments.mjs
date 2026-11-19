import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import ts from "typescript";

const root = process.cwd();
const skipDirectories = new Set([
  ".git",
  ".e2e",
  "coverage",
  "data",
  "dist",
  "node_modules",
  "work",
]);
const tsExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const shellExtensions = new Set([".sh", ".bash"]);
const yamlExtensions = new Set([".yml", ".yaml"]);
const ignoreFiles = new Set([".gitignore", ".dockerignore"]);
const failures = [];

function walk(directory, files) {
  for (const name of readdirSync(directory)) {
    if (skipDirectories.has(name)) continue;
    const path = join(directory, name);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path, files);
    else files.push(path);
  }
}

function lineAt(text, position) {
  let line = 1;
  for (let index = 0; index < position; index++) if (text[index] === "\n") line++;
  return line;
}

function report(file, line, body) {
  failures.push(`${relative(root, file)}:${line}: ${body.trim()}`);
}

function commentRanges(file, text) {
  const kind =
    file.endsWith(".tsx") || file.endsWith(".jsx")
      ? ts.ScriptKind.TSX
      : file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs")
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const ranges = new Map();
  const textRanges = [];
  function add(found) {
    for (const range of found ?? []) {
      if (range.pos >= 0 && range.end >= range.pos) {
        ranges.set(`${range.pos}:${range.end}`, range);
      }
    }
  }
  function visit(node) {
    if (node.kind === ts.SyntaxKind.JsxText) {
      textRanges.push([node.getStart(source), node.getEnd()]);
    } else {
      add(ts.getLeadingCommentRanges(text, node.pos));
      add(ts.getTrailingCommentRanges(text, node.end));
    }
    for (const child of node.getChildren(source)) visit(child);
  }
  visit(source);
  return [...ranges.values()]
    .filter((range) => !textRanges.some(([start, end]) => range.pos >= start && range.pos < end))
    .sort((left, right) => left.pos - right.pos);
}

function scanTypeScript(file, text) {
  for (const range of commentRanges(file, text)) {
    const body = text.slice(range.pos, range.end);
    if (body.startsWith("#!")) continue;
    report(file, lineAt(text, range.pos), body.split("\n")[0]);
  }
}

function blockComments(text) {
  const found = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '"' || character === "'") {
      index++;
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2;
          continue;
        }
        if (text[index] === character) {
          index++;
          break;
        }
        index++;
      }
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      const start = index;
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index++;
      index = Math.min(index + 2, text.length);
      found.push({ start, end: index });
      continue;
    }
    index++;
  }
  return found;
}

function scanCss(file, text) {
  for (const range of blockComments(text)) {
    report(file, lineAt(text, range.start), text.slice(range.start, range.end).split("\n")[0]);
  }
}

function slashComments(text) {
  const found = [];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '"' || character === "'" || character === "`") {
      index++;
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2;
          continue;
        }
        if (text[index] === character) {
          index++;
          break;
        }
        index++;
      }
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      const start = index;
      while (index < text.length && text[index] !== "\n") index++;
      found.push({ start, end: index });
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      const start = index;
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index++;
      index = Math.min(index + 2, text.length);
      found.push({ start, end: index });
      continue;
    }
    index++;
  }
  return found;
}

function scanSlashComments(file, text) {
  for (const range of slashComments(text)) {
    report(file, lineAt(text, range.start), text.slice(range.start, range.end).split("\n")[0]);
  }
}

function scanHtml(file, text) {
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf("<!--", index);
    if (start === -1) return;
    const end = text.indexOf("-->", start + 4);
    const stop = end === -1 ? text.length : end + 3;
    report(file, lineAt(text, start), text.slice(start, stop).split("\n")[0]);
    index = stop;
  }
}

function longBracket(text, index) {
  if (text[index] !== "[") return null;
  let cursor = index + 1;
  while (text[cursor] === "=") cursor++;
  if (text[cursor] !== "[") return null;
  return { start: index, equals: cursor - index - 1, content: cursor + 1 };
}

function scanLua(file, text) {
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === '"' || character === "'") {
      index++;
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2;
          continue;
        }
        if (text[index] === character) {
          index++;
          break;
        }
        index++;
      }
      continue;
    }
    const bracket = longBracket(text, index);
    if (bracket !== null) {
      const close = `]${"=".repeat(bracket.equals)}]`;
      const end = text.indexOf(close, bracket.content);
      index = end === -1 ? text.length : end + close.length;
      continue;
    }
    if (character === "-" && text[index + 1] === "-") {
      const start = index;
      const commentBracket = longBracket(text, index + 2);
      if (commentBracket !== null) {
        const close = `]${"=".repeat(commentBracket.equals)}]`;
        const end = text.indexOf(close, commentBracket.content);
        index = end === -1 ? text.length : end + close.length;
      } else {
        while (index < text.length && text[index] !== "\n") index++;
      }
      report(file, lineAt(text, start), text.slice(start, index).split("\n")[0]);
      continue;
    }
    index++;
  }
}

function shellCommentIndex(line, lineNumber) {
  if (lineNumber === 1 && line.startsWith("#!")) return -1;
  let single = false;
  let double = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === "\\" && double) {
      index++;
      continue;
    }
    if (character === "'" && !double) {
      single = !single;
      continue;
    }
    if (character === '"' && !single) {
      double = !double;
      continue;
    }
    if (character === "#" && !single && !double) {
      const before = index === 0 ? "" : line[index - 1];
      if (before === "" || /\s/.test(before) || /[;&|()<>]/.test(before)) return index;
    }
  }
  return -1;
}

function scanShell(file, text) {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const position = shellCommentIndex(lines[index], index + 1);
    if (position !== -1) report(file, index + 1, lines[index].slice(position));
  }
}

function yamlCommentIndex(line) {
  let single = false;
  let double = false;
  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (character === "\\" && double) {
      index++;
      continue;
    }
    if (character === "'" && !double) {
      if (single && line[index + 1] === "'") {
        index++;
        continue;
      }
      single = !single;
      continue;
    }
    if (character === '"' && !single) {
      double = !double;
      continue;
    }
    if (character === "#" && !single && !double) {
      if (index === 0 || /\s/.test(line[index - 1])) return index;
    }
  }
  return -1;
}

function scanYaml(file, text) {
  const lines = text.split("\n");
  let block = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (block !== null) {
      if (line.trim() !== "") {
        const indent = line.length - line.trimStart().length;
        if (indent > block.parentIndent) {
          if (block.shell) {
            const position = shellCommentIndex(line, index + 1);
            if (position !== -1) report(file, index + 1, line.slice(position));
          }
          continue;
        }
        block = null;
      } else {
        continue;
      }
    }
    const comment = yamlCommentIndex(line);
    if (comment !== -1) report(file, index + 1, line.slice(comment));
    const code = comment === -1 ? line : line.slice(0, comment);
    const start = /^(\s*)(?:-\s*)?([A-Za-z0-9_.-]+)\s*:\s*[|>][+-]?\d?\s*$/.exec(code);
    if (start !== null) block = { parentIndent: start[1].length, shell: start[2] === "run" };
  }
}

function scanToml(file, text) {
  let index = 0;
  while (index < text.length) {
    if (text.startsWith('"""', index)) {
      index += 3;
      while (index < text.length && !text.startsWith('"""', index)) {
        if (text[index] === "\\") index++;
        index++;
      }
      index += 3;
      continue;
    }
    if (text.startsWith("'''", index)) {
      const end = text.indexOf("'''", index + 3);
      index = end === -1 ? text.length : end + 3;
      continue;
    }
    const character = text[index];
    if (character === '"') {
      index++;
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2;
          continue;
        }
        if (text[index] === '"') {
          index++;
          break;
        }
        index++;
      }
      continue;
    }
    if (character === "'") {
      index++;
      while (index < text.length && text[index] !== "'") index++;
      index++;
      continue;
    }
    if (character === "#") {
      const start = index;
      while (index < text.length && text[index] !== "\n") index++;
      report(file, lineAt(text, start), text.slice(start, index));
      continue;
    }
    index++;
  }
}

function scanDockerfile(file, text) {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (!/^\s*#/.test(lines[index])) continue;
    if (/^\s*#\s*(?:syntax|escape|check)\s*=/.test(lines[index])) continue;
    report(file, index + 1, lines[index].trim());
  }
}

function scanIgnore(file, text) {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index++) {
    if (/^\s*#/.test(lines[index])) report(file, index + 1, lines[index]);
  }
}

const files = [];
walk(root, files);
for (const file of files) {
  const name = basename(file);
  const extension = extname(file);
  const dockerfile =
    name === "Dockerfile" || name.startsWith("Dockerfile.") || extension === ".dockerfile";
  if (extension === ".css") {
    scanCss(file, readFileSync(file, "utf8"));
    continue;
  }
  if (extension === ".html") {
    scanHtml(file, readFileSync(file, "utf8"));
    continue;
  }
  if (extension === ".lua") {
    scanLua(file, readFileSync(file, "utf8"));
    continue;
  }
  if (extension === ".grit") {
    scanSlashComments(file, readFileSync(file, "utf8"));
    continue;
  }
  if (tsExtensions.has(extension)) {
    scanTypeScript(file, readFileSync(file, "utf8"));
    continue;
  }
  if (dockerfile) {
    scanDockerfile(file, readFileSync(file, "utf8"));
    continue;
  }
  if (shellExtensions.has(extension)) {
    scanShell(file, readFileSync(file, "utf8"));
    continue;
  }
  if (yamlExtensions.has(extension)) {
    scanYaml(file, readFileSync(file, "utf8"));
    continue;
  }
  if (extension === ".toml") {
    scanToml(file, readFileSync(file, "utf8"));
    continue;
  }
  if (ignoreFiles.has(name)) {
    scanIgnore(file, readFileSync(file, "utf8"));
  }
}

if (failures.length > 0) {
  console.error(`no-comments: found ${failures.length} comment${failures.length === 1 ? "" : "s"}`);
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
}
