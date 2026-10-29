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
  const messages = [...transcript.messages].sort((a, b) => a.order - b.order);
  const activity = [...transcript.activity].sort((a, b) => a.order - b.order);
  const end = request.before ?? Number.POSITIVE_INFINITY;

  let from: number;
  if (request.from !== undefined && request.before === undefined) {
    from = request.from;
  } else {
    const below = messages.filter((message) => message.order < end);
    if (below.length <= limit) {
      from = Number.NEGATIVE_INFINITY;
    } else {
      let start = below.length - limit;
      while (start > 0 && below[start]?.role !== "user") start--;
      from = start === 0 ? Number.NEGATIVE_INFINITY : (below[start]?.order ?? 0);
    }
  }

  const inWindow = (order: number) => order >= from && order < end;
  const firstOrder = Math.min(
    messages[0]?.order ?? Number.POSITIVE_INFINITY,
    activity[0]?.order ?? Number.POSITIVE_INFINITY,
  );
  return {
    messages: messages.filter((message) => inWindow(message.order)),
    activity: activity.filter((item) => inWindow(item.order)),
    from: Number.isFinite(from) ? from : 0,
    hasEarlier: Number.isFinite(from) && firstOrder < from,
  };
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
