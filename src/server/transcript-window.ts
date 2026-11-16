import type { ActivityItem, ChatMessage } from "../shared/types.js";

/** Messages the first load shows; older ones arrive as the reader scrolls up. */
export const TRANSCRIPT_PAGE_SIZE = 30;

export interface TranscriptWindow {
  messages: ChatMessage[];
  activity: ActivityItem[];
  /** Lowest order included. Everything at or above it is in the window. */
  from: number;
  /** True when older messages exist below `from`. */
  hasEarlier: boolean;
}

export interface WindowRequest {
  /** Return everything at or above this order (a reader that already holds older messages). */
  from?: number;
  /** Return the page that ends just below this order (scroll-up history). */
  before?: number;
  limit?: number;
}

/**
 * Cuts a transcript to a page of messages. A page always starts at a user message
 * (or the start of the transcript) so a run's activity is never split from its reply.
 */
export function windowTranscript(
  transcript: { messages: ChatMessage[]; activity: ActivityItem[] },
  request: WindowRequest = {},
): TranscriptWindow {
  const limit = Math.max(1, Math.floor(request.limit ?? TRANSCRIPT_PAGE_SIZE));
  // A transcript from the builder already holds display order; skipping the copy keeps
  // a poll on a long conversation from sorting tens of thousands of rows every time.
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
    // First index whose order is not below `end`. The page still walks back to
    // a user message; the search only finds the bounds.
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

/** First index whose `order` is greater than or equal to `target`. */
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

/** True when the items already ascend by `order`, so they need no copy and sort. */
function ordered(items: readonly { order: number }[]): boolean {
  for (let index = 1; index < items.length; index++) {
    if ((items[index - 1]?.order ?? 0) > (items[index]?.order ?? 0)) return false;
  }
  return true;
}

/** Reads `from`, `before` and `limit` query values; anything malformed is ignored. */
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
