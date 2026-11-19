export interface RetrySettings {
  enabled: boolean;
  maxRetries: number;
  baseDelayMs: number;
  maxAgentDelayMs: number;
}

export const RETRY_MAX = 2;
export const RETRY_BASE_DELAY_MS = 1_000;
export const RETRY_MAX_DELAY_MS = 5_000;
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

export function retrySpentMs(startedAt: number | undefined, now: number = Date.now()): number {
  if (startedAt === undefined) return 0;
  return Math.max(0, now - startedAt);
}

export function retryBudgetExhausted(
  startedAt: number | undefined,
  now: number = Date.now(),
  budgetMs: number = RETRY_BUDGET_MS,
): boolean {
  return startedAt !== undefined && retrySpentMs(startedAt, now) >= budgetMs;
}

export function retryGiveUpMessage(attempts: number, spentMs: number): string {
  const seconds = Math.max(1, Math.round(spentMs / 1000));
  const tries = attempts === 1 ? "1 retry" : `${attempts} retries`;
  return `The model kept failing (${tries} over ${seconds}s), so this turn was stopped. The next queued message runs now.`;
}
