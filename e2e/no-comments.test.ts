import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CHECKER = fileURLToPath(new URL("../scripts/no-comments.mjs", import.meta.url));

function run(language: string, source: string) {
  return spawnSync(process.execPath, [CHECKER, "--stdin", language], {
    cwd: ROOT,
    input: source,
    encoding: "utf8",
  });
}

test("the comment checker rejects a fixture comment", () => {
  const line = run("ts", "const value = 1; // hidden\n");
  assert.equal(line.status, 1);
  assert.match(line.stderr, /<stdin>:1:\d+: \/\/ hidden/);
  const block = run("ts", "const value = /* hidden */ 1;\n");
  assert.equal(block.status, 1);
  assert.match(block.stderr, /<stdin>:1:\d+: \/\* hidden \*\//);
  const jsx = run("tsx", "export const view = <div>{/* hidden */}</div>;\n");
  assert.equal(jsx.status, 1);
  assert.match(jsx.stderr, /<stdin>:1:\d+: \/\* hidden \*\//);
  const html = run("html", "<div><!-- hidden --></div>\n");
  assert.equal(html.status, 1);
  assert.match(html.stderr, /<stdin>:1:\d+: <!-- hidden -->/);
});

test("the comment checker keeps comments and literals apart", () => {
  const source = [
    'const url = "https://example.com/items";',
    'const slash = "// not a comment";',
    "const pattern = /\\/\\/+\\/g;",
    "export const view = <p>see https://example.com // still text</p>;",
    "export const lineText = <p>",
    "// text",
    "</p>;",
    "export const blockText = <p>/* text */</p>;",
    "",
  ].join("\n");
  const result = run("tsx", source);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  const html = run("html", '<div title="<!-- not a comment -->">text</div>\n');
  assert.equal(html.status, 0);
  assert.equal(html.stderr, "");
});
