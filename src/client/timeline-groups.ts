import type { ActivityItem, ChatMessage } from "../shared/types";
import type { TimelineItem } from "./use-chat";

export type TimelineGroup =
  | { kind: "message"; key: string; message: ChatMessage }
  | { kind: "activity"; key: string; items: ActivityItem[] };

/**
 * Group contiguous activity between messages, using only the timeline order.
 * Keys are positional (the preceding message plus the activity run after it) so
 * a live item being replaced by its persisted entry does not remount the group
 * or reset its expansion state.
 */
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
