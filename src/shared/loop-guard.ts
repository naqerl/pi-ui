import type { ChatMessage } from "./types.js";

/**
 * The provider's own loop guard. Its message is a sentence about a provider setting —
 * "Settings › Models › Replies › Stop looping replies" — which is a control in the
 * provider's web panel and does not exist in pi-ui, so it can never be shown as it is.
 */
const PROVIDER_LOOP_GUARD = new RegExp(
  [
    // The provider's own sentence, in the form its error carries it.
    "stop looping replies",
    // The guard firing, as a provider phrases an error: never prose such as "the
    // agent stops repeating tool calls", which is a plan answer and not a stop.
    "\\bloop(?:ing)? detected\\b",
    "\\brepeated tool calls? detected\\b",
    "\\bdetected (?:a )?(?:repeating|repeated) tool call",
    "\\b(?:repeated|repeating) tool [`\"'][\\w.:-]+[`\"']",
  ].join("|"),
  "i",
);

/** Words that follow "tool" in provider prose but are not tool names. */
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

/**
 * Replace a provider's loop-guard text with pi-ui's own sentence: the provider's
 * message tells the operator to change a setting in a UI that does not exist here,
 * and names neither the tool nor how to continue the conversation.
 */
export function annotateProviderLoopGuard(text: string): string {
  const quoted = /\btool\s+[`"']([a-z][\w.:-]*)[`"']/i.exec(text)?.[1];
  // End on a letter or digit, so "tool calls." yields "calls" and not "calls.".
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

/**
 * The text a row shows for a model failure: verbatim unless it is the provider's loop
 * guard, in which case it is pi-ui's own sentence. Both lanes render rows from the one
 * transcript builder, so the rewrite lives here rather than in either lane.
 */
export function loopGuardText(text: string): string {
  return isProviderLoopGuard(text) ? annotateProviderLoopGuard(text) : text;
}

/**
 * The same rewrite for a row that is already a message. Only a failed row can carry the
 * provider's guard, so an ordinary answer is never rewritten — even one that happens to
 * talk about repeating tool calls.
 */
export function rephraseLoopGuardMessage(message: ChatMessage): ChatMessage {
  if (message.role !== "assistant" || message.isError !== true) return message;
  const text = loopGuardText(message.text);
  return text === message.text ? message : { ...message, text };
}
