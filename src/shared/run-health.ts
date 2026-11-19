import type { RunState } from "./types.js";

export const QUIET_AFTER_MS = 30_000;

export interface DurableRunFacts {
  run: boolean;

  inbox: number;

  submitting: number;
}

export function reconcileRunState(current: RunState, facts: DurableRunFacts): RunState {
  const active = facts.run || facts.inbox > 0 || facts.submitting > 0;
  if (current === "running" && !active) return "idle";
  if (current !== "running" && facts.run) return "running";
  return current;
}
