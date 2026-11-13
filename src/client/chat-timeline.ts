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

/** The optimistic copy of a send that is still waiting for the server to confirm it. */
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

/** The id a pending send already has, matching the queued item the server will confirm. */
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

/** A confirmed message retires the optimistic copy it replaces by the id/key it shares. */
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
  /** When the current thinking draft started; a stable timestamp keeps its row from remounting. */
  draftThinkingAt: string | null;
  steers: readonly PendingSteer[];
  queue: readonly QueuedMessage[];
  optimistic: readonly OptimisticSend[];
}

/**
 * The one transcript model both conversations render. The plan chat and the main chat
 * feed their own state in here and get the same row kinds for the same entries; only
 * the tool set and system prompt differ on the server.
 */
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

  // Steers the run has not reached go below everything it is still doing; once delivered, the
  // snapshot has them where they entered the conversation.
  for (const steer of input.steers) {
    const message =
      steer.dropped === undefined
        ? pendingSteerMessage(steer)
        : droppedSteerMessage(steer, steer.dropped);
    items.push({ kind: "message", order: message.order, message });
  }

  // Follow-ups wait for the whole turn, so they sit below the live draft and pending steers.
  // A placed message already in `messages` owns the id; only its pending copy is dropped.
  const heldIds = new Set(input.messages.map((message) => message.id));
  // Drop any queued copy already placed before grouping, so a burst whose first
  // notice just landed does not hide the notices still waiting behind it.
  const pending = input.queue.filter(
    (item) => item.hidden !== true && !heldIds.has(queuedMessageId(item)),
  );
  for (const group of groupQueuedMessages(pending)) {
    const message = pendingQueuedMessage(group.item, group);
    items.push({ kind: "message", order: message.order, message });
  }

  // A send paints here before the request leaves. Once the server's queue or a placed
  // message carries the same id/key, the optimistic copy is skipped instead of doubled.
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
