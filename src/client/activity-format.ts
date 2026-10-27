import type { ActivityItem } from "../shared/types";

export function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "?";
  if (durationMs < 1_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  if (durationMs < 60_000) return `${(durationMs / 1_000).toFixed(1)}s`;
  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
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
