import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const source = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("an assistant message never pushes: the chat service has no push call", async () => {
  const chat = await source("src/server/chat-service.ts");
  assert.doesNotMatch(chat, /\bnotify\s*\(/);
});

test("job and MCP notices stay in the chat and never push", async () => {
  const index = await source("src/server/index.ts");
  assert.doesNotMatch(index, /pushJobNotice/);
  assert.doesNotMatch(index, /tag:\s*"mcp-event"/);
  assert.doesNotMatch(index, /tag:\s*`job-/);
  assert.doesNotMatch(index, /\b(?:void|await)\s+notify\s*\(/);
});

test("an interrupted run records a note without a push", async () => {
  const session = await source("src/server/session.ts");
  assert.doesNotMatch(session, /tag:\s*"run-interrupted"/);
  assert.doesNotMatch(session, /\b(?:void|await)\s+notify\s*\(/);
});
