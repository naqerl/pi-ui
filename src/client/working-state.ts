/** The draft is thinking while it has reasoning text and no answer text yet. */
export function isThinking(draftThinking: string, draftText: string): boolean {
  return draftThinking.trim().length > 0 && draftText.trim().length === 0;
}

/** The dock's one word for an active run. */
export function workingWord(thinking: boolean): "thinking" | "working" {
  return thinking ? "thinking" : "working";
}

/** The tasks page's own word; it never borrows the chat's working/thinking. */
export type TaskStatusWord = "planning" | "idle";

/**
 * The tasks page's own status word. Nothing is shown when no task is open:
 * the status belongs to the surface, not to the app.
 */
export function taskStatusWord(
  openTaskId: string | null,
  livePlanRun: boolean,
): TaskStatusWord | null {
  if (openTaskId === null) return null;
  return livePlanRun ? "planning" : "idle";
}
