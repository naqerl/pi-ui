import type { ActivityItem, ToolActivity } from "./types.js";

/** Task tools whose successful result changes the task's status and adds an activity row. */
const TASK_TRANSITION_TOOLS = new Set(["task_working", "task_release", "task_done"]);

/** The row an optimistic activity takes: after live tools, before the draft. */
export const OPTIMISTIC_ACTIVITY_ORDER = Number.MAX_SAFE_INTEGER - 4;

export interface TaskToolResult {
  toolCallId: string;
  name: string;
  isError: boolean;
  activity: ActivityItem | undefined;
  /** The tool call's start time, when the caller has it. */
  timestamp?: string;
}

/** The task id a task tool row names, from the structured field or its arguments. */
export function taskIdFromActivity(activity: ToolActivity): string | undefined {
  if (typeof activity.taskId === "string" && activity.taskId.length > 0) return activity.taskId;
  try {
    const parsed: unknown = JSON.parse(activity.arguments);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "id" in parsed &&
      typeof parsed.id === "string" &&
      parsed.id.length > 0
    ) {
      return parsed.id;
    }
  } catch {
    // A non-JSON argument string cannot name a task.
  }
  return undefined;
}

/**
 * Whether a held activity row is the same entry as a fresh one. The id is the first
 * identity; an optimistic row may have a local id until its transcript entry exists, so
 * the tool call id then the task, tool name and start/arguments reconcile that copy.
 */
export function sameActivity(left: ActivityItem, right: ActivityItem): boolean {
  if (left.id === right.id) return true;
  if (left.kind !== "tool" || right.kind !== "tool") return false;
  if (left.toolCallId !== undefined && right.toolCallId !== undefined) {
    return left.toolCallId === right.toolCallId;
  }
  const leftTask = taskIdFromActivity(left);
  const rightTask = taskIdFromActivity(right);
  if (leftTask === undefined || rightTask === undefined || leftTask !== rightTask) return false;
  return (
    left.name === right.name &&
    (left.timestamp === right.timestamp || left.arguments === right.arguments)
  );
}

/**
 * Applies one task tool result to the activity list. A successful working, release or
 * complete paints the row now, tagged with the task and call so the server's entry can
 * replace it by id (or by task/name/start) instead of adding a duplicate. A failed call
 * removes the row it painted, never leaving a status the ledger refused on screen.
 */
export function applyTaskToolResult(
  current: ActivityItem[],
  result: TaskToolResult,
): ActivityItem[] {
  const withoutCall = current.filter(
    (item) =>
      !(item.kind === "tool" && item.optimistic === true && item.toolCallId === result.toolCallId),
  );
  if (result.isError || !TASK_TRANSITION_TOOLS.has(result.name)) return withoutCall;
  if (result.activity?.kind !== "tool") return withoutCall;
  const taskId = taskIdFromActivity(result.activity);
  if (taskId === undefined) return withoutCall;
  const row: ToolActivity = {
    ...result.activity,
    id: result.activity.id.length > 0 ? result.activity.id : `optimistic-${result.toolCallId}`,
    order: OPTIMISTIC_ACTIVITY_ORDER,
    optimistic: true,
    taskId,
    toolCallId: result.toolCallId,
    timestamp: result.timestamp ?? result.activity.timestamp,
  };
  return [...withoutCall, row];
}
