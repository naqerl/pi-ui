/**
 * The retry policy pi-ui hands to pi-durable, and the wall-clock budget that ends a
 * turn which keeps failing.
 *
 * pi-durable's default (three retries, a two-second base delay capped at sixty seconds)
 * is tuned for a client that retries a single request. A run here is one turn of one
 * chat, so every retry also holds the queue: while the turn waits, the messages sent
 * behind it wait too. Bounding both the count and the elapsed time keeps a broken
 * provider from freezing the whole conversation, and failing the turn says why.
 */

export interface RetrySettings {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  maxAgentDelayMs: number;
}

/** Retries after the first attempt: three attempts in all. */
export const RETRY_MAX = 2;
/** First wait between attempts; pi-durable doubles it per attempt, up to the cap. */
export const RETRY_BASE_DELAY_MS = 1_000;
/** Longest wait between two attempts. */
export const RETRY_MAX_DELAY_MS = 5_000;
/** How long one turn may spend retrying before it is stopped and the queue moves on. */
export const RETRY_BUDGET_MS = 150_000;

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function retrySettings(env: NodeJS.ProcessEnv = process.env): RetrySettings {
  return {
    enabled: true,
    maxRetries: positiveInteger(env, "PI_RETRY_MAX", RETRY_MAX),
    baseDelayMs: positiveInteger(env, "PI_RETRY_BASE_MS", RETRY_BASE_DELAY_MS),
    maxAgentDelayMs: positiveInteger(env, "PI_RETRY_MAX_DELAY_MS", RETRY_MAX_DELAY_MS),
  };
}

export function retryBudgetMs(env: NodeJS.ProcessEnv = process.env): number {
  return positiveInteger(env, "PI_RETRY_BUDGET_MS", RETRY_BUDGET_MS);
}

/** Milliseconds the current retry episode has lasted; zero before the first retry. */
export function retrySpentMs(startedAt: number | undefined, now: number = Date.now()): number {
  if (startedAt === undefined) return 0;
  return Math.max(0, now - startedAt);
}

/** True once one turn has spent its whole retry budget. */
export function retryBudgetExhausted(
  startedAt: number | undefined,
  now: number = Date.now(),
  budgetMs: number = RETRY_BUDGET_MS,
): boolean {
  return startedAt !== undefined && retrySpentMs(startedAt, now) >= budgetMs;
}

/** One line for the chat: what happened, and that the queue keeps going. */
export function retryGiveUpMessage(attempts: number, spentMs: number): string {
  const seconds = Math.max(1, Math.round(spentMs / 1000));
  const tries = attempts === 1 ? "1 retry" : `${attempts} retries`;
  return `The model kept failing (${tries} over ${seconds}s), so this turn was stopped. The next queued message runs now.`;
}
