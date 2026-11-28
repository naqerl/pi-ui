/** One message held for reply on one chat surface. */
export interface ChatReply {
  /** The message the operator chose Reply on. */
  messageId: string;
  /** The message source, kept so a later send still quotes the chosen row. */
  text: string;
  /** The one-line start shown in the reply bar and used as the quote. */
  excerpt: string;
}

/** The first non-empty line of a message, without a leading blockquote marker. */
export function replyExcerpt(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    return trimmed.replace(/^>\s?/, "");
  }
  return "";
}

/** The markdown blockquote one reply contributes to the outgoing draft. */
export function replyQuote(excerpt: string): string {
  return `> ${excerpt}`;
}

/** Join the quoted start and the draft exactly as the chat sends them. */
export function composeReplyText(excerpt: string, draft: string): string {
  return `${replyQuote(excerpt)}\n\n${draft}`;
}

export interface SplitQuote {
  quote: string;
  body: string;
}

/**
 * Split one or more leading `>` lines from the body so a user bubble can paint the quote
 * above the text. Hand-typed markdown gets the same treatment; there is no separate marker.
 */
export function splitLeadingQuote(text: string): SplitQuote | null {
  const lines = text.split(/\r?\n/);
  const quote: string[] = [];
  let index = 0;
  while (index < lines.length && /^>\s?/.test(lines[index] ?? "")) {
    quote.push((lines[index] ?? "").replace(/^>\s?/, ""));
    index += 1;
  }
  if (quote.length === 0) return null;
  if (index < lines.length && (lines[index] ?? "").trim() === "") index += 1;
  return { quote: quote.join("\n"), body: lines.slice(index).join("\n") };
}
