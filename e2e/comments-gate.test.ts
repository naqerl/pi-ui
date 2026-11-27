import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("../scripts/check-no-comments.mjs", import.meta.url));

function runChecker(directory: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolveExit, rejectExit) => {
    const child = spawn(process.execPath, [checker], { cwd: directory });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", rejectExit);
    child.on("close", (code) => resolveExit({ code, output }));
  });
}

async function withDirectory(
  t: { after: (fn: () => Promise<void>) => void },
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-comments-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await run(directory);
}

test("a YAML apostrophe does not hide the comment after a plain scalar", async (t) => {
  await withDirectory(t, async (directory) => {
    await writeFile(join(directory, "sample.yml"), "name: don't do this # real comment\n");
    const result = await runChecker(directory);
    assert.equal(result.code, 1);
    assert.match(result.output, /sample\.yml:1: # real comment/);
  });
});

test("YAML block scalars outside a run key keep hashes literal", async (t) => {
  await withDirectory(t, async (directory) => {
    await writeFile(
      join(directory, "sample.yml"),
      [
        'quoted: "a # not a comment"',
        "single: 'a # not a comment'",
        "plain: value#not-comment",
        "script: |",
        "  # block scalar content",
        '  echo "# also content"',
        "folded: >-",
        "  # folded scalar content",
        "  text",
        "tagged: !text |",
        "  # tagged block scalar content",
        "anchored: &anchor |",
        "  # anchored block scalar content",
        "",
      ].join("\n"),
    );
    const result = await runChecker(directory);
    assert.equal(result.code, 0);
    assert.match(result.output, /No comments found\./);
  });
});

test("a shell comment inside a run block scalar is a comment", async (t) => {
  await withDirectory(t, async (directory) => {
    await writeFile(
      join(directory, "sample.yml"),
      [
        "jobs:",
        "  test:",
        "    steps:",
        "      - run: |",
        "          # shell comment",
        "          echo done",
        "",
      ].join("\n"),
    );
    const result = await runChecker(directory);
    assert.equal(result.code, 1);
    assert.match(result.output, /sample\.yml:5: # shell comment/);
  });
});

test("a quoted hash inside a run block scalar stays literal", async (t) => {
  await withDirectory(t, async (directory) => {
    await writeFile(
      join(directory, "sample.yml"),
      [
        "jobs:",
        "  test:",
        "    steps:",
        "      - run: |",
        '          echo "# not a comment"',
        "          echo '# not a comment'",
        "",
      ].join("\n"),
    );
    const result = await runChecker(directory);
    assert.equal(result.code, 0);
    assert.match(result.output, /No comments found\./);
  });
});

test("a comment after a YAML block scalar is still a comment", async (t) => {
  await withDirectory(t, async (directory) => {
    await writeFile(
      join(directory, "sample.yml"),
      ["run: |", "  echo done", "tail: value # real comment", ""].join("\n"),
    );
    const result = await runChecker(directory);
    assert.equal(result.code, 1);
    assert.match(result.output, /sample\.yml:3: # real comment/);
  });
});

test("Docker parser directives are not comments", async (t) => {
  await withDirectory(t, async (directory) => {
    await writeFile(
      join(directory, "Dockerfile"),
      ["# syntax=docker/dockerfile:1", "# escape=`", "", "FROM node:24", ""].join("\n"),
    );
    const result = await runChecker(directory);
    assert.equal(result.code, 0);
    assert.match(result.output, /No comments found\./);
  });
});

test("a Docker comment is rejected", async (t) => {
  await withDirectory(t, async (directory) => {
    await writeFile(
      join(directory, "Dockerfile"),
      ["# syntax=docker/dockerfile:1", "", "# normal comment", "FROM node:24", ""].join("\n"),
    );
    const result = await runChecker(directory);
    assert.equal(result.code, 1);
    assert.match(result.output, /Dockerfile:3: # normal comment/);
  });
});
