import type { ActivityItem, ChatMessage } from "../shared/types.js";

export const TRANSCRIPT_PAGE_SIZE = 30;

export interface TranscriptWindow {
  messages: ChatMessage[];
  activity: ActivityItem[];

  from: number;

  hasEarlier: boolean;
}

export interface WindowRequest {
  from?: number;

  before?: number;
  limit?: number;
}

export function windowTranscript(
  transcript: { messages: ChatMessage[]; activity: ActivityItem[] },
  request: WindowRequest = {},
): TranscriptWindow {
  const limit = Math.max(1, Math.floor(request.limit ?? TRANSCRIPT_PAGE_SIZE));

  const messages = ordered(transcript.messages)
    ? transcript.messages
    : [...transcript.messages].sort((a, b) => a.order - b.order);
  const activity = ordered(transcript.activity)
    ? transcript.activity
    : [...transcript.activity].sort((a, b) => a.order - b.order);
  const end = request.before ?? Number.POSITIVE_INFINITY;

  let from: number;
  if (request.from !== undefined && request.before === undefined) {
    from = request.from;
  } else {
    const endIndex = lowerBound(messages, end);
    if (endIndex <= limit) {
      from = Number.NEGATIVE_INFINITY;
    } else {
      let start = endIndex - limit;
      while (start > 0 && messages[start]?.role !== "user") start--;
      from = start === 0 ? Number.NEGATIVE_INFINITY : (messages[start]?.order ?? 0);
    }
  }

  const firstOrder = Math.min(
    messages[0]?.order ?? Number.POSITIVE_INFINITY,
    activity[0]?.order ?? Number.POSITIVE_INFINITY,
  );
  return {
    messages: messages.slice(lowerBound(messages, from), lowerBound(messages, end)),
    activity: activity.slice(lowerBound(activity, from), lowerBound(activity, end)),
    from: Number.isFinite(from) ? from : 0,
    hasEarlier: Number.isFinite(from) && firstOrder < from,
  };
}

function lowerBound(items: readonly { order: number }[], target: number): number {
  let low = 0;
  let high = items.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((items[middle]?.order ?? 0) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

function ordered(items: readonly { order: number }[]): boolean {
  for (let index = 1; index < items.length; index++) {
    if ((items[index - 1]?.order ?? 0) > (items[index]?.order ?? 0)) return false;
  }
  return true;
}

export function windowRequestFromQuery(query: Record<string, string | undefined>): WindowRequest {
  const number = (value: string | undefined) => {
    if (value === undefined || value.trim() === "") return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const request: WindowRequest = {};
  const from = number(query.from);
  const before = number(query.before);
  const limit = number(query.limit);
  if (from !== undefined) request.from = from;
  if (before !== undefined) request.before = before;
  if (limit !== undefined && limit > 0) request.limit = Math.min(limit, 500);
  return request;
}
