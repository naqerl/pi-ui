import type { ChatMessage, QueuedMessage } from "./types.js";

/** The entry kind a queued follow-up is placed as, so its pending bubble can share its id. */
export const QUEUE_ENTRY_KIND = "ui.queue";

/** Pending queued messages sort after the running turn and its pending steers, oldest first. */
export const PENDING_QUEUE_ORDER = Number.MAX_SAFE_INTEGER;

/** The stable key of a queued message. Older snapshots may not carry one. */
export function queuedKey(item: QueuedMessage): string {
  return item.key ?? `q-${item.id}`;
}

/** The id the transcript entry carries once the queued message is placed. */
export function queuedMessageId(item: QueuedMessage): string {
  return `m-${queuedKey(item)}`;
}

/** The key a queued entry carries, so a pending bubble and its real message share an id. */
export function queueKeyFromEntryData(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || !("key" in data)) return undefined;
  const key = (data as { key: unknown }).key;
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

/** The chat bubble for a follow-up the server holds until the running turn ends. */
export function pendingQueuedMessage(item: QueuedMessage): ChatMessage {
  return {
    id: queuedMessageId(item),
    role: "user",
    text: item.text,
    timestamp: item.createdAt,
    order: PENDING_QUEUE_ORDER,
    pendingQueue: true,
    queueId: item.id,
    ...(item.attachments === undefined || item.attachments.length === 0
      ? {}
      : { attachments: item.attachments.map((id) => ({ id, mimeType: "image/*" })) }),
  };
}
