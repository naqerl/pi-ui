import { cursorHighWater, eventCursor } from "./mcp-events.js";
import {
  type McpSubscriptionRecord,
  type McpSubscriptionRegistry,
  recordStableId,
} from "./mcp-subscriptions.js";

/** What a successful re-open told us about the replacement adapter stream. */
export interface McpWatchdogReopenResult {
  readonly id?: string | null;
  readonly cursor?: string | null;
  readonly status?: string;
  readonly endReason?: string | null;
}

/** The part of McpRuntime the watchdog needs; tests can pass a fake. */
export interface McpSubscriptionWatchdogRuntime {
  readonly subscriptionRegistry?: McpSubscriptionRegistry;
  readonly toolNames?: readonly string[];
  pollEvents?(
    server: string,
    name: string,
    cursor: string | null,
    maxEvents: number,
  ): Promise<unknown>;
  reopenSubscription?(record: McpSubscriptionRecord, cursor: string): Promise<unknown>;
  cancelSubscription?(stableId: string, liveIds?: string | readonly string[]): Promise<unknown>;
  protocolConnection?(server: string): Promise<{
    connection: {
      client: {
        request(
          request: { method: string; params?: Record<string, unknown> },
          resultSchema: unknown,
          options?: unknown,
        ): Promise<unknown>;
      };
    };
  }>;
  shim?: {
    callTool(name: string, params: unknown): Promise<unknown>;
  };
}

export interface McpSubscriptionWatchdogOptions {
  readonly registry?: McpSubscriptionRegistry;
  readonly runtime?: McpSubscriptionWatchdogRuntime;
  /** How often to inspect the durable rows. */
  readonly intervalMs?: number;
  /** Override the clock in tests. */
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** Override the hub probe in tests. */
  readonly poll?: (record: McpSubscriptionRecord) => Promise<unknown>;
  /** Override the unsubscribe + subscribe step in tests. */
  readonly reopen?: (record: McpSubscriptionRecord, cursor: string) => Promise<unknown>;
  /** Let the live view show the re-open immediately. */
  readonly onReopened?: (record: McpSubscriptionRecord) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Cancelled, stopped and ended rows are terminal; a failed stream is not. */
function shouldWatch(record: McpSubscriptionRecord): boolean {
  if (record.status === "cancelled" || record.status === "stopped" || record.status === "ended") {
    return false;
  }
  if (record.enabled === false && record.status !== "failed") return false;
  return true;
}

function usableReopenResult(result: McpWatchdogReopenResult): boolean {
  return (
    (typeof result.id === "string" && result.id.length > 0) ||
    typeof result.cursor === "string" ||
    typeof result.status === "string"
  );
}

function reopenResult(value: unknown): McpWatchdogReopenResult {
  if (!isRecord(value)) return {};
  return {
    ...(typeof value.id === "string" || value.id === null ? { id: value.id } : {}),
    ...(typeof value.cursor === "string" || value.cursor === null ? { cursor: value.cursor } : {}),
    ...(typeof value.status === "string" ? { status: value.status } : {}),
    ...(typeof value.endReason === "string" || value.endReason === null
      ? { endReason: value.endReason }
      : {}),
  };
}

/**
 * The cursor carried by a poll response. Both the MCP events envelope and a
 * bare event are accepted so the watchdog does not depend on one hub shape.
 */
export function polledEventCursor(result: unknown): string | null {
  if (!isRecord(result)) return null;
  const candidates: string[] = [];
  const add = (value: unknown): void => {
    const item = isRecord(value) && isRecord(value.event) ? value.event : value;
    const cursor = isRecord(item) ? eventCursor(item) : null;
    if (cursor !== null) candidates.push(cursor);
  };
  if (Array.isArray(result.events)) {
    for (const event of result.events) add(event);
  }
  add(result.event ?? result);
  if (typeof result.cursor === "string") candidates.push(result.cursor);
  if (candidates.length === 0) return null;

  let best = candidates[0] ?? null;
  let bestMark = cursorHighWater(best);
  for (const candidate of candidates.slice(1)) {
    const mark = cursorHighWater(candidate);
    if (mark !== null && (bestMark === null || mark > bestMark)) {
      best = candidate;
      bestMark = mark;
    }
  }
  return best;
}

/** True only when the hub cursor is demonstrably beyond the stored one. */
export function cursorIsAhead(stored: string | null, hub: string | null): boolean {
  if (hub === null) return false;
  if (stored === null) return true;
  const storedMark = cursorHighWater(stored);
  const hubMark = cursorHighWater(hub);
  if (storedMark === null || hubMark === null) return false;
  return hubMark > storedMark;
}

/**
 * Re-opens event subscriptions whose push stream died without changing its
 * durable status. A poll of the hub itself is the source of truth: if the hub
 * has an event beyond the stored cursor while the stream has been quiet, the
 * stream is dead even though it still says `active`.
 */
export class McpSubscriptionWatchdog {
  private readonly registry: McpSubscriptionRegistry | undefined;
  private readonly runtime: McpSubscriptionWatchdogRuntime | undefined;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly poll: (record: McpSubscriptionRecord) => Promise<unknown>;
  private readonly reopen: (record: McpSubscriptionRecord, cursor: string) => Promise<unknown>;
  private readonly onReopened: ((record: McpSubscriptionRecord) => void) | undefined;
  private readonly lastReopenAt = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;
  private closed = false;

