import {
  AssistantEntry,
  type EntryRecord,
  type LiveState,
  type ToolSlot,
} from "@earendil-works/pi-durable";

export interface ToolSlotEndResult {
  output?: string;
  details?: unknown;
  isError?: boolean;
  durationMs?: number;
}

export type ToolSlotFrame =
  | { type: "start"; toolCallId: string; toolName: string; args: unknown }
  | {
      type: "end";
      toolCallId: string;
      toolName: string;
      args: unknown;
      entry?: EntryRecord;
      result?: ToolSlotEndResult;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isInterruptedSlot(slot: Pick<ToolSlot, "status"> | undefined): boolean {
  return (slot?.status as string | undefined) === "interrupted";
}

export function isTerminalSlot(slot: Pick<ToolSlot, "status">): boolean {
  return slot.status === "done" || isInterruptedSlot(slot);
}

function toolResultFromSlot(slot: ToolSlot): ToolSlotEndResult | undefined {
  if (slot.output === undefined && slot.details === undefined) return undefined;
  return {
    ...(slot.output === undefined ? {} : { output: slot.output }),
    ...(slot.details === undefined ? {} : { details: slot.details }),
    isError: (slot.diagnostics?.length ?? 0) > 0,
  };
}

function toolArguments(
  entries: readonly EntryRecord[],
): Map<string, { name: string; arguments: unknown }> {
  const calls = new Map<string, { name: string; arguments: unknown }>();
  for (const entry of entries) {
    if (!AssistantEntry.is(entry)) continue;
    const content = entry.model?.[0]?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isRecord(block) || block.type !== "toolCall" || typeof block.id !== "string") continue;
      calls.set(block.id, {
        name: typeof block.name === "string" ? block.name : "tool",
        arguments: block.arguments,
      });
    }
  }
  return calls;
}

function entryById(
  entries: readonly EntryRecord[],
  id: EntryRecord["id"] | undefined,
): EntryRecord | undefined {
  return id === undefined ? undefined : entries.find((entry) => entry.id === id);
}

function findToolResultEntry(
  entries: readonly EntryRecord[],
  toolCallId: string,
): EntryRecord | undefined {
  return entries.find((entry) => {
    const message = entry.model?.[0];
    return message !== undefined && "toolCallId" in message && message.toolCallId === toolCallId;
  });
}

export function diffToolSlots(
  entries: readonly EntryRecord[],
  previousLive: LiveState | undefined,
  live: LiveState | undefined,
): ToolSlotFrame[] {
  const previous = new Map((previousLive?.tools ?? []).map((slot) => [slot.callId, slot]));
  const current = new Map((live?.tools ?? []).map((slot) => [slot.callId, slot]));
  const argumentsByCall = toolArguments(entries);
  const frames: ToolSlotFrame[] = [];
  for (const slot of current.values()) {
    const before = previous.get(slot.callId);
    const args = argumentsByCall.get(slot.callId)?.arguments ?? {};
    if (isInterruptedSlot(slot)) {
      if (before !== undefined && !isTerminalSlot(before)) {
        const entry = entryById(entries, slot.entry);
        const result = toolResultFromSlot(slot);
        frames.push({
          type: "end",
          toolCallId: slot.callId,
          toolName: slot.name,
          args,
          ...(entry === undefined ? {} : { entry }),
          ...(result === undefined ? {} : { result }),
        });
      }
      continue;
    }
    if (slot.status === "running" && before?.status !== "running") {
      frames.push({
        type: "start",
        toolCallId: slot.callId,
        toolName: slot.name,
        args,
      });
    }
    if (slot.status === "done" && before?.status !== "done") {
      if (before?.status !== "running") {
        frames.push({
          type: "start",
          toolCallId: slot.callId,
          toolName: slot.name,
          args,
        });
      }
      const entry = entryById(entries, slot.entry);
      const result = toolResultFromSlot(slot);
      frames.push({
        type: "end",
        toolCallId: slot.callId,
        toolName: slot.name,
        args,
        ...(entry === undefined ? {} : { entry }),
        ...(result === undefined ? {} : { result }),
      });
    }
  }
  for (const before of previous.values()) {
    if (before.status === "done" || current.has(before.callId)) continue;
    const entry = findToolResultEntry(entries, before.callId);
    const result = toolResultFromSlot(before);
    frames.push({
      type: "end",
      toolCallId: before.callId,
      toolName: before.name,
      args: argumentsByCall.get(before.callId)?.arguments ?? {},
      ...(entry === undefined ? {} : { entry }),
      ...(result === undefined ? {} : { result }),
    });
  }
  return frames;
}
