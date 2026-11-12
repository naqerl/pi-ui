import { MCP_EVENTS_HEAD, parseMcpEventPayload } from "./notices.js";
import type { ChatMessage, QueuedMessage, QueuedNotice } from "./types.js";

/** The entry kind a queued follow-up is placed as, so its pending bubble can share its id. */
export const QUEUE_ENTRY_KIND = "ui.queue";

/** Pending queued messages sort after the running turn and its pending steers, oldest first. */
export const PENDING_QUEUE_ORDER = Number.MAX_SAFE_INTEGER;

const NOTICE_ICON_NAMES = [
  "job",
  "delegate",
  "mcp",
  "idle",
  "decision-approved",
  "decision-declined",
  "memory",
  "operator",
  "warning",
] as const satisfies readonly string[];

/** The icon a notice kind renders, both as a queued chip and once placed. */
export type NoticeIconName = (typeof NOTICE_ICON_NAMES)[number];

const NOTICE_ICON_NAME_SET: ReadonlySet<string> = new Set(NOTICE_ICON_NAMES);

/** True for a stored value this client knows how to render. */
export function isNoticeIconName(value: unknown): value is NoticeIconName {
  return typeof value === "string" && NOTICE_ICON_NAME_SET.has(value);
}

/**
 * The stable icon name for a machine notice kind. The server stores this name and the
 * client resolves it to a local component, so shared code never imports client icons.
 */
export function noticeIconName(kind: string, decision?: "approved" | "declined"): NoticeIconName {
  const name = kind.toLowerCase().replace(/^ui[.-]/, "");
  if (name.startsWith("mcp")) return "mcp";
  if (name.startsWith("job")) return "job";
  if (name.startsWith("delegate")) return "delegate";
  if (name.startsWith("idle")) return "idle";
  if (name.startsWith("task-decision") || name.startsWith("decision")) {
    return decision === "declined" ? "decision-declined" : "decision-approved";
  }
  if (name.startsWith("memory")) return "memory";
  if (name.startsWith("operator")) return "operator";
  return "warning";
}

/** Use a validated stored icon name, falling back to the kind's current icon. */
export function resolveNoticeIconName(
  name: string | undefined,
  kind: string,
  decision?: "approved" | "declined",
): NoticeIconName {
  return isNoticeIconName(name) ? name : noticeIconName(kind, decision);
}

/** The queued-chip form of the same kind-to-icon mapping. */
export const queuedNoticeIcon = noticeIconName;

/** Older name for the same mapping, kept for callers that predate the icon names. */
export const queuedNoticeGlyph = noticeIconName;

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

/** The shared key of a queued input or the notice entry it was placed as. */
export function entryQueueKeyFromData(data: unknown): string | undefined {
  if (typeof data === "object" && data !== null && "queueKey" in data) {
    const queueKey = (data as { queueKey: unknown }).queueKey;
    if (typeof queueKey === "string" && queueKey.length > 0) return queueKey;
  }
  return queueKeyFromEntryData(data);
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
  /** How many queued submissions this chip stands for. */
  count: number;
  ids: string[];
  /** How many MCP events those submissions carry; defaults to the submission count. */
  eventCount: number;
}

/** The number of events inside one MCP envelope, or undefined for another notice. */
export function queuedNoticeEventCount(item: QueuedMessage): number | undefined {
  if (!item.text.startsWith(MCP_EVENTS_HEAD)) return undefined;
  const newline = item.text.indexOf("\n");
  if (newline < 0) return undefined;
  const payload = parseMcpEventPayload(item.text.slice(newline + 1));
  return payload !== null && Array.isArray(payload.events) ? payload.events.length : undefined;
}

/**
 * Collapses consecutive queued machine notices of the same kind into one chip. A human
 * queued message breaks the run, and different notice kinds never share a chip. The
 * server's drain merge uses the same run rule, so a chip always stands for one delivery.
 */
export function mergeQueuedNotices(items: readonly QueuedMessage[]): QueuedMessageGroup[] {
  const groups: QueuedMessageGroup[] = [];
  for (const item of items) {
    const previous = groups[groups.length - 1];
    const kind = item.notice?.kind;
    const events = Math.max(1, queuedNoticeEventCount(item) ?? 1);
    if (kind !== undefined && previous !== undefined && previous.item.notice?.kind === kind) {
      previous.count += 1;
      previous.ids.push(item.id);
      previous.eventCount += events;
      continue;
    }
    groups.push({ item, count: 1, ids: [item.id], eventCount: events });
  }
  return groups;
}

/** Older name for the same grouping rule, kept for callers that predate the merge. */
export const groupQueuedMessages = mergeQueuedNotices;

/** The queued submission ids a pending chip's cancel button removes. */
export function queuedMessageIds(message: ChatMessage): string[] {
  if (message.queueIds !== undefined && message.queueIds.length > 0) return message.queueIds;
  return message.queueId === undefined ? [] : [message.queueId];
}

/** The chat bubble for a follow-up the server holds until the running turn ends. */
export function pendingQueuedMessage(item: QueuedMessage, group?: QueuedMessageGroup): ChatMessage {
  // One delivery can carry a burst. Show its event count, not just the one
  // submission that represents it. A grouped run adds the submissions together.
  const count = Math.max(1, group?.eventCount ?? queuedNoticeEventCount(item) ?? 1);
  return {
    id: queuedMessageId(item),
    role: "user",
    text: item.text,
    timestamp: item.createdAt,
    order: PENDING_QUEUE_ORDER,
    pendingQueue: true,
    queueId: item.id,
    ...(count <= 1 ? {} : { queueCount: count }),
    ...(group === undefined || group.count <= 1 ? {} : { queueIds: [...group.ids] }),
    ...(item.notice === undefined ? {} : { notice: item.notice }),
    ...(item.attachments === undefined || item.attachments.length === 0
      ? {}
      : { attachments: item.attachments.map((id) => ({ id, mimeType: "image/*" })) }),
  };
}
