import {
  MCP_RETRY_BUDGET_MS,
  MCP_SUPERVISE_DEFAULT_MS,
  positiveDurationMs,
} from "./mcp-retry-budget.js";

export const MCP_OUTAGE_NOTIFY_MS =
  positiveDurationMs(process.env.PI_UI_MCP_OUTAGE_NOTIFY_MS) ??
  MCP_RETRY_BUDGET_MS + 2 * MCP_SUPERVISE_DEFAULT_MS;

const LIVE_STATUS = new Set(["active", "opening"]);

export interface StatusView {
  readonly stableId: string;
  readonly status: string;
  readonly text?: string;
  readonly state?: string;
}

export interface OutageObservation {
  readonly chips: string[];
  readonly escalations: string[];
}

interface Outage {
  since: number;
  text: string;
  escalated: boolean;
}

export class OutageQuiet {
  private readonly outages = new Map<string, Outage>();
  private readonly now: () => number;
  private readonly windowMs: number;

  constructor(now: () => number = Date.now, windowMs = MCP_OUTAGE_NOTIFY_MS) {
    this.now = now;
    this.windowMs = windowMs;
  }

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
      const stalled = view.state === "stalled";
      const current = this.outages.get(view.stableId);
      if (current === undefined) {
        this.outages.set(view.stableId, { since: now, text, escalated: stalled });
        chips.push(text);
        if (stalled) escalations.push(text);
        continue;
      }
      current.text = text;
      chips.push(text);
      if (!current.escalated && (stalled || now - current.since >= this.windowMs)) {
        current.escalated = true;
        escalations.push(text);
      }
    }
    return { chips, escalations };
  }

  escalated(stableId: string): boolean {
    return this.outages.get(stableId)?.escalated === true;
  }

  downSince(stableId: string): number | undefined {
    return this.outages.get(stableId)?.since;
  }

  escalate(stableId: string, now: number = this.now()): string | null {
    const outage = this.outages.get(stableId);
    if (outage === undefined || outage.escalated) return null;
    if (now - outage.since < this.windowMs) return null;
    outage.escalated = true;
    return outage.text;
  }

  recovered(stableId: string): void {
    this.outages.delete(stableId);
  }
}
