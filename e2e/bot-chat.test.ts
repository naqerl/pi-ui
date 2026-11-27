import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BotChatEmpty } from "../src/client/BotChat.js";
import { Composer } from "../src/client/ChatView.js";
import { runErrorFrom } from "../src/client/use-bot-chat.js";
import type { ChatMessage } from "../src/shared/types.js";

test("an empty bot conversation renders its empty state, not a spinner", () => {
  const html = renderToStaticMarkup(
    createElement(BotChatEmpty, { name: "Job hunter", ready: true, hasRows: false }),
  );
  assert.match(html, /bot-chat-empty/);
  assert.match(html, /Ask Job hunter for something\./);
  assert.doesNotMatch(html, /bot-chat-loading/);
  assert.doesNotMatch(html, /spinner|animate-spin/i);
});

test("a bot snapshot that is still opening is not called empty", () => {
  const html = renderToStaticMarkup(
    createElement(BotChatEmpty, { name: "Job hunter", ready: false, hasRows: false }),
  );
  assert.match(html, /bot-chat-loading/);
  assert.doesNotMatch(html, /bot-chat-empty/);
});

test("a bot with rows renders neither placeholder", () => {
  const html = renderToStaticMarkup(
    createElement(BotChatEmpty, { name: "Job hunter", ready: true, hasRows: true }),
  );
  assert.equal(html, "");
});

test("a bot run error keeps its id and time while one failure is polled", () => {
  const row = (id: string, order: number, timestamp: string): ChatMessage => ({
    id,
    role: "assistant",
    text: "",
    timestamp,
    order,
  });
  const messages = [row("m1", 1, "2026-01-01T00:00:00.000Z")];
  const first = runErrorFrom({
    botId: "job-hunter",
    messages,
    running: false,
    error: "boom",
  });
  const polled = runErrorFrom({
    botId: "job-hunter",
    messages,
    running: false,
    error: "boom",
  });
  assert.equal(first?.id, polled?.id);
  assert.equal(first?.at, "2026-01-01T00:00:00.000Z");
  const retried = runErrorFrom({
    botId: "job-hunter",
    messages: [...messages, row("m2", 2, "2026-01-01T00:00:01.000Z")],
    running: false,
    error: "boom",
  });
  assert.notEqual(first?.id, retried?.id);
  assert.equal(retried?.at, "2026-01-01T00:00:01.000Z");
});

test("a running bot hides stop and steer instead of showing dead controls", () => {
  const html = renderToStaticMarkup(
    createElement(Composer, {
      tasksPage: false,
      running: true,
      runControls: false,
      send: async () => true,
      stop: async () => {},
      addTask: async () => true,
      projects: [],
      error: null,
      onDismissError: () => {},
      textareaRef: { current: null },
    }),
  );
  assert.doesNotMatch(html, /aria-label="Stop"/);
  assert.doesNotMatch(html, /aria-label="Steer"/);
  assert.match(html, /aria-label="Send"/);
});
