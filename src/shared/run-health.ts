/**
 * Keeps the "working" status honest. The server's run state follows the agent's
 * event stream; when that stream drops an event or goes quiet, these helpers
 * decide what the durable agent state says and what the working strip shows.
 */
import type { RunState } from "./types.js";

/** With no agent event for this long, the server checks the durable state and the strip says so. */
export const QUIET_AFTER_MS = 30_000;

export interface DurableRunFacts {
  /** The durable conversation has a live run. */
  run: boolean;
  /** Inputs wait in the durable inbox; they start a run on their own. */
  inbox: number;
  /** Submissions this server has sent that durable has not recorded yet. */
  submitting: number;
}

/**
 * The run state the durable facts support. A run the server still shows after
 * durable finished it becomes idle; a live run durable has that the server
 * missed becomes running. Anything else keeps the current state.
 */
export function reconcileRunState(current: RunState, facts: DurableRunFacts): RunState {
  const active = facts.run || facts.inbox > 0 || facts.submitting > 0;
  if (current === "running" && !active) return "idle";
  if (current !== "running" && facts.run) return "running";
  return current;
}

/** `12s`, `1m 05s`, `1h 02m`. */
export function clockText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * The working strip's details: how long the run has gone, and how long since the
 * agent last did anything when that is past {@link QUIET_AFTER_MS}.
 */
export function workingDetails(
  startedAt: string | null | undefined,
  lastEventAt: string | null | undefined,
  now: number,
  quietAfterMs = QUIET_AFTER_MS,
): string[] {
  const parts: string[] = [];
  const started = startedAt == null ? Number.NaN : Date.parse(startedAt);
  if (Number.isFinite(started)) parts.push(clockText(now - started));
  const last = lastEventAt == null ? Number.NaN : Date.parse(lastEventAt);
  if (Number.isFinite(last) && now - last >= quietAfterMs) {
    parts.push(`no output for ${clockText(now - last)}`);
  }
  return parts;
}
