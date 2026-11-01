import type { McpSubscriptionState } from "../shared/types.js";
import { eventCursor } from "./mcp-events.js";
import {
  deriveSubscriptionState,
  type McpSubscriptionRecord,
  type McpSubscriptionRegistry,
  normalizeSubscriptionState,
  recordStableId,
} from "./mcp-subscriptions.js";

/** The SEP keepalive arrives every 15 s; the recommended maximum is 30 s. */
export const MCP_HEARTBEAT_INTERVAL_MS = 15_000;
/** Three heartbeat intervals of complete silence means the push stream is dead. */
export const MCP_STALL_AFTER_MS = 60_000;
/** Stop retrying after this many failed automatic recoveries. */
export const MCP_RECOVERY_LIMIT = 2;

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
  reopenSubscription?(record: McpSubscriptionRecord, cursor: string | null): Promise<unknown>;
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
  /** How often to inspect the durable rows. Defaults to one heartbeat. */
  readonly intervalMs?: number;
  /** Complete silence after which a stream is stalled. Defaults to 60 s. */
  readonly stallAfterMs?: number;
  /** When supplied without `stallAfterMs`, silence limit is three intervals. */
  readonly heartbeatIntervalMs?: number;
  /** Failed automatic recoveries before the row is marked dead. */
  readonly recoveryLimit?: number;
  /** Override the clock in tests. */
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** Override the hub probe in tests. */
  readonly poll?: (record: McpSubscriptionRecord) => Promise<unknown>;
  /** Override the unsubscribe + subscribe step in tests. */
  readonly reopen?: (record: McpSubscriptionRecord, cursor: string | null) => Promise<unknown>;
  /** Every observation, including a poll timestamp or a stall transition. */
  readonly onUpdated?: (record: McpSubscriptionRecord) => void;
  /** Terminal updates only: a successful re-open, dead, or cancellation. */
  readonly onReopened?: (record: McpSubscriptionRecord) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