  constructor(options: McpSubscriptionWatchdogOptions = {}) {
    this.registry = options.registry ?? options.runtime?.subscriptionRegistry;
    this.runtime = options.runtime;
    this.intervalMs = Math.max(1, options.intervalMs ?? 60_000);
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.log(line));
    this.poll = options.poll ?? ((record) => this.pollRuntime(record));
    this.reopen = options.reopen ?? ((record, cursor) => this.reopenRuntime(record, cursor));
    this.onReopened = options.onReopened;
  }

  /** Start the periodic check. Calling it twice is harmless. */
  start(): void {
    if (this.closed || this.timer !== undefined) return;
    this.timer = setInterval(() => this.runTick(), this.intervalMs);
    this.timer.unref?.();
  }

  /** One check, exposed so a test can drive it without waiting a minute. */
  async tick(): Promise<void> {
    await this.checkAll();
  }

  /** Stop the timer and wait for an interval-driven check that is already running. */
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.ticking?.catch(() => {});
  }

  private runTick(): void {
    if (this.closed || this.ticking !== undefined) return;
    this.ticking = this.checkAll().finally(() => {
      this.ticking = undefined;
    });
  }

  private async checkAll(): Promise<void> {
    if (this.closed || this.registry === undefined) return;
    let records: McpSubscriptionRecord[];
    try {
      records = await this.registry.read();
    } catch {
      return;
    }
    if (records.length === 0) return;
    await Promise.allSettled(records.map((record) => this.check(record)));
  }

  private async check(record: McpSubscriptionRecord): Promise<void> {
    try {
      if (this.closed) return;
      if (!shouldWatch(record)) return;
      const stableId = recordStableId(record);
      const response = await this.poll(record);
      const hubCursor = polledEventCursor(response);
      if (hubCursor === null) return;

      // A user (or shutdown) may cancel while the poll is in flight. Only a
      // row that is still watchable may be reopened.
      const current = this.registry?.findByStableId(stableId);
      if (current === undefined || !shouldWatch(current)) return;
      if (!cursorIsAhead(current.cursor, hubCursor)) return;

      const at = this.now();
      const previous = this.lastReopenAt.get(stableId);
      if (previous !== undefined && at - previous < this.intervalMs) return;
      // Set this before the async work so overlapping ticks cannot open twice.
      this.lastReopenAt.set(stableId, at);

      const result = reopenResult(await this.reopen(current, hubCursor));

      // Cancellation can also land while unsubscribe + subscribe is running.
      // Undo the replacement stream rather than reviving the cancelled row.
      const after = this.registry?.findByStableId(stableId);
      if (after === undefined || !shouldWatch(after)) {
        await this.undoReopen(stableId, result);
        return;
      }
      if (!usableReopenResult(result)) return;

      const updated: McpSubscriptionRecord = {
        ...after,
        ...(typeof result.id === "string" && result.id.length > 0 ? { id: result.id } : {}),
        cursor: result.cursor ?? hubCursor,
        status: result.status ?? "active",
        enabled: true,
        endReason:
          typeof result.endReason === "string" && result.endReason.length > 0
            ? result.endReason
            : undefined,
        reconnects: (after.reconnects ?? 0) + 1,
        lastReconnectReason: `stored ${current.cursor ?? "null"}, hub ${hubCursor}`,
        updatedAt: new Date(at).toISOString(),
      };
      await this.registry?.record(updated);
      this.log(
        `mcp subscription ${stableId} reopened: stored ${current.cursor ?? "null"}, hub ${hubCursor}`,
      );
      try {
        this.onReopened?.(updated);
      } catch {
        // Publishing the new row must not turn a successful re-open into a retry.
      }
    } catch {
      // A dead server, an unsupported poll method or a failed re-open must
      // never escape into the HTTP server. The next tick tries again.
    }
  }

  private async undoReopen(stableId: string, result: McpWatchdogReopenResult): Promise<void> {
    const replacementId =
      typeof result.id === "string" && result.id.length > 0 ? result.id : undefined;
    try {
      if (this.runtime?.cancelSubscription !== undefined) {
        await this.runtime.cancelSubscription(
          stableId,
          replacementId === undefined ? undefined : [replacementId],
        );
      } else if (replacementId !== undefined && this.runtime?.shim !== undefined) {
        await this.runtime.shim
          .callTool("mcp_events", {
            action: "unsubscribe",
            subscription_id: replacementId,
          })
          .catch(() => {});
      }
    } catch {
      // The durable row is already cancelled; best-effort stop the replacement.
    }
    const latest = this.registry?.findByStableId(stableId);
    if (latest === undefined) return;
    try {
      this.onReopened?.(latest);
    } catch {
      // Publishing the cancellation must not escape the watchdog.
    }
  }

  private async pollRuntime(record: McpSubscriptionRecord): Promise<unknown> {
    if (this.runtime?.pollEvents !== undefined) {
      return this.runtime.pollEvents(record.server, record.name, record.cursor, 1);
    }
    if (this.runtime?.protocolConnection === undefined) return null;
    const { connection } = await this.runtime.protocolConnection(record.server);
    const { z } = await import("zod");
    return connection.client.request(
      {
        method: "events/poll",
        params: { name: record.name, cursor: record.cursor, maxEvents: 1 },
      },
      z.record(z.string(), z.unknown()),
    );
  }

  private async reopenRuntime(record: McpSubscriptionRecord, cursor: string): Promise<unknown> {
    if (this.runtime?.reopenSubscription !== undefined) {
      return this.runtime.reopenSubscription(record, cursor);
    }
    if (
      this.runtime?.shim === undefined ||
      !(this.runtime.toolNames ?? []).includes("mcp_events")
    ) {
      return null;
    }
    if (record.id !== null && record.id !== undefined && record.id.length > 0) {
      await this.runtime.shim
        .callTool("mcp_events", { action: "unsubscribe", subscription_id: record.id })
        .catch(() => {});
    }
    const result = await this.runtime.shim.callTool("mcp_events", {
      action: "subscribe",
      server: record.server,
      name: record.name,
      arguments: record.arguments,
      cursor,
    });
    if (!isRecord(result) || result.isError === true) return null;
    const details = isRecord(result.details) ? result.details : undefined;
    const raw = details !== undefined && isRecord(details.subscription) ? details.subscription : {};
    return {
      id: typeof raw.id === "string" ? raw.id : undefined,
      cursor: typeof raw.cursor === "string" ? raw.cursor : cursor,
      status: typeof raw.status === "string" ? raw.status : "active",
      endReason: typeof raw.endReason === "string" ? raw.endReason : undefined,
    };
  }
}

export function startMcpSubscriptionWatchdog(
  options: McpSubscriptionWatchdogOptions,
): McpSubscriptionWatchdog {
  const watchdog = new McpSubscriptionWatchdog(options);
  watchdog.start();
  return watchdog;
}
