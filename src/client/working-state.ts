/** The draft is thinking while it has reasoning text and no answer text yet. */
export function isThinking(draftThinking: string, draftText: string): boolean {
  return draftThinking.trim().length > 0 && draftText.trim().length === 0;
}

/** The dock's one word for an active run. */
export function workingWord(thinking: boolean): "thinking" | "working" {
  return thinking ? "thinking" : "working";
}
