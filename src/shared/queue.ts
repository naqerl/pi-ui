import type { ChatMessage, QueuedMessage, QueuedNotice } from "./types.js";

/** The entry kind a queued follow-up is placed as, so its pending bubble can share its id. */
export const QUEUE_ENTRY_KIND = "ui.queue";

/** Pending queued messages sort after the running turn and its pending steers, oldest first. */
export const PENDING_QUEUE_ORDER = Number.MAX_SAFE_INTEGER;

/** The glyph a machine notice of this entry kind shows, in the queue and once placed. */
export function queuedNoticeGlyph(kind: string): string {
  const name = kind.toLowerCase().replace(/^ui[.-]/, "");
  if (name.startsWith("mcp")) return "↯";
  if (name.startsWith("job")) return "⚙";
  if (name.startsWith("idle")) return "◷";
  if (name.startsWith("memory")) return "✎";
  if (name.startsWith("operator")) return "✉";
  return "⚠";
}

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

/** True for a queued notice marker, which has a short label instead of a full notice. */
export function isQueuedNotice(notice: ChatMessage["notice"]): notice is QueuedNotice {
  return (
    typeof notice === "object" &&
    notice !== null &&
    "label" in notice &&
    typeof notice.label === "string"
  );
}

/** One pending chip, with the ids it removes together when it stands for a burst. */
export interface QueuedMessageGroup {
  item: QueuedMessage;
  count: number;
  ids: string[];
}

/**
 * Collapses consecutive queued machine notices of the same kind into one chip. A human
 * queued message breaks the run, and different notice kinds never share a chip.
 */
export function groupQueuedMessages(items: readonly QueuedMessage[]): QueuedMessageGroup[] {
  const groups: QueuedMessageGroup[] = [];
  for (const item of items) {
    const previous = groups[groups.length - 1];
    const kind = item.notice?.kind;
    if (kind !== undefined && previous !== undefined && previous.item.notice?.kind === kind) {
      previous.count += 1;
      previous.ids.push(item.id);
      continue;
    }
    groups.push({ item, count: 1, ids: [item.id] });
  }
  return groups;
}

/** The queued submission ids a pending chip's cancel button removes. */
export function queuedMessageIds(message: ChatMessage): string[] {
  if (message.queueIds !== undefined && message.queueIds.length > 0) return message.queueIds;
  return message.queueId === undefined ? [] : [message.queueId];
}

/** The chat bubble for a follow-up the server holds until the running turn ends. */
export function pendingQueuedMessage(item: QueuedMessage, group?: QueuedMessageGroup): ChatMessage {
  return {
    id: queuedMessageId(item),
    role: "user",
    text: item.text,
    timestamp: item.createdAt,
    order: PENDING_QUEUE_ORDER,
    pendingQueue: true,
    queueId: item.id,
    ...(group === undefined || group.count <= 1
      ? {}
      : { queueCount: group.count, queueIds: [...group.ids] }),
    ...(item.notice === undefined ? {} : { notice: item.notice }),
    ...(item.attachments === undefined || item.attachments.length === 0
      ? {}
      : { attachments: item.attachments.map((id) => ({ id, mimeType: "image/*" })) }),
  };
}
