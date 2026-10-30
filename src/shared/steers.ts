import type { ChatMessage, QueuedMessage } from "./types.js";

/** Pending steers sort after everything the run is still doing, oldest first. */
export const PENDING_STEER_ORDER = Number.MAX_SAFE_INTEGER;

/** The chat bubble for a steer the run has not reached yet. */
export function pendingSteerMessage(steer: QueuedMessage): ChatMessage {
  return {
    id: `steer-pending-${steer.id}`,
    role: "user",
    text: steer.text,
    timestamp: steer.createdAt,
    order: PENDING_STEER_ORDER,
    steer: true,
    pendingSteer: true,
    ...(steer.attachments === undefined || steer.attachments.length === 0
      ? {}
      : { attachments: steer.attachments.map((id) => ({ id, mimeType: "image/*" })) }),
  };
}

/** Ids of tracked steers durable's inbox no longer holds: they were placed or withdrawn. */
export function settledSteerIds(
  tracked: Iterable<string>,
  inbox: readonly { id: unknown; mode: string }[],
): string[] {
  const held = new Set(
    inbox.filter((item) => item.mode === "steer").map((item) => String(item.id)),
  );
  return [...tracked].filter((id) => !held.has(id));
}

/** The text of a user message's content: a string, or its text parts joined by newlines. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      typeof part === "object" &&
      part !== null &&
      part.type === "text" &&
      typeof part.text === "string"
        ? [part.text as string]
        : [],
    )
    .join("\n");
}
