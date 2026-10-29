import type { ActivityItem } from "../shared/types";

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
  const argument = firstMeaningfulArgument(activity.arguments);
  return argument.length > 0 ? `${activity.name} · ${argument}` : activity.name;
}

export function formatElapsed(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "?";
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  const totalSeconds = Math.round(durationMs / 1_000);
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

export function activityStatus(activity: ActivityItem): string {
  if (activity.kind === "thinking") return "ok";
  if (activity.pending) return "running";
  return activity.isError ? "failed" : "ok";
}

export function activitySummary(activity: ActivityItem): string {
  if (activity.kind === "thinking") {
    return `${activity.name} · ${activity.text.length} chars`;
  }
  if (activity.pending) return `${activity.name} · running`;
  return `${activity.name} · ${formatDuration(activity.durationMs)} · ${activityStatus(activity)}`;
}

function groupDurationMs(items: ActivityItem[]): number {
  let sum = 0;
  let hasToolDuration = false;
  for (const item of items) {
    if (item.kind === "tool" && item.durationMs !== undefined) {
      sum += item.durationMs;
      hasToolDuration = true;
    }
  }
  if (hasToolDuration) return sum;

  const timestamps = items
    .map((item) => Date.parse(item.timestamp))
    .filter((value) => Number.isFinite(value));
  if (timestamps.length < 2) return 0;
  return Math.max(0, Math.max(...timestamps) - Math.min(...timestamps));
}

function formatChars(count: number): string {
  if (count < 1000) return `${count} chars`;
  const thousands = count / 1000;
  const rounded = thousands >= 10 ? Math.round(thousands) : Math.round(thousands * 10) / 10;
  return `${rounded}k chars`;
}

export function groupSummary(items: ActivityItem[], running: boolean): string {
  const tools = items.filter((item) => item.kind === "tool");
  const thinking = items.filter((item) => item.kind === "thinking");
  const parts: string[] = [];
  if (tools.length > 0) parts.push(`${tools.length} tool call${tools.length === 1 ? "" : "s"}`);
  const pending = [...tools].reverse().find((item) => item.pending === true);
  if (pending !== undefined) parts.push(pending.name);
  if (thinking.length > 0) {
    parts.push(`${thinking.length} thinking`);
    const chars = thinking.reduce((sum, item) => sum + item.text.length, 0);
    if (chars > 0) parts.push(formatChars(chars));
  }
  parts.push(running ? "running" : formatDuration(groupDurationMs(items)));
  return parts.join(" · ");
}
