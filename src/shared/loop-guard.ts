import type { ChatMessage } from "./types.js";

const PROVIDER_LOOP_GUARD = new RegExp(
  [
    "stop looping replies",
    "\\bloop(?:ing)? detected\\b",
    "\\brepeated tool calls? detected\\b",
    "\\bdetected (?:a )?(?:repeating|repeated) tool call",
    "\\b(?:repeated|repeating) tool [`\"'][\\w.:-]+[`\"']",
  ].join("|"),
  "i",
);

const NOT_A_TOOL = new Set([
  "call",
  "calls",
  "was",
  "is",
  "are",
  "repeated",
  "repetition",
  "loop",
  "use",
  "result",
  "results",
]);

export function isProviderLoopGuard(text: string): boolean {
  return PROVIDER_LOOP_GUARD.test(text);
}

export function annotateProviderLoopGuard(text: string): string {
  const quoted = /\btool\s+[`"']([a-z][\w.:-]*)[`"']/i.exec(text)?.[1];
  const named = /\btool\s+([a-z][\w.:-]*[a-z0-9])/i.exec(text)?.[1];
  const tool =
    quoted ?? (named !== undefined && !NOT_A_TOOL.has(named.toLowerCase()) ? named : undefined);
  const count = /\b(\d+)\s+(?:identical|consecutive|repeated|times)\b/i.exec(text)?.[1];
  const subject = tool === undefined ? "the same tool call" : `the ${tool} tool call`;
  const repetition = count === undefined ? "kept repeating" : `repeated ${count} times in a row`;
  return (
    `pi-ui stopped this run: ${subject} ${repetition} without making progress. ` +
    "Send a message to continue."
  );
}

export function loopGuardText(text: string): string {
  return isProviderLoopGuard(text) ? annotateProviderLoopGuard(text) : text;
}

export function rephraseLoopGuardMessage(message: ChatMessage): ChatMessage {
  if (message.role !== "assistant" || message.isError !== true) return message;
  const text = loopGuardText(message.text);
  return text === message.text ? message : { ...message, text };
}
