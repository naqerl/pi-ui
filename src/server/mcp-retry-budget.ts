export const MCP_SUPERVISE_RETRY_DELAYS_MS = [5_000, 10_000, 20_000, 40_000, 60_000] as const;
export const MCP_SUPERVISE_MAX_ATTEMPTS = MCP_SUPERVISE_RETRY_DELAYS_MS.length;
export const MCP_SUPERVISE_DEFAULT_MS = 30_000;
export const MCP_RETRY_BUDGET_MS = MCP_SUPERVISE_RETRY_DELAYS_MS.reduce(
  (total, delay) => total + delay,
  0,
);

export function positiveDurationMs(value: string | undefined): number | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

export function superviseRetryDelays(): readonly number[] {
  const raw = process.env.PI_UI_MCP_SUPERVISE_RETRY_MS;
  if (raw === undefined) return MCP_SUPERVISE_RETRY_DELAYS_MS;
  const parsed = raw
    .split(",")
    .map((part) => positiveDurationMs(part))
    .filter((part): part is number => part !== undefined);
  return parsed.length > 0 ? parsed : MCP_SUPERVISE_RETRY_DELAYS_MS;
}
