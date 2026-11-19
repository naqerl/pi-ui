import {
  groupQueuedMessages,
  PENDING_QUEUE_ORDER,
  pendingQueuedMessage,
  queuedMessageId,
} from "../shared/queue";
import { droppedSteerMessage, type PendingSteer, pendingSteerMessage } from "../shared/steers";
import type {
  ActivityItem,
  ChatMessage,
  MessageMode,
  QueuedMessage,
  ToolActivity,
} from "../shared/types";

export interface OptimisticSend {
  key: string;
  text: string;
  mode: MessageMode;
  createdAt: string;
  attachments: string[];
}

export type TimelineItem =
  | { kind: "message"; order: number; message: ChatMessage }
  | { kind: "activity"; order: number; activity: ActivityItem };

export function lastSettledOrder(
  messages: readonly ChatMessage[],
  activity: readonly ActivityItem[],
): number {
  let order = 0;
  for (const message of messages) {
    if (
      message.pendingSend === true ||
      message.pendingQueue === true ||
      message.pendingSteer === true ||
      message.notice !== undefined
    ) {
      continue;
    }
    order = Math.max(order, message.order);
  }
  for (const item of activity) {
    if (item.kind === "job" || item.pending === true) continue;
    if (item.kind === "tool" && item.optimistic === true) continue;
    order = Math.max(order, item.order);
  }
  return order;
}

export function optimisticId(item: OptimisticSend): string {
  return item.mode === "steer" ? `steer-pending-${item.key}` : `m-${item.key}`;
}

export function optimisticMessage(item: OptimisticSend): ChatMessage {
  if (item.mode === "steer") {
    return pendingSteerMessage({
      id: item.key,
      key: item.key,
      text: item.text,
      createdAt: item.createdAt,
      ...(item.attachments.length === 0 ? {} : { attachments: item.attachments }),
    });
  }
  return {
    id: optimisticId(item),
    role: "user",
    text: item.text,
    timestamp: item.createdAt,
    order: PENDING_QUEUE_ORDER,
    pendingSend: true,
    ...(item.attachments.length === 0
      ? {}
      : { attachments: item.attachments.map((id) => ({ id, mimeType: "image/*" })) }),
  };
}

export function confirmedOptimistic(item: OptimisticSend, message: ChatMessage): boolean {
  if (message.role !== "user") return false;
  if (message.id === optimisticId(item)) return true;
  return message.steerKey !== undefined && message.steerKey === item.key;
}

export interface ChatTimelineInput {
  messages: readonly ChatMessage[];
  activity: readonly ActivityItem[];
  liveTools: readonly ToolActivity[];
  draftText: string;
  draftThinking: string;
  draftThinkingAt: string | null;
  steers: readonly PendingSteer[];
  queue: readonly QueuedMessage[];
  optimistic: readonly OptimisticSend[];
}

export function buildChatTimeline(input: ChatTimelineInput): TimelineItem[] {
  const persistedActivityIds = new Set(input.activity.map((item) => item.id));
  const items: TimelineItem[] = [
    ...input.messages.map((message) => ({
      kind: "message" as const,
      order: message.order,
      message,
    })),
    ...input.activity.map((item) => ({
      kind: "activity" as const,
      order: item.order,
      activity: item,
    })),
    ...input.liveTools
      .filter((item) => !persistedActivityIds.has(item.id))
      .map((item) => ({
        kind: "activity" as const,
        order: item.order,
        activity: item,
      })),
  ];

  if (input.draftThinking.length > 0) {
    items.push({
      kind: "activity",
      order: Number.MAX_SAFE_INTEGER - 3,
      activity: {
        kind: "thinking",
        id: "draft-thinking",
        name: "thinking",
        text: input.draftThinking,
        timestamp: input.draftThinkingAt ?? new Date().toISOString(),
        order: Number.MAX_SAFE_INTEGER - 3,
        pending: true,
      },
    });
  }

  if (input.draftText.length > 0) {
    items.push({
      kind: "message",
      order: Number.MAX_SAFE_INTEGER - 2,
      message: {
        id: "draft-assistant",
        role: "assistant",
        text: input.draftText,
        timestamp: new Date().toISOString(),
        order: Number.MAX_SAFE_INTEGER - 2,
      },
    });
  }

  for (const steer of input.steers) {
    const message =
      steer.dropped === undefined
        ? pendingSteerMessage(steer)
        : droppedSteerMessage(steer, steer.dropped);
    items.push({ kind: "message", order: message.order, message });
  }

  const heldIds = new Set(input.messages.map((message) => message.id));
  const pending = input.queue.filter(
    (item) => item.hidden !== true && !heldIds.has(queuedMessageId(item)),
  );
  for (const group of groupQueuedMessages(pending)) {
    const message = pendingQueuedMessage(group.item, group);
    items.push({ kind: "message", order: message.order, message });
  }

  const queuedIds = new Set(input.queue.map(queuedMessageId));
  const pendingSteerKeys = new Set(
    input.steers.flatMap((steer) => (steer.key === undefined ? [] : [steer.key])),
  );
  for (const item of input.optimistic) {
    if (
      input.messages.some((message) => confirmedOptimistic(item, message)) ||
      queuedIds.has(optimisticId(item)) ||
      (item.mode === "steer" && pendingSteerKeys.has(item.key))
    ) {
      continue;
    }
    const message = optimisticMessage(item);
    items.push({ kind: "message", order: message.order, message });
  }

  return items.sort((a, b) => a.order - b.order);
}
