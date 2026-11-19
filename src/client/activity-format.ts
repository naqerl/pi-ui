import type { ActivityItem, TokenSpend } from "../shared/types";

const ARGUMENT_KEYS = [
  "command",
  "path",
  "file_path",
  "file",
  "pattern",
  "query",
  "url",
  "description",
  "prompt",
  "text",
];

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function firstMeaningfulArgument(argumentsText: string): string {
  const fallback = oneLine(argumentsText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    return fallback.length > 72 ? `${fallback.slice(0, 71)}…` : fallback;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fallback.length > 72 ? `${fallback.slice(0, 71)}…` : fallback;
  }
  const record = parsed as Record<string, unknown>;
  for (const key of ARGUMENT_KEYS) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      const text = oneLine(value);
      return text.length > 72 ? `${text.slice(0, 71)}…` : text;
    }
  }
  for (const value of Object.values(record)) {
    if (typeof value === "string" && value.trim().length > 0) {
      const text = oneLine(value);
      return text.length > 72 ? `${text.slice(0, 71)}…` : text;
    }
  }
  return "";
}

export function activityLabel(activity: ActivityItem): string {
  if (activity.kind === "thinking") return "thinking";
  if (activity.kind === "job") return activity.notice.summary;
  const argument = firstMeaningfulArgument(activity.arguments);
  return argument.length > 0 ? `${activity.name} · ${argument}` : activity.name;
}

export function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "?";
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  const totalSeconds = Math.round(durationMs / 1_000);
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

/**
 * How long one activity row took. A completed tool records its own execution time; a completed
 * thinking block only has the instant its message was stored, so it runs from the previous row
 * in the same activity group. A row that is still running has no duration yet, and a row without
 * usable timing information keeps its current markup.
 */
export function rowDurationMs(
  activity: ActivityItem,
  previous: ActivityItem | undefined,
): number | undefined {
  if (activity.kind === "job") return undefined;
  if (activity.pending === true) return undefined;
  if (activity.kind === "tool") {
    if (activity.durationMs === undefined || !Number.isFinite(activity.durationMs)) {
      return undefined;
    }
    return Math.max(0, activity.durationMs);
  }
  const end = Date.parse(activity.timestamp);
  const start = previous === undefined ? Number.NaN : Date.parse(previous.timestamp);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return undefined;
  return Math.max(0, end - start);
}

export function activityStatus(activity: ActivityItem): string {
  if (activity.kind === "thinking") return "ok";
  if (activity.kind === "job") {
    return activity.notice.status === "failed" || activity.notice.status === "lost"
      ? "failed"
      : "ok";
  }
  if (activity.pending) return "running";
  return activity.isError ? "failed" : "ok";
}

export function activitySummary(activity: ActivityItem, includeDuration = true): string {
  if (activity.kind === "thinking") {
    return `${activity.name} · ${activity.text.length} chars`;
  }
  if (activity.kind === "job") return activity.notice.summary;
  if (activity.pending) return `${activity.name} · running`;
  if (!includeDuration) return `${activity.name} · ${activityStatus(activity)}`;
  return `${activity.name} · ${formatDuration(activity.durationMs)} · ${activityStatus(activity)}`;
}

/**
 * A row's span. A completed tool's timestamp is when its result arrived, so its start is
 * derived once from the duration the result records; a live row's timestamp is already its
 * start. That keeps one item's start stable when the live copy is replaced by its result.
 */
function activityWindow(item: ActivityItem): { start: number; end: number } | null {
  const stamp = Date.parse(item.timestamp);
  if (!Number.isFinite(stamp)) return null;
  if (item.kind !== "tool" || item.pending === true) return { start: stamp, end: stamp };
  if (item.durationMs === undefined || !Number.isFinite(item.durationMs)) {
    return { start: stamp, end: stamp };
  }
  return { start: stamp - Math.max(0, item.durationMs), end: stamp };
}

/** Earliest start a group can derive from its rows, before any live anchor is applied. */
export function groupStartMs(items: ActivityItem[]): number | undefined {
  let start = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const window = activityWindow(item);
    if (window !== null) start = Math.min(start, window.start);
  }
  return Number.isFinite(start) ? start : undefined;
}

/** Keep the earliest start a running group has shown, so replacing a row cannot step back. */
export function anchorGroupStart(previous: number | null, items: ActivityItem[]): number | null {
  const derived = groupStartMs(items);
  if (derived === undefined) return previous;
  return previous === null ? derived : Math.min(previous, derived);
}

function groupWallMs(
  items: ActivityItem[],
  running: boolean,
  now: number,
  startedAt?: number,
): number {
  let end = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const window = activityWindow(item);
    if (window !== null) end = Math.max(end, window.end);
  }
  const derivedStart = groupStartMs(items);
  if (derivedStart === undefined || !Number.isFinite(end)) return 0;
  const start =
    startedAt !== undefined && Number.isFinite(startedAt)
      ? Math.min(startedAt, derivedStart)
      : derivedStart;
  const finish = running ? Math.max(end, now) : end;
  return Math.max(0, finish - start);
}

function formatTokens(count: number): string {
  const value = Math.max(0, Math.round(count));
  if (value < 1000) return String(value);
  const thousands = value / 1000;
  const rounded = thousands >= 10 ? Math.round(thousands) : Math.round(thousands * 10) / 10;
  return `${rounded}k`;
}

function sumSpend(items: ActivityItem[], extra: TokenSpend | undefined): TokenSpend | undefined {
  let input = 0;
  let output = 0;
  let seen = false;
  for (const item of items) {
    if (item.kind === "job" || item.usage === undefined) continue;
    input += item.usage.input;
    output += item.usage.output;
    seen = true;
  }
  if (extra !== undefined) {
    input += extra.input;
    output += extra.output;
    seen = true;
  }
  return seen ? { input, output } : undefined;
}

/**
 * The pieces of a run's summary line: tool calls, tokens, and time. Thinking blocks are counted
 * in the group but not named here; `/activity` still lists them.
 */
export function groupSummaryParts(
  items: ActivityItem[],
  running: boolean,
  now = Date.now(),
  extra?: TokenSpend,
  startedAt?: number,
): string[] {
  const tools = items.filter((item) => item.kind === "tool");
  const parts: string[] = [];
  if (tools.length > 0) parts.push(`${tools.length} tool call${tools.length === 1 ? "" : "s"}`);
  const spend = sumSpend(items, extra);
  if (spend !== undefined) {
    parts.push(`${formatTokens(spend.input)} in`);
    parts.push(`${formatTokens(spend.output)} out`);
  }
  parts.push(formatDuration(groupWallMs(items, running, now, startedAt)));
  return parts;
}

export function groupSummary(
  items: ActivityItem[],
  running: boolean,
  now = Date.now(),
  extra?: TokenSpend,
): string {
  return groupSummaryParts(items, running, now, extra).join(" · ");
}
