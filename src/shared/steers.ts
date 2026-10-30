import type { ChatMessage, QueuedMessage } from "./types.js";

/** Pending steers sort after everything the run is still doing, oldest first. */
export const PENDING_STEER_ORDER = Number.MAX_SAFE_INTEGER;

/** A steer held by the server, and the reason if it was dropped before it was placed. */
export interface PendingSteer extends QueuedMessage {
  dropped?: string;
}

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
    ...(steer.key === undefined ? {} : { steerKey: steer.key }),
    ...(steer.attachments === undefined || steer.attachments.length === 0
      ? {}
      : { attachments: steer.attachments.map((id) => ({ id, mimeType: "image/*" })) }),
  };
}

/** The failed bubble a dropped steer leaves behind, carrying the reason it never arrived. */
export function droppedSteerMessage(steer: QueuedMessage, reason: string): ChatMessage {
  return {
    id: `steer-dropped-${steer.id}`,
    role: "user",
    text: steer.text,
    timestamp: steer.createdAt,
    order: PENDING_STEER_ORDER,
    steer: true,
    isError: true,
    steerError: reason,
    ...(steer.key === undefined ? {} : { steerKey: steer.key }),
    ...(steer.attachments === undefined || steer.attachments.length === 0
      ? {}
      : { attachments: steer.attachments.map((id) => ({ id, mimeType: "image/*" })) }),
  };
}

/** Removes a steer that entered the transcript, matched by its shared key or submission id. */
export function consumeSteer(
  steers: readonly PendingSteer[],
  key: string | undefined,
  id?: string,
): PendingSteer[] {
  return steers.filter(
    (steer) =>
      steer.id !== id && (key === undefined || steer.key === undefined || steer.key !== key),
  );
}

/** Marks a pending steer failed instead of letting it disappear without a reason. */
export function dropSteer(
  steers: readonly PendingSteer[],
  id: string,
  reason: string,
): PendingSteer[] {
  return steers.map((steer) =>
    steer.id === id && steer.dropped === undefined ? { ...steer, dropped: reason } : steer,
  );
}

/** A user cancelled a pending steer; it leaves no bubble and no notice. */
export function cancelSteer(steers: readonly PendingSteer[], id: string): PendingSteer[] {
  return steers.filter((steer) => steer.id !== id);
}

/**
 * Applies a live queue update. A dropped steer stays failed; a pending one is retired only after the
 * server stops listing it, which happens when its transcript entry has already been sent.
 */
export function mergeLiveSteers(
  current: readonly PendingSteer[],
  next: readonly QueuedMessage[],
): PendingSteer[] {
  const held = new Map(current.map((steer) => [steer.id, steer]));
  const merged = next.map((steer): PendingSteer => {
    const previous = held.get(steer.id);
    return previous?.dropped === undefined ? steer : { ...steer, dropped: previous.dropped };
  });
  const present = new Set(next.map((steer) => steer.id));
  for (const steer of current) {
    if (steer.dropped !== undefined && !present.has(steer.id)) merged.push(steer);
  }
  return merged;
}

/** Removes a steer once any transcript message carries its key, even after a failed copy was kept. */
export function consumeSteersInMessages(
  steers: readonly PendingSteer[],
  messages: readonly ChatMessage[],
): PendingSteer[] {
  const delivered = new Set(
    messages.flatMap((message) => (message.steerKey === undefined ? [] : [message.steerKey])),
  );
  return steers.filter((steer) => steer.key === undefined || !delivered.has(steer.key));
}

/** A snapshot is authoritative for pending steers; failed ones remain visible until a reload. */
export function rebuildSteersFromSnapshot(
  current: readonly PendingSteer[],
  snapshot: readonly QueuedMessage[],
): PendingSteer[] {
  const present = new Set(snapshot.map((steer) => steer.id));
  return [
    ...snapshot,
    ...current.filter((steer) => steer.dropped !== undefined && !present.has(steer.id)),
  ];
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

/** A steer read back from durable's inbox after a restart, including its entry key and timestamp. */
export function steerFromInboxItem(
  item: {
    id?: unknown;
    mode?: unknown;
    content?: unknown;
    entry?: { data?: unknown; kind?: unknown };
  },
  now = new Date(),
): PendingSteer | undefined {
  if (item.mode !== "steer" || item.id === undefined) return undefined;
  const data = item.entry?.data;
  const key = steerKeyFromEntryData(data);
  const createdAt =
    typeof data === "object" &&
    data !== null &&
    "createdAt" in data &&
    typeof (data as { createdAt: unknown }).createdAt === "string"
      ? (data as { createdAt: string }).createdAt
      : now.toISOString();
  return {
    id: String(item.id),
    text: contentText(item.content),
    createdAt,
    ...(key === undefined ? {} : { key }),
  };
}

/** The key a steer entry carries, so its pending bubble can be retired atomically. */
export function steerKeyFromEntryData(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || !("key" in data)) return undefined;
  const key = (data as { key: unknown }).key;
  return typeof key === "string" && key.length > 0 ? key : undefined;
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

/** A durable submission reason turned into something a person can act on. */
export function steerDropReason(reason: string, detail?: unknown): string {
  switch (reason) {
    case "aborted":
      return "The run stopped before the steer was delivered.";
    case "reset":
      return "The run reset its context before the steer was delivered.";
    case "no_model":
      return "No model was configured, so the steer was not delivered.";
    case "model_error":
      return "The run failed before the steer was delivered.";
    case "stale":
      return "The conversation changed before the steer was delivered.";
    default: {
      const extra =
        typeof detail === "string" && detail.trim().length > 0 ? ` (${detail.trim()})` : "";
      return `The steer was dropped by the server${extra}.`;
    }
  }
}
