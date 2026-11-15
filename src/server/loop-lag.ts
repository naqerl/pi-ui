import { performance } from "node:perf_hooks";
import type { LoopLagStats } from "../shared/dashboard.js";

interface Sample {
  at: number;
  lag: number;
}

/**
 * Measures event-loop lag by comparing a 100 ms timer against the time it was
 * due. A blocked loop makes that timer late, and the delay is what every HTTP
 * request paid for. Samples older than the window are dropped, so p50/p95/max
 * describe the last minute rather than the process lifetime.
 */
export class LoopLagMonitor {
  private samples: Sample[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly intervalMs = 100,
    private readonly windowMs = 60_000,
    private readonly now: () => number = () => performance.now(),
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.schedule();
  }

  stop(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Record one observation. Public so a test can feed a deterministic history. */
  record(lagMs: number, at: number = this.now()): void {
    this.samples.push({ at, lag: Math.max(0, lagMs) });
    this.prune(at);
  }

  stats(at: number = this.now()): LoopLagStats {
    this.prune(at);
    const lags = this.samples.map((sample) => sample.lag).sort((left, right) => left - right);
    const last = this.samples.at(-1)?.lag ?? 0;
    return {
      p50: percentile(lags, 0.5),
      p95: percentile(lags, 0.95),
      max: Math.round(lags.at(-1) ?? 0),
      lastBlockedMs: Math.round(last),
    };
  }

  private schedule(): void {
    const due = this.now() + this.intervalMs;
    this.timer = setTimeout(() => {
      const now = this.now();
      this.record(now - due, now);
      this.schedule();
    }, this.intervalMs);
    this.timer.unref?.();
  }

  private prune(at: number): void {
    const cutoff = at - this.windowMs;
    let first = 0;
    while (first < this.samples.length && (this.samples[first]?.at ?? 0) < cutoff) first += 1;
    if (first > 0) this.samples = this.samples.slice(first);
  }
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return Math.round(sorted[index] ?? 0);
}
