/**
 * Keeps the "working" status honest. The server's run state follows the agent's
 * event stream; when that stream drops an event or goes quiet, these helpers
 * decide what the durable agent state says.
 */
import type { RunState } from "./types.js";

/** With no agent event for this long, the server checks the durable state. */
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
