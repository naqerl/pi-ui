import type { Task } from "./types.js";

/** Twenty minutes, the default idle period before an automated nudge. */
export const DEFAULT_IDLE_NUDGE_MS = 1_200_000;
/** The wording names the default window; it is what the user sees in the prompt. */
export const IDLE_NUDGE_MINUTES = 20;

/**
 * The idle period from `PI_IDLE_NUDGE_MS`. Zero disables nudges; a missing or
 * invalid value keeps the twenty-minute default.
 */
export function idleNudgeMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.PI_IDLE_NUDGE_MS;
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_IDLE_NUDGE_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return DEFAULT_IDLE_NUDGE_MS;
  return Math.floor(value);
}

/** Open tasks are work the agent can pick up; proposals are not work yet. */
export function openTaskIds(tasks: readonly Pick<Task, "id" | "status">[]): string[] {
  return tasks.filter((task) => task.status === "open").map((task) => task.id);
}

/** The prompt sent as the automated notice; it is also its transcript text. */
export function idleNudgeText(taskIds: readonly string[]): string {
  return `You have been idle for ${IDLE_NUDGE_MINUTES} minutes and ${taskIds.length} task(s) are open: ${taskIds.join(", ")}. Pick the next one and implement it.`;
}

export interface IdleNudgeState {
  /** A turn is running, or a submission has not reached durable yet. */
  active: boolean;
  /** Messages and steers waiting for the current turn. */
  queued: number;
  openTaskIds: readonly string[];
}

/**
 * Tracks one idle period. `noteActivity` re-arms it after any user message,
 * steer, run start or run end; `maybeNudge` fires at most once per period.
 */
export class IdleNudge {
  private lastActivityAt: number;
  private fired = false;

  constructor(
    readonly intervalMs: number,
    startAt: number = Date.now(),
  ) {
    this.lastActivityAt = startAt;
  }

  get enabled(): boolean {
    return this.intervalMs > 0;
  }

  get armed(): boolean {
    return this.enabled && !this.fired;
  }

  /** Any user message, steer, run start or run end starts a fresh idle period. */
  noteActivity(at: number = Date.now()): void {
    this.lastActivityAt = at;
    this.fired = false;
  }

  /** The prompt to submit now, or null while disabled, busy, waiting or already fired. */
  maybeNudge(state: IdleNudgeState, at: number = Date.now()): string | null {
    if (!this.armed) return null;
    if (state.active || state.queued > 0) return null;
    if (state.openTaskIds.length === 0) return null;
    if (at - this.lastActivityAt < this.intervalMs) return null;
    this.fired = true;
    return idleNudgeText(state.openTaskIds);
  }
}
