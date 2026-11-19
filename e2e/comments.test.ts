import assert from "node:assert/strict";
import { test } from "node:test";
import { findComments } from "../scripts/check-comments.mjs";

const emoji = "😀".repeat(10);

test("comment detection ignores markers inside literals and JSX text", () => {
  const cases = [
    ["fixture.ts", `const emoji = "${emoji}";\nconst text = "//";\n`],
    ["fixture.ts", 'const url = "https://example.com/a//b";\n'],
    ["fixture.ts", "const pattern = /https?:\\/\\/example\\.com\\/\\/path/;\n"],
    ["fixture.tsx", "const element = <div>// not a comment /* not either */</div>;\n"],
  ] as const;
  for (const [file, source] of cases) {
    assert.deepEqual(findComments(file, source), []);
  }
});

test("comment detection returns UTF-16 ranges after non-BMP text", () => {
  const source = `const emoji = "${emoji}";\nconst text = "//";\n// real\n`;
  const ranges = findComments("fixture.ts", source);
  assert.equal(ranges.length, 1);
  assert.equal(source.slice(ranges[0]?.start, ranges[0]?.end), "// real");
});

test("comment detection keeps finding real comments", () => {
  assert.equal(findComments("fixture.ts", "// real\n").length, 1);
  assert.equal(findComments("fixture.tsx", "const element = <div>{/* real */}</div>;\n").length, 1);
});
