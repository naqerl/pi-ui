import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cn } from "../src/client/lib/utils";

const CLIENT_DIR = fileURLToPath(new URL("../src/client", import.meta.url));
const INDEX_CSS = join(CLIENT_DIR, "index.css");

const SPACING_UTILITY =
  /(?<![a-z-])-?(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y)-(?:\[[^\]]+\]|[0-9._]+|px)(?![a-z])/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

test("only the six named spacing steps are declared in index.css", () => {
  const css = readFileSync(INDEX_CSS, "utf8");
  const declared = [...css.matchAll(/--spacing-([\w-]+)\s*:/g)].map((match) => match[1]);
  assert.deepEqual(declared.sort(), ["2xl", "lg", "md", "sm", "xl", "xs"]);
  assert.match(css, /--spacing-xs:\s*0\.125rem/);
  assert.match(css, /--spacing-sm:\s*0\.25rem/);
  assert.match(css, /--spacing-md:\s*0\.375rem/);
  assert.match(css, /--spacing-lg:\s*0\.5rem/);
  assert.match(css, /--spacing-xl:\s*0\.75rem/);
  assert.match(css, /--spacing-2xl:\s*1rem/);
});

test("tailwind-merge knows the six spacing steps, including caller overrides", () => {
  assert.equal(cn("px-xl px-lg"), "px-lg");
  assert.equal(cn("px-lg", "px-xl"), "px-xl");
  assert.equal(cn("p-2xl p-lg"), "p-lg");
  assert.equal(cn("gap-sm gap-2xl"), "gap-2xl");
  assert.equal(cn("-mt-xs mt-sm"), "mt-sm");
});

test("client sources use the six tokens, not numeric spacing utilities", () => {
  const offenders: string[] = [];
  for (const path of sourceFiles(CLIENT_DIR)) {
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(SPACING_UTILITY)) {
      const utility = match[0];
      if (/-0$/.test(utility)) continue;
      offenders.push(`${path.slice(CLIENT_DIR.length + 1)}: ${utility}`);
    }
  }
  assert.deepEqual(offenders, []);
});
