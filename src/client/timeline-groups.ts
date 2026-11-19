import type { ActivityItem, ChatMessage } from "../shared/types";
import type { TimelineItem } from "./use-chat";

export type TimelineGroup =
  | { kind: "message"; key: string; message: ChatMessage }
  | { kind: "activity"; key: string; items: ActivityItem[] };

export function groupTimeline(timeline: TimelineItem[]): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  let activity: ActivityItem[] | null = null;
  let previousKey = "start";
  let activityIndex = 0;

  const flush = () => {
    if (activity === null || activity.length === 0) return;
    groups.push({
      kind: "activity",
      key: `activity-${previousKey}-${activityIndex}`,
      items: activity,
    });
    activity = null;
    activityIndex += 1;
  };

  for (const item of timeline) {
    if (item.kind === "message") {
      flush();
      previousKey = `message-${item.message.id}`;
      activityIndex = 0;
      groups.push({ kind: "message", key: previousKey, message: item.message });
    } else {
      activity ??= [];
      activity.push(item.activity);
    }
  }
  flush();
  return groups;
}

export function lastUserMessageOrder(timeline: TimelineItem[]): number {
  let order = Number.NEGATIVE_INFINITY;
  for (const item of timeline) {
    if (
      item.kind === "message" &&
      item.message.role === "user" &&
      !item.message.pendingSteer &&
      !item.message.pendingQueue &&
      !item.message.pendingSend
    ) {
      order = Math.max(order, item.message.order);
    }
  }
  return order;
}

export function liveActivityGroupKey(
  timeline: TimelineItem[],
  groups: TimelineGroup[],
  running: boolean,
): string | undefined {
  if (!running) return undefined;
  const lastUserOrder = lastUserMessageOrder(timeline);
  for (let index = groups.length - 1; index >= 0; index--) {
    const group = groups[index];
    if (group.kind === "activity" && group.items[0].order > lastUserOrder) {
      return group.key;
    }
  }
  return undefined;
}
