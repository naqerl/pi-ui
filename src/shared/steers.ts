import { toIsoTimestamp } from "./time.js";
import type { ChatMessage, QueuedMessage } from "./types.js";

export const PENDING_STEER_ORDER = Number.MAX_SAFE_INTEGER;

export interface PendingSteer extends QueuedMessage {
  dropped?: string;

  droppedOrder?: number;
}

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

export function droppedSteerMessage(steer: PendingSteer, reason: string): ChatMessage {
  return {
    id: `steer-dropped-${steer.id}`,
    role: "user",
    text: steer.text,
    timestamp: steer.createdAt,
    order: steer.droppedOrder ?? PENDING_STEER_ORDER,
    steer: true,
    isError: true,
    steerError: reason,
    ...(steer.key === undefined ? {} : { steerKey: steer.key }),
    ...(steer.attachments === undefined || steer.attachments.length === 0
      ? {}
      : { attachments: steer.attachments.map((id) => ({ id, mimeType: "image/*" })) }),
  };
}

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

export function dropSteer(
  steers: readonly PendingSteer[],
  id: string,
  reason: string,
  order?: number,
): PendingSteer[] {
  return steers.map((steer) =>
    steer.id === id && steer.dropped === undefined
      ? {
          ...steer,
          dropped: reason,
          ...(order === undefined ? {} : { droppedOrder: order }),
        }
      : steer,
  );
}

export function cancelSteer(steers: readonly PendingSteer[], id: string): PendingSteer[] {
  return steers.filter((steer) => steer.id !== id);
}

export function mergeLiveSteers(
  current: readonly PendingSteer[],
  next: readonly QueuedMessage[],
): PendingSteer[] {
  const held = new Map(current.map((steer) => [steer.id, steer]));
  const merged = next.map((steer): PendingSteer => {
    const previous = held.get(steer.id);
    return previous?.dropped === undefined
      ? steer
      : {
          ...steer,
          dropped: previous.dropped,
          ...(previous.droppedOrder === undefined ? {} : { droppedOrder: previous.droppedOrder }),
        };
  });
  const present = new Set(next.map((steer) => steer.id));
  for (const steer of current) {
    if (steer.dropped !== undefined && !present.has(steer.id)) merged.push(steer);
  }
  return merged;
}

export function consumeSteersInMessages(
  steers: readonly PendingSteer[],
  messages: readonly ChatMessage[],
): PendingSteer[] {
  const delivered = new Set(
    messages.flatMap((message) => (message.steerKey === undefined ? [] : [message.steerKey])),
  );
  return steers.filter((steer) => steer.key === undefined || !delivered.has(steer.key));
}

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

export function settledSteerIds(
  tracked: Iterable<string>,
  inbox: readonly { id: unknown; mode: string }[],
): string[] {
  const held = new Set(
    inbox.filter((item) => item.mode === "steer").map((item) => String(item.id)),
  );
  return [...tracked].filter((id) => !held.has(id));
}

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
  const storedCreatedAt =
    typeof data === "object" &&
    data !== null &&
    "createdAt" in data &&
    typeof (data as { createdAt: unknown }).createdAt === "string"
      ? (data as { createdAt: string }).createdAt
      : null;
  const createdAt = toIsoTimestamp(storedCreatedAt) ?? now.toISOString();
  return {
    id: String(item.id),
    text: contentText(item.content),
    createdAt,
    ...(key === undefined ? {} : { key }),
  };
}

export function steerKeyFromEntryData(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || !("key" in data)) return undefined;
  const key = (data as { key: unknown }).key;
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

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