function timeOf(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Cancelled, stopped and ended rows are terminal; a failed stream is not. */
function shouldWatch(record: McpSubscriptionRecord): boolean {
  if (record.status === "cancelled" || record.status === "stopped" || record.status === "ended") {
    return false;
  }
  if (record.state === "cancelled" || record.state === "dead") return false;
  if (record.enabled === false && record.status !== "failed" && record.state !== "stalled") {
    return false;
  }
  return true;
}

/** Older rows have no state; failed means "give the stream one more chance". */
function stateOf(record: McpSubscriptionRecord): McpSubscriptionState {
  const explicit = normalizeSubscriptionState(record.state);
  if (explicit !== undefined) return explicit;
  if (record.status === "failed") return "stalled";
  return deriveSubscriptionState(record.status);
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

/** The cursor carried by a poll response. Cursors stay opaque: no ordering. */
export function polledEventCursor(result: unknown): string | null {
  if (!isRecord(result)) return null;
  if (typeof result.cursor === "string") return result.cursor;
  if (typeof result.nextCursor === "string") return result.nextCursor;
  let found: string | null = null;
  const add = (value: unknown): void => {
    const item = isRecord(value) && isRecord(value.event) ? value.event : value;
    const cursor = isRecord(item) ? eventCursor(item) : null;
    if (cursor !== null) found = cursor;
  };
  if (Array.isArray(result.events)) {
    for (const event of result.events) add(event);
  }
  add(result.event ?? result);
  return found;
}

/**
 * Watches event subscriptions for silence. A push stream can stay open and
 * report `active` while no event or heartbeat ever arrives. The hub poll only
 * proves the cursor; polls never count as stream traffic. Three heartbeat
 * intervals without a delivered event or heartbeat mark the row stalled and
 * start one automatic cancel + re-subscribe from the persisted cursor. Two
 * recoveries that fail to restore traffic mark it dead.
 */
/**
 * Watches event subscriptions for silence. A push stream can stay open and
 * report `active` while no event or heartbeat ever arrives; the hub poll proves
 * the cursor, and three heartbeat intervals without traffic proves the stream
 * is dead. One automatic cancel + re-subscribe starts from the persisted
 * cursor; two failed recoveries mark the row dead and stop the timer work for
 * it.
 */
export class McpSubscriptionWatchdog {
  private readonly registry: McpSubscriptionRegistry | undefined;
  private readonly runtime: McpSubscriptionWatchdogRuntime | undefined;
  private readonly intervalMs: number;
  private readonly stallAfterMs: number;
  private readonly recoveryLimit: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly poll: (record: McpSubscriptionRecord) => Promise<unknown>;
  private readonly reopen: (
    record: McpSubscriptionRecord,
    cursor: string | null,
  ) => Promise<unknown>;
  private readonly onUpdated: ((record: McpSubscriptionRecord) => void) | undefined;
  private readonly onReopened: ((record: McpSubscriptionRecord) => void) | undefined;
  /** Last event/heartbeat observation per stable id, so polls cannot reset it. */
  private readonly lastTrafficAt = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private ticking: Promise<void> | undefined;
  private closed = false;

  constructor(options: McpSubscriptionWatchdogOptions = {}) {
    this.registry = options.registry ?? options.runtime?.subscriptionRegistry;
    this.runtime = options.runtime;
    const requestedStall =
      options.stallAfterMs ??
      (options.heartbeatIntervalMs === undefined
        ? MCP_STALL_AFTER_MS
        : options.heartbeatIntervalMs * 3);
    this.stallAfterMs = Math.max(1, requestedStall);
    this.intervalMs = Math.max(
      1,
      options.intervalMs ?? Math.min(MCP_HEARTBEAT_INTERVAL_MS, this.stallAfterMs),
    );
    this.recoveryLimit = Math.max(1, options.recoveryLimit ?? MCP_RECOVERY_LIMIT);
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.log(line));
    this.poll = options.poll ?? ((record) => this.pollRuntime(record));
    this.reopen = options.reopen ?? ((record, cursor) => this.reopenRuntime(record, cursor));
    this.onUpdated = options.onUpdated;
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

  private publish(record: McpSubscriptionRecord, terminal = false): void {
    if (this.onUpdated !== undefined) {
      try {
        this.onUpdated(record);
      } catch {
        // Publishing an observation must not turn it into a retry.
      }
    }
    const state = stateOf(record);
    const visibleTerminal = terminal || state === "stalled" || state === "dead";
    if (this.onReopened === undefined || (!terminal && !visibleTerminal)) return;
    try {
      this.onReopened(record);
    } catch {
      // Publishing the row must not escape the watchdog.
    }
  }

  private async write(record: McpSubscriptionRecord, terminal = false): Promise<void> {
    await this.registry?.record(record);
    this.publish(record, terminal);
  }

  /** Keep a watchdog write newer than the row it is replacing, even on an injected clock. */
  private stamp(record: McpSubscriptionRecord, at: number): string {
    const saved = timeOf(record.updatedAt);
    return iso(Math.max(at, saved ?? at));
  }

  /** Advance the last real traffic time, never from a poll timestamp. */
  private observeTraffic(record: McpSubscriptionRecord, at: number): number {
    const stableId = recordStableId(record);
    let latest = this.lastTrafficAt.get(stableId);
    for (const value of [record.lastEventAt, record.lastHeartbeatAt]) {
      const parsed = timeOf(value);
      if (parsed === undefined) continue;
      const clamped = Math.min(at, parsed);
      if (latest === undefined || clamped > latest) latest = clamped;
    }
    if (latest === undefined) {
      const saved = timeOf(record.updatedAt);
      latest = Math.min(at, saved ?? at);
    }
    this.lastTrafficAt.set(stableId, latest);
    return latest;
  }

  private async check(record: McpSubscriptionRecord): Promise<void> {
    try {
      if (this.closed) return;
      if (!shouldWatch(record)) return;
      const stableId = recordStableId(record);

      let response: unknown;
      let pollError: string | undefined;
      try {
        response = await this.poll(record);
      } catch (error) {
        pollError = errorText(error);
      }

      // A user (or shutdown) may cancel while the poll is in flight. Only a
      // row that is still watchable may be updated or reopened.
      const current = this.registry?.findByStableId(stableId);
      if (current === undefined || !shouldWatch(current)) return;

      const at = this.now();
      const observedCursor = polledEventCursor(response);
      // The server owns the cursor. Persist exactly what the poll returned,
      // even when it is truncated or carries no events. A poll is metadata,
      // never proof that the push stream is alive.
      const next: McpSubscriptionRecord = {
        ...current,
        state: stateOf(current),
        cursor: observedCursor ?? current.cursor,
        lastPollAt: iso(at),
        ...(pollError === undefined
          ? stateOf(current) === "active"
            ? { lastError: undefined, lastErrorAt: undefined }
            : {}
          : { lastError: pollError, lastErrorAt: iso(at) }),
        updatedAt: this.stamp(current, at),
      };
      await this.write(next);
      let observedRecord = this.registry?.findByStableId(stableId) ?? next;
      let trafficAt = this.observeTraffic(observedRecord, at);
      let state = stateOf(observedRecord);
      let failures = observedRecord.recoveryFailures ?? 0;
      let pending = observedRecord.recoveryPending === true;
      let recoveryAt = timeOf(observedRecord.recoveryStartedAt);

      // A heartbeat or delivered event after a successful re-subscribe is the
      // only thing that confirms the recovery. Until then the budget stays.
      if (pending && recoveryAt !== undefined && trafficAt > recoveryAt) {
        const confirmed: McpSubscriptionRecord = {
          ...observedRecord,
          state: "active",
          recoveryFailures: 0,
          recoveryPending: false,
          recoveryStartedAt: undefined,
          lastError: undefined,
          lastErrorAt: undefined,
          updatedAt: this.stamp(observedRecord, at),
        };
        await this.write(confirmed);
        observedRecord = this.registry?.findByStableId(stableId) ?? confirmed;
        state = stateOf(observedRecord);
        failures = 0;
        pending = false;
        recoveryAt = undefined;
        trafficAt = this.observeTraffic(observedRecord, at);
      }

      // While a re-subscribe is unconfirmed, give its stream a full silence
      // window from the re-subscribe itself. Polls still do not move this base.
      const silentBase =
        pending && recoveryAt !== undefined ? Math.max(trafficAt, recoveryAt) : trafficAt;
      const silentFor = Math.max(0, at - silentBase);
      const silence = silentFor >= this.stallAfterMs;
      const failedStatus = observedRecord.status === "failed";
      const shouldRecover =
        state === "stalled" || state === "recovering" || failedStatus || silence;
      if (!shouldRecover) return;

      if (pending) {
        if (!silence) return;
        // The previous re-subscribe came back but never delivered anything.
        failures += 1;
        pending = false;
        const reason = `recovery did not restore traffic for ${Math.max(
          0,
          Math.floor(silentFor / 1000),
        )}s`;
        if (failures >= this.recoveryLimit) {
          await this.write(this.deadRecord(observedRecord, failures, reason, at), true);
          this.log(`mcp subscription ${stableId} is dead: ${reason}`);
          return;
        }
        const stalled: McpSubscriptionRecord = {
          ...observedRecord,
          state: "stalled",
          recoveryFailures: failures,
          recoveryPending: false,
          recoveryStartedAt: undefined,
          lastError: reason,
          lastErrorAt: iso(at),
          updatedAt: this.stamp(observedRecord, at),
        };
        await this.write(stalled);
        observedRecord = this.registry?.findByStableId(stableId) ?? stalled;
        state = stateOf(observedRecord);
      }

      if (failures >= this.recoveryLimit) {
        await this.write(
          this.deadRecord(observedRecord, failures, "automatic recovery budget exhausted", at),
          true,
        );
        return;
      }

      const reason = silence
        ? `no event or heartbeat for ${Math.max(0, Math.floor(silentFor / 1000))}s`
        : failedStatus
          ? "subscription reported failed"
          : "recovery retry";
      if (state === "active" && silence) {
        const stalled: McpSubscriptionRecord = {
          ...observedRecord,
          state: "stalled",
          recoveryFailures: failures,
          recoveryPending: false,
          lastError: pollError === undefined ? reason : `${pollError}; ${reason}`,
          lastErrorAt: iso(at),
          updatedAt: this.stamp(observedRecord, at),
        };
        await this.write(stalled);
        observedRecord = this.registry?.findByStableId(stableId) ?? stalled;
      }

      await this.recover(
        this.registry?.findByStableId(stableId) ?? observedRecord,
        reason,
        at,
        failures,
      );
    } catch {
      // A dead server, an unsupported poll method or a failed re-open must
      // never escape into the HTTP server. The next tick tries again.
    }
  }

  private deadRecord(
    record: McpSubscriptionRecord,
    failures: number,
    reason: string,
    at: number,
  ): McpSubscriptionRecord {
    return {
      ...record,
      state: "dead",
      status: "failed",
      enabled: false,
      recoveryFailures: failures,
      recoveryPending: false,
      recoveryStartedAt: undefined,
      lastError: `automatic recovery failed ${failures} times: ${reason}`,
      lastErrorAt: iso(at),
      endReason: "recovery failed",
      updatedAt: this.stamp(record, at),
    };
  }

  private async recover(
    record: McpSubscriptionRecord,
    reason: string,
    at: number,
    failuresAtStart: number,
  ): Promise<void> {
    const stableId = recordStableId(record);
    const recovering: McpSubscriptionRecord = {
      ...record,
      state: "recovering",
      recoveryPending: false,
      recoveryStartedAt: undefined,
      lastError: reason,
      lastErrorAt: iso(at),
      updatedAt: this.stamp(record, at),
    };
    await this.write(recovering);

    let result: McpWatchdogReopenResult = {};
    let failure: string | undefined;
    try {
      result = reopenResult(await this.reopen(recovering, recovering.cursor));
    } catch (error) {
      failure = errorText(error);
    }

    // Cancellation can also land while unsubscribe + subscribe is running.
    // Undo the replacement stream rather than reviving the cancelled row.
    const after = this.registry?.findByStableId(stableId);
    if (after === undefined || !shouldWatch(after)) {
      await this.undoReopen(stableId, result);
      return;
    }
    if (failure === undefined && usableReopenResult(result)) {
      // The subscribe succeeded, but the budget is not cleared until the new
      // stream actually delivers a heartbeat or event.
      const updated: McpSubscriptionRecord = {
        ...after,
        ...(typeof result.id === "string" && result.id.length > 0 ? { id: result.id } : {}),
        cursor: typeof result.cursor === "string" ? result.cursor : after.cursor,
        status: result.status ?? "active",
        state: "active",
        enabled: true,
        endReason:
          typeof result.endReason === "string" && result.endReason.length > 0
            ? result.endReason
            : undefined,
        recoveryFailures: failuresAtStart,
        recoveryPending: true,
        recoveryStartedAt: iso(at),
        reconnects: (after.reconnects ?? 0) + 1,
        lastReconnectReason: reason,
        lastError: undefined,
        lastErrorAt: undefined,
        updatedAt: this.stamp(after, at),
      };
      await this.write(updated, true);
      this.log(`mcp subscription ${stableId} reopened: ${reason}`);
      return;
    }

    const failures = failuresAtStart + 1;
    const dead = failures >= this.recoveryLimit;
    const message = failure ?? "recovery did not return a subscription";
    const failed: McpSubscriptionRecord = dead
      ? this.deadRecord(after, failures, message, at)
      : {
          ...after,
          state: "stalled",
          enabled: after.enabled,
          recoveryFailures: failures,
          recoveryPending: false,
          recoveryStartedAt: undefined,
          lastError: `automatic recovery failed: ${message}`,
          lastErrorAt: iso(at),
          updatedAt: this.stamp(after, at),
        };
    await this.write(failed, true);
    this.log(`mcp subscription ${stableId} ${dead ? "is dead" : "recovery failed"}: ${message}`);
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
    this.publish(latest, true);
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

  private async reopenRuntime(
    record: McpSubscriptionRecord,
    cursor: string | null,
  ): Promise<unknown> {
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
