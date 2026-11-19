# No comments

This repository does not contain comment tokens. That applies to TypeScript,
JSX, CSS, Dockerfiles, compose files, workflows and shell scripts. A `#!`
shebang line is the only exemption.

## Why

A comment is a second copy of the code's intent that nothing verifies. The same
intent has to live in a name, a type, a small function, a test or the commit
body, where the compiler and the test suite can keep it true. Removing the
second copy keeps the code legible as code rather than as prose beside code.

## What is banned

A lexical comment in the file's own grammar is banned:

- `//` and `/* ... */` in TypeScript, JavaScript and JSX, including `{/* ... */}`
- `/* ... */` in CSS
- `#` in Dockerfiles, compose files, workflows, TOML and shell scripts
- `<!-- ... -->` in HTML
- `--` and `--[[ ... ]]` in Lua

Text inside string literals, template literals, regular expressions, JSX text
and URLs is not a comment and must stay intact. Suppression comments such as
`biome-ignore`, `@ts-ignore`, `@ts-expect-error` and `eslint-disable` are
comments too, so the underlying finding has to be fixed instead.

## The gate

`scripts/no-comments.mjs` gets its file list from `git ls-files`, tokenizes each
supported language and exits non-zero when it finds a comment. It runs as part
of `npm run lint`, which is the Lint step in CI and part of `npm run gate`.
There is no allowlist, skip pragma, environment bypass or hand-maintained file
list. The TypeScript scanner separates comments from strings, templates,
regular expressions and JSX text; the other scanners do the same for their
languages.
