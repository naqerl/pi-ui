import assert from "node:assert/strict";
import { test } from "node:test";
import { findCommentRanges } from "../scripts/check-comments.mjs";

function count(file: string, text: string): number {
  return findCommentRanges(file, text).length;
}

test("rejects comments in every supported source type", () => {
  assert.equal(count("fixture.ts", "const value = 1; // comment\n"), 1);
  assert.equal(count("fixture.tsx", "const view = <div>{/* comment */}</div>;\n"), 1);
  assert.equal(count("fixture.css", "a { /* comment */ color: red; }\n"), 1);
  assert.equal(count("Dockerfile", "# comment\nFROM node:24\n"), 1);
  assert.equal(count("compose.yml", "services:\n  app:\n    # comment\n    image: x\n"), 1);
  assert.equal(
    count("workflow.yml", "jobs:\n  check:\n    # comment\n    runs-on: ubuntu-latest\n"),
    1,
  );
  assert.equal(count("fixture.sh", "#!/bin/sh\n# comment\necho hi\n"), 1);
});

test("ignores comment markers inside strings, regexes and JSX text", () => {
  const script = [
    'const url = "http://example.test";',
    "const pattern = /\\/\\*[/*]/.test(value);",
  ].join("\n");
  assert.equal(count("fixture.ts", script), 0);
  assert.equal(
    count(
      "fixture.tsx",
      "const a = <div>// not a comment</div>;\nconst b = <div>/* text */</div>;",
    ),
    0,
  );
  assert.equal(count("fixture.css", 'a { content: "/* not a comment */"; }\n'), 0);
  assert.equal(count("fixture.css", "a { background: url(http://example.test/x); }\n"), 0);
});

test("rejects comments after shell operators and in SCSS line comments", () => {
  assert.equal(count("fixture.sh", "echo hi;# comment\n"), 1);
  assert.equal(count("fixture.sh", "echo hi && # comment\n"), 1);
  assert.equal(count("fixture.sh", "echo hi || # comment\n"), 1);
  assert.equal(count("fixture.scss", "a { // comment\n  color: red;\n}\n"), 1);
  assert.equal(count("fixture.scss", "a { color: red; // comment\n}\n"), 1);
  assert.equal(count("fixture.scss", "a { background: url(http://example.test/x); }\n"), 0);
});

test("ignores comment markers inside shell heredocs", () => {
  const quoted = ["cat <<'EOF'", "# not a comment", "EOF", "echo hi", ""].join("\n");
  const tabbed = ["cat <<-EOF", "\t# not a comment", "\tEOF", "echo hi", ""].join("\n");
  assert.equal(count("fixture.sh", quoted), 0);
  assert.equal(count("fixture.sh", tabbed), 0);
  assert.equal(count("fixture.sh", "echo $" + "{value#prefix}\n"), 0);
});

test("ignores comment markers inside non-shell YAML block scalars", () => {
  const compose = [
    "services:",
    "  app:",
    "    message: |",
    "      # not a comment",
    "      echo hi",
    "    image: x",
    "",
  ].join("\n");
  const workflow = [
    "jobs:",
    "  check:",
    "    steps:",
    "      - name: |",
    "          # not a comment",
    "          echo hi",
    "",
  ].join("\n");
  assert.equal(count("compose.yml", compose), 0);
  assert.equal(count("workflow.yml", workflow), 0);
  assert.equal(count("compose.yml", 'key: "a # b"\n'), 0);
});

test("rejects shell comments in YAML run and command bodies", () => {
  const compose = [
    "services:",
    "  app:",
    "    command: |",
    "      # comment",
    "      echo hi",
    "",
  ].join("\n");
  const workflow = [
    "jobs:",
    "  check:",
    "    steps:",
    "      - run: |",
    "          # comment",
    "          echo hi",
    "",
  ].join("\n");
  const workflowHeredoc = [
    "jobs:",
    "  check:",
    "    steps:",
    "      - run: |",
    "          cat <<EOF",
    "          # data",
    "          EOF",
    "",
  ].join("\n");
  const entrypoint = [
    "services:",
    "  app:",
    "    entrypoint: |",
    "      # comment",
    "      /bin/sh",
    "",
  ].join("\n");
  const healthcheck = [
    "services:",
    "  app:",
    "    healthcheck:",
    "      test: |",
    "        # comment",
    "        curl -f http://example.test",
    "",
  ].join("\n");
  assert.equal(count("compose.yml", compose), 1);
  assert.equal(count("workflow.yml", workflow), 1);
  assert.equal(count("workflow.yml", workflowHeredoc), 0);
  assert.equal(count("compose.yml", entrypoint), 1);
  assert.equal(count("compose.yml", healthcheck), 1);
});

test("rejects shell comments in Docker RUN heredocs but not Docker COPY heredocs", () => {
  const run = ["RUN <<EOF", "# comment", "echo hi", "EOF", ""].join("\n");
  const copy = ["COPY <<EOF file.txt", "# data", "EOF", ""].join("\n");
  assert.equal(count("Dockerfile", run), 1);
  assert.equal(count("Dockerfile", copy), 0);
});

test("rejects inline and continued RUN comments and recognises Dockerfile names", () => {
  const continued = ["RUN echo hi \\", "    && echo bye # comment", ""].join("\n");
  const continuedComment = ["RUN echo hi \\", "    # comment", ""].join("\n");
  assert.equal(count("Dockerfile", "RUN echo hi # comment\n"), 1);
  assert.equal(count("Dockerfile", continued), 1);
  assert.equal(count("Dockerfile", continuedComment), 1);
  assert.equal(count("Containerfile", "RUN echo hi # comment\n"), 1);
  assert.equal(count("app.dockerfile", "RUN echo hi # comment\n"), 1);
  assert.equal(count("Dockerfile", "COPY a b # not a shell comment\n"), 0);
});

test("allows Docker parser directives but not Docker comments", () => {
  assert.equal(count("Dockerfile", "# syntax=docker/dockerfile:1\nFROM node:24\n"), 0);
  assert.equal(count("Dockerfile", 'RUN echo "# not a comment"\n'), 0);
});

test("ignores Lua long strings and rejects Lua comments", () => {
  assert.equal(count("fixture.lua", "local a = [[-- not a comment]]\n"), 0);
  assert.equal(count("fixture.lua", "local a = [=[-- not a comment]=]\n"), 0);
  assert.equal(count("fixture.lua", "local a = [[line\n-- not a comment\n]]\n"), 0);
  assert.equal(count("fixture.lua", "-- comment\nlocal a = 1\n"), 1);
  assert.equal(count("fixture.lua", "--[[ comment ]]\nlocal a = 1\n"), 1);
});
