/** `PI_UI_MCP_OUTAGE_NOTIFY_MS` shortens the quiet window for a test or small deployment. */
export const MCP_OUTAGE_NOTIFY_MS = positiveEnv("PI_UI_MCP_OUTAGE_NOTIFY_MS") ?? 60_000;

/** The statuses that prove a subscription is carrying traffic again. */
const LIVE_STATUS = new Set(["active", "opening"]);

function positiveEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/** One status frame as the quiet window sees it, after identity was resolved. */
export interface StatusView {
  /** The durable identity from `deriveStableId`, never the per-connection adapter id. */
  readonly stableId: string;
  readonly status: string;
  /** The frame's own text, so a chip shows the adapter's words verbatim. */
  readonly text?: string;
}

export interface OutageObservation {
  /** Frames that belong on the chip: an outage, or a recovery inside the window. */
  readonly chips: string[];
  /** Outages that crossed the window on this observation and still deserve a turn. */
  readonly escalations: string[];
}

interface Outage {
  /** First unhealthy frame of this episode. */
  since: number;
  /** Newest status frame text for the episode. */
  text: string;
  /** The one model notice already spoke; only an active frame clears this. */
  escalated: boolean;
}

/**
 * One clock per durable subscription. The first unhealthy frame starts the
 * quiet window; a live frame before it expires cancels it and leaves a chip.
 * Once the window expires the outage is news exactly once, and the recovery
 * after it is the existing single recovery notice.
 *
 * Adapter ids change on every reconnect, so this is keyed by `stableId`; an
 * outage never restarts its own timer just because a replacement connection
 * announced itself.
 */
export class OutageQuiet {
  private readonly outages = new Map<string, Outage>();
  private readonly now: () => number;
  private readonly windowMs: number;

  constructor(now: () => number = Date.now, windowMs = MCP_OUTAGE_NOTIFY_MS) {
    this.now = now;
    this.windowMs = windowMs;
  }

  /**
   * Apply one status observation. A down frame draws a chip and keeps the
   * original `since`; a live frame clears the episode and, when it was not
   * escalated, draws the recovery chip. An episode that crossed the window on
   * this observation is returned once as an escalation.
   */
  observe(views: readonly StatusView[], now: number = this.now()): OutageObservation {
    const chips: string[] = [];
    const escalations: string[] = [];
    for (const view of views) {
      const text = view.text ?? `${view.stableId} is ${view.status}`;
      if (LIVE_STATUS.has(view.status)) {
        const previous = this.outages.get(view.stableId);
        this.outages.delete(view.stableId);
        if (previous !== undefined && !previous.escalated) chips.push(text);
        continue;
      }
      const current = this.outages.get(view.stableId);
      if (current === undefined) {
        this.outages.set(view.stableId, { since: now, text, escalated: false });
        chips.push(text);
        continue;
      }
      current.text = text;
      chips.push(text);
      if (!current.escalated && now - current.since >= this.windowMs) {
        current.escalated = true;
        escalations.push(text);
      }
    }
    return { chips, escalations };
  }

  /** True once this episode has spoken to the model and has not recovered. */
  escalated(stableId: string): boolean {
    return this.outages.get(stableId)?.escalated === true;
  }

  /** When the current episode started, or undefined when the row is not down. */
  downSince(stableId: string): number | undefined {
    return this.outages.get(stableId)?.since;
  }

  /**
   * The timer path: mark this episode escalated when its window has passed and
   * return the newest frame text for the one model notice. A recovered or
   * already-escalated episode returns null.
   */
  escalate(stableId: string, now: number = this.now()): string | null {
    const outage = this.outages.get(stableId);
    if (outage === undefined || outage.escalated) return null;
    if (now - outage.since < this.windowMs) return null;
    outage.escalated = true;
    return outage.text;
  }

  /** A live row or a cancelled one: cancel the timer and forget the episode. */
  recovered(stableId: string): void {
    this.outages.delete(stableId);
  }
}
