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

export function activitySummary(activity: ActivityItem): string {
  if (activity.kind === "thinking") {
    return `${activity.name} · ${activity.text.length} chars`;
  }
  if (activity.kind === "job") return activity.notice.summary;
  if (activity.pending) return `${activity.name} · running`;
  return `${activity.name} · ${formatDuration(activity.durationMs)} · ${activityStatus(activity)}`;
}

function itemStart(activity: ActivityItem): number | undefined {
  const stamp = Date.parse(activity.timestamp);
  if (!Number.isFinite(stamp)) return undefined;
  // A finished tool's timestamp is when its result arrived, so its work began one
  // duration earlier. A pending row's timestamp is already its start.
  if (activity.kind === "tool" && activity.pending !== true) {
    const duration = activity.durationMs;
    if (duration !== undefined && Number.isFinite(duration) && duration >= 0) {
      return stamp - duration;
    }
  }
  return stamp;
}

/**
 * The earliest start a group has shown. A caller keeps the previous value so a row that
 * is replaced by its result, or repeated by a reconnect with a fresh timestamp, cannot
 * move the group's clock backwards.
 */
export function activityGroupStart(items: ActivityItem[], previous?: number): number | undefined {
  let start = previous;
  for (const item of items) {
    const value = itemStart(item);
    if (value !== undefined && (start === undefined || value < start)) start = value;
  }
  return start;
}

function groupWallMs(
  items: ActivityItem[],
  running: boolean,
  now: number,
  startAt?: number,
): number {
  const start = startAt ?? activityGroupStart(items);
  if (start === undefined) return 0;
  if (running) return Math.max(0, now - start);
  let end = start;
  for (const item of items) {
    const stamp = Date.parse(item.timestamp);
    if (Number.isFinite(stamp)) end = Math.max(end, stamp);
  }
  const span = end - start;
  if (span > 0) return span;
  let sum = 0;
  for (const item of items) {
    if (item.kind === "tool" && item.durationMs !== undefined) sum += item.durationMs;
  }
  return sum;
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
  startAt?: number,
): string[] {
  const tools = items.filter((item) => item.kind === "tool");
  const parts: string[] = [];
  if (tools.length > 0) parts.push(`${tools.length} tool call${tools.length === 1 ? "" : "s"}`);
  const spend = sumSpend(items, extra);
  if (spend !== undefined) {
    parts.push(`${formatTokens(spend.input)} in`);
    parts.push(`${formatTokens(spend.output)} out`);
  }
  parts.push(formatDuration(groupWallMs(items, running, now, startAt)));
  return parts;
}

export function groupSummary(
  items: ActivityItem[],
  running: boolean,
  now = Date.now(),
  extra?: TokenSpend,
  startAt?: number,
): string {
  return groupSummaryParts(items, running, now, extra, startAt).join(" · ");
}
