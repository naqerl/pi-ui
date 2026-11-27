import type { ActivityItem, ToolActivity } from "./types.js";

const TASK_TRANSITION_TOOLS = new Set(["task_working", "task_release", "task_done"]);

export const OPTIMISTIC_ACTIVITY_ORDER = Number.MAX_SAFE_INTEGER - 4;

export interface TaskToolResult {
  toolCallId: string;
  name: string;
  isError: boolean;
  activity: ActivityItem | undefined;
  timestamp?: string;
}

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
  } catch {}
  return undefined;
}

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
