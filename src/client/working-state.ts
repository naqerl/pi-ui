export function isThinking(draftThinking: string, draftText: string): boolean {
  return draftThinking.trim().length > 0 && draftText.trim().length === 0;
}

export function workingWord(thinking: boolean): "thinking" | "working" {
  return thinking ? "thinking" : "working";
}

export type TaskStatusWord = "planning" | "idle";

export function taskStatusWord(
  openTaskId: string | null,
  livePlanRun: boolean,
): TaskStatusWord | null {
  if (openTaskId === null) return null;
  return livePlanRun ? "planning" : "idle";
}
