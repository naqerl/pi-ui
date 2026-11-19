import { MCP_EVENTS_HEAD, parseMcpEventPayload } from "./notices.js";
import type { ChatMessage, QueuedMessage, QueuedNotice } from "./types.js";

export const QUEUE_ENTRY_KIND = "ui.queue";

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

export type NoticeIconName = (typeof NOTICE_ICON_NAMES)[number];

const NOTICE_ICON_NAME_SET: ReadonlySet<string> = new Set(NOTICE_ICON_NAMES);

export function isNoticeIconName(value: unknown): value is NoticeIconName {
  return typeof value === "string" && NOTICE_ICON_NAME_SET.has(value);
}

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

export function resolveNoticeIconName(
  name: string | undefined,
  kind: string,
  decision?: "approved" | "declined",
): NoticeIconName {
  return isNoticeIconName(name) ? name : noticeIconName(kind, decision);
}

export const queuedNoticeIcon = noticeIconName;

export const queuedNoticeGlyph = noticeIconName;

export function queuedKey(item: QueuedMessage): string {
  return item.key ?? `q-${item.id}`;
}

export function queuedMessageId(item: QueuedMessage): string {
  return `m-${queuedKey(item)}`;
}

export function queueKeyFromEntryData(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || !("key" in data)) return undefined;
  const key = (data as { key: unknown }).key;
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

export function entryQueueKeyFromData(data: unknown): string | undefined {
  if (typeof data === "object" && data !== null && "queueKey" in data) {
    const queueKey = (data as { queueKey: unknown }).queueKey;
    if (typeof queueKey === "string" && queueKey.length > 0) return queueKey;
  }
  return queueKeyFromEntryData(data);
}

export function isQueuedNotice(notice: ChatMessage["notice"]): notice is QueuedNotice {
  return (
    typeof notice === "object" &&
    notice !== null &&
    "label" in notice &&
    typeof notice.label === "string"
  );
}

export interface QueuedMessageGroup {
  item: QueuedMessage;

  count: number;
  ids: string[];

  eventCount: number;
}

export function queuedNoticeEventCount(item: QueuedMessage): number | undefined {
  if (!item.text.startsWith(MCP_EVENTS_HEAD)) return undefined;
  const newline = item.text.indexOf("\n");
  if (newline < 0) return undefined;
  const payload = parseMcpEventPayload(item.text.slice(newline + 1));
  return payload !== null && Array.isArray(payload.events) ? payload.events.length : undefined;
}

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

export const groupQueuedMessages = mergeQueuedNotices;

export function queuedMessageIds(message: ChatMessage): string[] {
  if (message.queueIds !== undefined && message.queueIds.length > 0) return message.queueIds;
  return message.queueId === undefined ? [] : [message.queueId];
}

export function pendingQueuedMessage(item: QueuedMessage, group?: QueuedMessageGroup): ChatMessage {
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
