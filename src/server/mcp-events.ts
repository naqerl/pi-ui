import { toIsoTimestamp } from "../shared/time.js";
import type { McpEventsState, McpEventView, McpSubscriptionView } from "../shared/types.js";
import {
  deriveStableId,
  deriveSubscriptionState,
  MAX_DELIVERED_EVENT_IDS,
  type McpSubscriptionRecord,
  type McpSubscriptionRegistry,
  normalizeSubscriptionState,
  recordStableId,
  subscriptionEnabled,
} from "./mcp-subscriptions.js";

export interface ExtensionNotice {
  customType?: string;
  details?: unknown;
}

export interface McpEventFeedOptions {
  /** Process start time; events stamped before it are replay, never news. */
  readonly startedAt?: number | string | Date;
}

function startedAtOf(value: number | string | Date | undefined): number {
  // A standalone feed has no process bundle; the server always passes its boot time.
  if (value === undefined) return 0;
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : 0;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

const LIVE_STATUS = new Set(["opening", "active", "reconnecting"]);
const EVENT_LIMIT = 100;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneLine(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

function summarize(data: unknown): string {
  if (typeof data === "string") return oneLine(data);
  if (data === undefined) return "";
  try {
    return oneLine(JSON.stringify(data));
  } catch {
    return "";
  }
}

/** The real position rides in `event.data.cursor`; the envelope cursor is often null. */
export function eventCursor(event: Record<string, unknown>): string | null {
  if (isRecord(event.data) && typeof event.data.cursor === "string") return event.data.cursor;
  return typeof event.cursor === "string" ? event.cursor : null;
}

/** Cursor reported by an events/poll response, wherever the server put it. */
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

/** Cursors are opaque: a string from the server replaces whatever we had. */
function serverCursor(current: string | null, incoming: string | null): string | null {
  return incoming ?? current;
}

function sameArguments(first: Record<string, unknown>, second: Record<string, unknown>): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function eventIdsFrom(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.deliveredEventIds)) return [];
  return value.deliveredEventIds.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}

function subscriptionFrom(value: unknown): McpSubscriptionView | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || typeof value.server !== "string") return null;
  const name = typeof value.name === "string" ? value.name : "event";
  const status = typeof value.status === "string" ? value.status : "active";
  const args = isRecord(value.arguments) ? value.arguments : {};
  const cursor = typeof value.cursor === "string" ? value.cursor : null;
  const stableId =
    typeof value.stableId === "string" && value.stableId.length > 0
      ? value.stableId
      : deriveStableId(value.server, name, args);
  const title =
    typeof value.title === "string" && value.title.trim().length > 0
      ? value.title.trim()
      : undefined;
  const state = deriveSubscriptionState(status, normalizeSubscriptionState(value.state));
  const lastEventAt =
    typeof value.lastEventAt === "string" && value.lastEventAt.length > 0
      ? value.lastEventAt
      : undefined;
  const lastHeartbeatAt =
    typeof value.lastHeartbeatAt === "string" && value.lastHeartbeatAt.length > 0
      ? value.lastHeartbeatAt
      : undefined;
  const lastPollAt =
    typeof value.lastPollAt === "string" && value.lastPollAt.length > 0
      ? value.lastPollAt
      : undefined;
  const lastError =
    typeof value.lastError === "string" && value.lastError.length > 0 ? value.lastError : undefined;
  const lastErrorAt =
    typeof value.lastErrorAt === "string" && value.lastErrorAt.length > 0
      ? value.lastErrorAt
      : undefined;
  const recoveryFailures =
    typeof value.recoveryFailures === "number" &&
    Number.isSafeInteger(value.recoveryFailures) &&
    value.recoveryFailures >= 0
      ? value.recoveryFailures
      : undefined;
  const recoveryPending =
    typeof value.recoveryPending === "boolean" ? value.recoveryPending : undefined;
  const recoveryStartedAt =
    typeof value.recoveryStartedAt === "string" && value.recoveryStartedAt.length > 0
      ? value.recoveryStartedAt
      : undefined;
  const reconnects =
    typeof value.reconnects === "number" &&
    Number.isSafeInteger(value.reconnects) &&
    value.reconnects >= 0
      ? value.reconnects
      : undefined;
  const lastReconnectReason =
    typeof value.lastReconnectReason === "string" && value.lastReconnectReason.length > 0
      ? value.lastReconnectReason
      : undefined;
  const endReason =
    typeof value.endReason === "string" && value.endReason.length > 0 ? value.endReason : undefined;
  return {
    id: value.id,
    stableId,
    server: value.server,
    name,
    ...(title === undefined ? {} : { title }),
    status,
    state,
    arguments: args,
    cursor,
    ...(lastEventAt === undefined ? {} : { lastEventAt }),
    ...(lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt }),
    ...(lastPollAt === undefined ? {} : { lastPollAt }),
    ...(lastError === undefined ? {} : { lastError }),
    ...(lastErrorAt === undefined ? {} : { lastErrorAt }),
    ...(recoveryFailures === undefined ? {} : { recoveryFailures }),
    ...(recoveryPending === undefined ? {} : { recoveryPending }),
    ...(recoveryStartedAt === undefined ? {} : { recoveryStartedAt }),
    ...(reconnects === undefined ? {} : { reconnects }),
    ...(lastReconnectReason === undefined ? {} : { lastReconnectReason }),
    ...(endReason === undefined ? {} : { endReason }),
  };
}

/**
 * Server-owned MCP subscription list and event log. Every connected client
 * reads this same snapshot, so a second browser does not keep a private feed.
 *
 * Replay detection is keyed by the durable stable id, not the adapter id: the
 * registry keeps the last `MAX_DELIVERED_EVENT_IDS` event ids for each stable
 * id. Novelty is judged from that id set alone, per conversation: an id already
 * delivered is a re-delivery and never becomes a chat notice, and an id the
 * conversation has not seen is news even when it was produced while this
 * process was down. Process boot time deliberately plays no part — a restart of
 * the server is not a restart of the conversation.
 */
export class McpEventFeed {
  private readonly subscriptions = new Map<string, McpSubscriptionView>();
  /** Event ids delivered for a stable id, including the historical ones. */
  private readonly delivered = new Map<string, Set<string>>();
  /** The subset of `delivered` that came from a previous process. */
  private readonly historical = new Map<string, Set<string>>();
  /** Stable ids that existed before this feed started, so cursor fallback can replay. */
  private readonly restored = new Set<string>();
  /** Stable ids explicitly cancelled; a late status notice must not revive them. */
  private readonly cancelled = new Set<string>();
  /** Every adapter id that ever represented a stable id, including replaced ones. */
  private readonly adapterAliases = new Map<string, string>();
  private events: McpEventView[] = [];
  private notice: string | null = null;
  private gap: { dropped: number; at: string } | undefined;
  private revision = 0;
  private readonly startedAt: number;

  constructor(
    private readonly registry?: McpSubscriptionRegistry,
    options: McpEventFeedOptions = {},
  ) {
    this.startedAt = startedAtOf(options.startedAt);
    // A registry that was read during boot already knows the durable rows.
    this.seedRecords(registry?.list() ?? []);
  }

  /** Load the durable rows from disk. The index awaits this before observing events. */
  async hydrate(): Promise<void> {
    if (this.registry === undefined) return;
    this.seedRecords(await this.registry.read());
  }

  get state(): McpEventsState {
    return {
      subscriptions: [...this.subscriptions.values()],
      events: this.events,
      notice: this.notice,
      ...(this.gap === undefined ? {} : { gap: this.gap }),
      revision: this.revision,
    };
  }

  /** The live view with this durable identity, regardless of its adapter id. */
  findByStableId(stableId: string): McpSubscriptionView | undefined {
    for (const subscription of this.subscriptions.values()) {
      if (subscription.stableId === stableId) return subscription;
    }
    return undefined;
  }

  /**
   * Every adapter id that has represented this stable id in this process,
   * including rows replaced by a later subscribe. Cancelling must stop all of
   * them, not just whichever row happens to be first in the feed.
   */
  adapterIdsForStableId(stableId: string): string[] {
    const ids = new Set<string>();
    for (const [adapterId, mappedStableId] of this.adapterAliases) {
      if (mappedStableId === stableId) ids.add(adapterId);
    }
    for (const [adapterId, subscription] of this.subscriptions) {
      if (subscription.stableId === stableId) ids.add(adapterId);
    }
    return [...ids];
  }

  /**
   * Stop showing a subscription as live. The runtime unsubscribes every
   * adapter stream for this stable id and persists the cancelled record; this
   * keeps the feed immediate.
   */
  cancel(stableId: string): McpSubscriptionView | null {
    this.cancelled.add(stableId);
    let found: McpSubscriptionView | null = null;
    for (const [id, subscription] of this.subscriptions) {
      if (subscription.stableId !== stableId) continue;
      const cancelled = {
        ...subscription,
        status: "cancelled",
        state: "cancelled" as const,
        recoveryPending: false,
        recoveryStartedAt: undefined,
      };
      this.subscriptions.set(id, cancelled);
      this.persist(cancelled);
      found = cancelled;
    }
    if (found !== null) this.touch();
    return found;
  }

  /** Alternate name for `cancel`, kept for callers that think in identity. */
  cancelByStableId(stableId: string): McpSubscriptionView | null {
    return this.cancel(stableId);
  }

  /** Apply the watchdog's latest observation (poll, stall, recovery) to the visible row. */
  noteReconnect(record: McpSubscriptionRecord): boolean {
    const stableId = recordStableId(record);
    const current = this.findByStableId(stableId);
    const state = deriveSubscriptionState(record.status, record.state);
    const next: McpSubscriptionView = {
      ...(current ?? {
        id: record.id ?? stableId,
        stableId,
        server: record.server,
        name: record.name,
        arguments: record.arguments,
        cursor: record.cursor,
      }),
      ...(typeof record.id === "string" && record.id.length > 0 ? { id: record.id } : {}),
      cursor: record.cursor,
      status: record.status,
      state,
      lastEventAt: record.lastEventAt ?? current?.lastEventAt,
      lastHeartbeatAt: record.lastHeartbeatAt ?? current?.lastHeartbeatAt,
      lastPollAt: record.lastPollAt,
      lastError: record.lastError,
      lastErrorAt: record.lastErrorAt,
      recoveryFailures: record.recoveryFailures,
      recoveryPending: record.recoveryPending,
      recoveryStartedAt: record.recoveryStartedAt,
      reconnects: record.reconnects,
      lastReconnectReason: record.lastReconnectReason,
      endReason: record.endReason,
    };
    const changed =
      current === undefined ||
      current.id !== next.id ||
      current.cursor !== next.cursor ||
      current.status !== next.status ||
      current.state !== next.state ||
      current.lastEventAt !== next.lastEventAt ||
      current.lastHeartbeatAt !== next.lastHeartbeatAt ||
      current.lastPollAt !== next.lastPollAt ||
      current.lastError !== next.lastError ||
      current.lastErrorAt !== next.lastErrorAt ||
      current.recoveryFailures !== next.recoveryFailures ||
      current.recoveryPending !== next.recoveryPending ||
      current.recoveryStartedAt !== next.recoveryStartedAt ||
      current.reconnects !== next.reconnects ||
      current.lastReconnectReason !== next.lastReconnectReason ||
      current.endReason !== next.endReason;
    this.storeView(next);
    if (current !== undefined && !changed) return false;
    this.touch();
    return true;
  }

  /** Resolve an adapter id, including one replaced by a newer subscribe, to the current row. */
  private viewForAdapter(adapterId: string): McpSubscriptionView | undefined {
    const direct = this.subscriptions.get(adapterId);
    if (direct !== undefined) return direct;
    const stableId = this.adapterAliases.get(adapterId);
    if (stableId === undefined) return undefined;
    return this.findByStableId(stableId);
  }

  /** Keep exactly one visible row per durable identity. */
  private storeView(view: McpSubscriptionView): McpSubscriptionView {
    for (const [adapterId, existing] of this.subscriptions) {
      if (adapterId !== view.id && existing.stableId === view.stableId) {
        this.subscriptions.delete(adapterId);
      }
    }
    this.subscriptions.set(view.id, view);
    this.adapterAliases.set(view.id, view.stableId);
    return view;
  }

  /** The adapter id whose cancellation must be preserved, undefined when not cancelled. */
  private cancellationId(stableId: string): string | null | undefined {
    const view = this.findByStableId(stableId);
    if (view?.status === "cancelled") return view.id;
    if (this.cancelled.has(stableId)) return view?.id ?? null;
    const record = this.registry?.list().find((entry) => recordStableId(entry) === stableId);
    if (record?.status === "cancelled") return record.id ?? null;
    return undefined;
  }

  ingest(notice: ExtensionNotice): boolean {
    if (notice.customType === "mcp-events") return this.ingestEvents(notice.details);
    if (notice.customType === "mcp-events-status") return this.ingestStatuses(notice.details);
    if (notice.customType === "mcp-events-tool") return this.ingestTool(notice.details);
    if (notice.customType === "mcp-events-traffic") return this.ingestTraffic(notice.details);
    return false;
  }

  private touch(): void {
    this.revision += 1;
  }

  private seedRecords(records: readonly McpSubscriptionRecord[]): void {
    for (const record of records) {
      const stableId = recordStableId(record);
      this.restored.add(stableId);
      this.seedDelivered(stableId, record.deliveredEventIds ?? [], true);
      // A restore rejected by the server has no live adapter session, but the
      // durable cancellation must still be visible in /api/state.
      if (record.status === "cancelled" || record.state === "cancelled") {
        const view = subscriptionFrom({ ...record, id: record.id ?? stableId });
        if (view !== null) this.storeView(view);
      }
    }
  }

  private seedDelivered(stableId: string, ids: readonly string[], historical: boolean): void {
    if (!historical || ids.length === 0) return;
    // Once this process has delivered something, a durable row is already
    // represented by the in-memory sets and must not be relabelled historical.
    const known = this.delivered.get(stableId);
    if (known !== undefined && known.size > 0) return;
    const delivered = new Set<string>();
    const historicalIds = new Set<string>();
    for (const id of ids) {
      if (id.length === 0 || delivered.has(id)) continue;
      delivered.add(id);
      historicalIds.add(id);
    }
    while (delivered.size > MAX_DELIVERED_EVENT_IDS) {
      const oldest = delivered.values().next().value;
      if (oldest === undefined) break;
      delivered.delete(oldest);
      historicalIds.delete(oldest);
    }
    this.delivered.set(stableId, delivered);
    this.historical.set(stableId, historicalIds);
  }

  private savedRecord(stableId: string): McpSubscriptionRecord | undefined {
    return this.registry?.list().find((entry) => recordStableId(entry) === stableId);
  }

  /** Seed from a row for a stable id if this feed has not seen the stream yet. */
  private seedFromRegistry(stableId: string): void {
    const record = this.savedRecord(stableId);
    if (record === undefined) return;
    this.restored.add(stableId);
    this.seedDelivered(stableId, record.deliveredEventIds ?? [], true);
  }

  private remember(stableId: string, eventId: string, historical: boolean): boolean {
    let delivered = this.delivered.get(stableId);
    if (delivered === undefined) {
      delivered = new Set<string>();
      this.delivered.set(stableId, delivered);
    }
    let ids = this.historical.get(stableId);
    if (ids === undefined) {
      ids = new Set<string>();
      this.historical.set(stableId, ids);
    }
    if (delivered.has(eventId)) {
      if (historical) ids.add(eventId);
      else ids.delete(eventId);
      return false;
    }
    delivered.add(eventId);
    if (historical) ids.add(eventId);
    else ids.delete(eventId);
    while (delivered.size > MAX_DELIVERED_EVENT_IDS) {
      const oldest = delivered.values().next().value;
      if (oldest === undefined) break;
      delivered.delete(oldest);
      ids.delete(oldest);
    }
    return true;
  }

  private deliveredIds(stableId: string): string[] {
    return [...(this.delivered.get(stableId) ?? [])];
  }

  private isDelivered(stableId: string, eventId: string | undefined): boolean {
    return eventId !== undefined && this.delivered.get(stableId)?.has(eventId) === true;
  }

  private persist(subscription: McpSubscriptionView): void {
    if (this.registry === undefined) return;
    const record: McpSubscriptionRecord = {
      server: subscription.server,
      name: subscription.name,
      stableId: subscription.stableId,
      id: subscription.id,
      arguments: subscription.arguments,
      cursor: subscription.cursor,
      status: subscription.status,
      state: subscription.state,
      enabled:
        subscription.status === "cancelled" ? false : subscriptionEnabled(subscription.status),
      deliveredEventIds: this.deliveredIds(subscription.stableId),
      ...(subscription.lastEventAt === undefined ? {} : { lastEventAt: subscription.lastEventAt }),
      ...(subscription.lastHeartbeatAt === undefined
        ? {}
        : { lastHeartbeatAt: subscription.lastHeartbeatAt }),
      ...(subscription.lastPollAt === undefined ? {} : { lastPollAt: subscription.lastPollAt }),
      ...(subscription.lastError === undefined ? {} : { lastError: subscription.lastError }),
      ...(subscription.lastErrorAt === undefined ? {} : { lastErrorAt: subscription.lastErrorAt }),
      ...(subscription.recoveryFailures === undefined
        ? {}
        : { recoveryFailures: subscription.recoveryFailures }),
      ...(subscription.recoveryPending === undefined
        ? {}
        : { recoveryPending: subscription.recoveryPending }),
      ...(subscription.recoveryStartedAt === undefined
        ? {}
        : { recoveryStartedAt: subscription.recoveryStartedAt }),
      ...(subscription.reconnects === undefined ? {} : { reconnects: subscription.reconnects }),
      ...(subscription.lastReconnectReason === undefined
        ? {}
        : { lastReconnectReason: subscription.lastReconnectReason }),
      ...(subscription.endReason === undefined ? {} : { endReason: subscription.endReason }),
      updatedAt: new Date().toISOString(),
    };
    void this.registry.record(record).catch((error: unknown) => {
      console.warn(
        `mcp: could not persist subscription ${subscription.server}/${subscription.name}`,
        error,
      );
    });
  }

  private ingestEvents(details: unknown): boolean {
    if (!isRecord(details) || !Array.isArray(details.events)) return false;
    let stateChanged = false;
    let deliveredNew = false;
    // A reconnecting stream drops what it cannot replay and says how much. That
    // count is the only honest witness of a gap, so record it rather than
    // letting the missing window look like quietness.
    const dropped = typeof details.dropped_events === "number" ? details.dropped_events : 0;
    if (dropped > 0) {
      this.gap = { dropped, at: new Date().toISOString() };
      this.notice = `${dropped} events dropped while reconnecting`;
      stateChanged = true;
    }
    for (const item of details.events) {
      if (!isRecord(item) || typeof item.server !== "string" || !isRecord(item.event)) continue;
      const event = item.event;
      const streamName = typeof event.name === "string" ? event.name : "event";
      // A multiplexed stream names every event after itself and carries the
      // kind in `data.kind` (`hub.job` on a `hub` stream).
      const name =
        isRecord(event.data) && typeof event.data.kind === "string" && event.data.kind !== ""
          ? event.data.kind
          : streamName;
      const timestamp =
        toIsoTimestamp(event.timestamp as string | number | Date) ?? new Date().toISOString();
      const eventId = typeof event.eventId === "string" ? event.eventId : undefined;
      const id = eventId ?? `${item.server}:${name}:${timestamp}:${this.events.length}`;
      const cursor = eventCursor(event);
      const subscriptionId =
        typeof item.subscription_id === "string" ? item.subscription_id : undefined;
      const current =
        subscriptionId === undefined ? undefined : this.viewForAdapter(subscriptionId);
      const stableId =
        current?.stableId ?? deriveStableId(item.server, streamName, current?.arguments ?? {});
      // Novelty belongs to the conversation, not to this process. An id the feed
      // already delivered — in this process or before it started — is a
      // re-delivery; anything else is news, however old its timestamp looks.
      const replay = this.isDelivered(stableId, eventId);

      if (replay) {
        // A restored stream may redeliver an event whose id we already stored
        // before this process started. Keep it visibly marked, never a notice.
        if (this.trackCursor(item, streamName, cursor)) stateChanged = true;
        if (eventId !== undefined) this.remember(stableId, eventId, true);
        const existing = this.events.find((entry) => entry.id === id);
        if (existing === undefined) {
          this.events = [
            ...this.events,
            {
              id,
              server: item.server,
              name,
              timestamp,
              summary: summarize(event.data),
              replayed: true,
            },
          ].slice(-EVENT_LIMIT);
          stateChanged = true;
        }
        const tracked =
          subscriptionId === undefined ? undefined : this.viewForAdapter(subscriptionId);
        if (tracked !== undefined) this.persist(tracked);
        continue;
      }

      if (this.trackCursor(item, streamName, cursor, timestamp)) stateChanged = true;
      if (eventId !== undefined) this.remember(stableId, eventId, false);
      const index = this.events.findIndex((entry) => entry.id === id);
      const existing = index === -1 ? undefined : this.events[index];
      if (existing !== undefined && existing.replayed !== true) {
        const tracked =
          subscriptionId === undefined ? undefined : this.viewForAdapter(subscriptionId);
        if (tracked !== undefined) this.persist(tracked);
        continue;
      }
      if (existing === undefined) {
        this.events = [
          ...this.events,
          {
            id,
            server: item.server,
            name,
            timestamp,
            summary: summarize(event.data),
          },
        ].slice(-EVENT_LIMIT);
      } else {
        this.events = this.events.map((entry, at) =>
          at === index ? { ...entry, replayed: undefined } : entry,
        );
      }
      this.notice = `new event from ${item.server}`;
      deliveredNew = true;
      stateChanged = true;
      const tracked =
        subscriptionId === undefined ? undefined : this.viewForAdapter(subscriptionId);
      if (tracked !== undefined) this.persist(tracked);
    }
    if (stateChanged) this.touch();
    return deliveredNew;
  }

  /** Move the subscription's cursor to the event's, registering a subscription seen only through events. */
  private trackCursor(
    item: Record<string, unknown>,
    streamName: string,
    cursor: string | null,
    deliveredAt?: string,
  ): boolean {
    if (typeof item.subscription_id !== "string" || !isRecord(item.event)) return false;
    const current = this.viewForAdapter(item.subscription_id);
    if (current === undefined) {
      const server = typeof item.server === "string" ? item.server : "unknown";
      const subscription: McpSubscriptionView = {
        id: item.subscription_id,
        stableId: deriveStableId(server, streamName, {}),
        server,
        name: streamName,
        status: "active",
        state: "active",
        arguments: {},
        cursor,
        recoveryFailures: 0,
        recoveryPending: false,
        ...(deliveredAt === undefined ? {} : { lastEventAt: deliveredAt }),
      };
      this.storeView(subscription);
      this.persist(subscription);
      return true;
    }
    const nextCursor = serverCursor(current.cursor, cursor);
    if (
      nextCursor === current.cursor &&
      (deliveredAt === undefined || current.lastEventAt === deliveredAt)
    ) {
      return false;
    }
    const next = {
      ...current,
      cursor: nextCursor,
      state: "active" as const,
      lastError: undefined,
      lastErrorAt: undefined,
      recoveryFailures: 0,
      recoveryPending: false,
      ...(deliveredAt === undefined ? {} : { lastEventAt: deliveredAt }),
    };
    this.storeView(next);
    this.persist(next);
    return true;
  }

  /** A stream heartbeat (or active acknowledgement) means the push path is alive. */
  private ingestTraffic(details: unknown): boolean {
    if (!isRecord(details) || typeof details.subscription_id !== "string") return false;
    const current = this.viewForAdapter(details.subscription_id);
    if (current === undefined || current.state === "cancelled") return false;
    const timestamp =
      typeof details.timestamp === "string" && details.timestamp.length > 0
        ? details.timestamp
        : new Date().toISOString();
    const cursor = typeof details.cursor === "string" ? details.cursor : null;
    const alive = current.state !== "active" || current.status === "failed";
    const next: McpSubscriptionView = {
      ...current,
      ...(cursor === null ? {} : { cursor }),
      ...(alive ? { status: "active", state: "active" as const } : {}),
      lastHeartbeatAt: timestamp,
      lastError: undefined,
      lastErrorAt: undefined,
      recoveryFailures: 0,
      recoveryPending: false,
    };
    const changed =
      next.cursor !== current.cursor ||
      next.status !== current.status ||
      next.state !== current.state ||
      next.lastHeartbeatAt !== current.lastHeartbeatAt ||
      current.lastError !== undefined ||
      current.recoveryFailures !== 0 ||
      current.recoveryPending === true;
    if (!changed) return false;
    this.storeView(next);
    this.persist(next);
    this.touch();
    return true;
  }

  private ingestStatuses(details: unknown): boolean {
    if (!isRecord(details) || !Array.isArray(details.subscriptions)) return false;
    let changed = false;
    for (const item of details.subscriptions) {
      const incoming = subscriptionFrom(item);
      if (incoming === null) continue;
      // A queued reconnect/active notice must not revive a cancelled entry.
      if (this.cancellationId(incoming.stableId) !== undefined) continue;
      const deliveredIds = eventIdsFrom(item);
      if (deliveredIds.length > 0) {
        this.restored.add(incoming.stableId);
        this.seedDelivered(incoming.stableId, deliveredIds, true);
      }
      this.seedFromRegistry(incoming.stableId);
      const current = this.viewForAdapter(incoming.id);
      // Once a newer adapter id owns this stable id, a notice for the old id
      // is stale and must not move the visible row back.
      if (current !== undefined && current.id !== incoming.id) continue;
      const saved = this.savedRecord(incoming.stableId);
      const reconnects =
        incoming.status === "active"
          ? 0
          : (current?.reconnects ?? saved?.reconnects ?? incoming.reconnects);
      const incomingState = deriveSubscriptionState(incoming.status, incoming.state);
      const subscription: McpSubscriptionView =
        current === undefined
          ? {
              ...incoming,
              state: incomingState,
              ...(incoming.lastEventAt === undefined && saved?.lastEventAt !== undefined
                ? { lastEventAt: saved.lastEventAt }
                : {}),
              ...(incoming.lastPollAt === undefined && saved?.lastPollAt !== undefined
                ? { lastPollAt: saved.lastPollAt }
                : {}),
              ...(incoming.lastError === undefined && saved?.lastError !== undefined
                ? { lastError: saved.lastError }
                : {}),
              ...(incoming.lastErrorAt === undefined && saved?.lastErrorAt !== undefined
                ? { lastErrorAt: saved.lastErrorAt }
                : {}),
              ...(incoming.recoveryFailures === undefined && saved?.recoveryFailures !== undefined
                ? { recoveryFailures: saved.recoveryFailures }
                : {}),
              ...(incoming.recoveryPending === undefined && saved?.recoveryPending !== undefined
                ? { recoveryPending: saved.recoveryPending }
                : {}),
              ...(incoming.recoveryStartedAt === undefined && saved?.recoveryStartedAt !== undefined
                ? { recoveryStartedAt: saved.recoveryStartedAt }
                : {}),
              ...(reconnects === undefined ? {} : { reconnects }),
              ...(incoming.lastReconnectReason === undefined &&
              saved?.lastReconnectReason !== undefined
                ? { lastReconnectReason: saved.lastReconnectReason }
                : {}),
              ...(incoming.status === "active"
                ? {}
                : { endReason: incoming.endReason ?? saved?.endReason }),
            }
          : {
              ...incoming,
              stableId: current.stableId,
              cursor: serverCursor(current.cursor, incoming.cursor),
              state:
                current.state === "dead" && incoming.status !== "active"
                  ? "dead"
                  : incoming.status === "active"
                    ? "active"
                    : incomingState,
              arguments:
                Object.keys(incoming.arguments).length === 0 &&
                Object.keys(current.arguments).length > 0
                  ? current.arguments
                  : incoming.arguments,
              lastEventAt: current.lastEventAt ?? incoming.lastEventAt ?? saved?.lastEventAt,
              lastHeartbeatAt:
                current.lastHeartbeatAt ?? incoming.lastHeartbeatAt ?? saved?.lastHeartbeatAt,
              lastPollAt: current.lastPollAt ?? incoming.lastPollAt ?? saved?.lastPollAt,
              lastError:
                incoming.status === "active"
                  ? undefined
                  : (incoming.lastError ?? current.lastError ?? saved?.lastError),
              lastErrorAt:
                incoming.status === "active"
                  ? undefined
                  : (incoming.lastErrorAt ?? current.lastErrorAt ?? saved?.lastErrorAt),
              recoveryFailures:
                current.recoveryFailures ?? saved?.recoveryFailures ?? incoming.recoveryFailures,
              recoveryPending:
                current.recoveryPending ?? saved?.recoveryPending ?? incoming.recoveryPending,
              recoveryStartedAt:
                current.recoveryStartedAt ?? saved?.recoveryStartedAt ?? incoming.recoveryStartedAt,
              reconnects,
              lastReconnectReason:
                current.lastReconnectReason ??
                incoming.lastReconnectReason ??
                saved?.lastReconnectReason,
              endReason:
                incoming.status === "active"
                  ? undefined
                  : (incoming.endReason ?? current.endReason ?? saved?.endReason),
            };
      const unchanged =
        current !== undefined &&
        current.name === subscription.name &&
        current.stableId === subscription.stableId &&
        current.status === subscription.status &&
        current.state === subscription.state &&
        current.cursor === subscription.cursor &&
        current.lastEventAt === subscription.lastEventAt &&
        current.lastHeartbeatAt === subscription.lastHeartbeatAt &&
        current.lastPollAt === subscription.lastPollAt &&
        current.lastError === subscription.lastError &&
        current.lastErrorAt === subscription.lastErrorAt &&
        current.recoveryFailures === subscription.recoveryFailures &&
        current.recoveryPending === subscription.recoveryPending &&
        current.recoveryStartedAt === subscription.recoveryStartedAt &&
        sameArguments(current.arguments, subscription.arguments);
      this.storeView(subscription);
      if (unchanged) continue;
      this.persist(subscription);
      changed = true;
    }
    if (!changed) return false;
    this.touch();
    return true;
  }

  private ingestTool(details: unknown): boolean {
    if (!isRecord(details)) return false;
    const args = isRecord(details.args) ? details.args : {};
    const result = details.result;
    if (!isRecord(result)) return false;
    const action = typeof args.action === "string" ? args.action : "";

    if (action === "list" && Array.isArray(result.subscriptions)) {
      const previousViews = [...this.subscriptions.values()];
      const cancelledViews = previousViews.filter(
        (view) => view.status === "cancelled" || this.cancellationId(view.stableId) !== undefined,
      );
      this.subscriptions.clear();
      for (const view of cancelledViews) this.storeView({ ...view, status: "cancelled" });
      for (const item of result.subscriptions) {
        const incoming = subscriptionFrom(item);
        if (incoming === null) continue;
        if (this.cancellationId(incoming.stableId) !== undefined) continue;
        const delivered = eventIdsFrom(item);
        if (delivered.length > 0) {
          this.restored.add(incoming.stableId);
          this.seedDelivered(incoming.stableId, delivered, true);
        }
        this.seedFromRegistry(incoming.stableId);
        const current =
          previousViews.find((view) => view.id === incoming.id) ??
          previousViews.find((view) => view.stableId === incoming.stableId);
        const subscription: McpSubscriptionView = {
          ...incoming,
          stableId: current?.stableId ?? incoming.stableId,
          state: deriveSubscriptionState(incoming.status, incoming.state),
          cursor: serverCursor(current?.cursor ?? null, incoming.cursor),
          recoveryFailures: current?.recoveryFailures ?? incoming.recoveryFailures,
          recoveryPending: current?.recoveryPending ?? incoming.recoveryPending,
          recoveryStartedAt: current?.recoveryStartedAt ?? incoming.recoveryStartedAt,
        };
        this.storeView(subscription);
        this.persist(subscription);
      }
      this.touch();
      return true;
    }

    if (action === "subscribe") {
      const raw = result.subscription;
      const incoming = subscriptionFrom(raw);
      if (incoming === null) return false;
      const cancellationId = this.cancellationId(incoming.stableId);
      if (cancellationId !== undefined && cancellationId === incoming.id) {
        // A late subscribe result for the adapter row that was cancelled.
        return false;
      }
      if (cancellationId !== undefined) this.cancelled.delete(incoming.stableId);
      const current = this.viewForAdapter(incoming.id) ?? this.findByStableId(incoming.stableId);
      const delivered = eventIdsFrom(raw);
      if (delivered.length > 0) {
        this.restored.add(incoming.stableId);
        this.seedDelivered(incoming.stableId, delivered, true);
      }
      if (args.restored === true) this.restored.add(incoming.stableId);
      this.seedFromRegistry(incoming.stableId);
      const saved = this.savedRecord(incoming.stableId);
      const subscription: McpSubscriptionView = {
        ...incoming,
        stableId: current?.stableId ?? incoming.stableId,
        state: deriveSubscriptionState(incoming.status, incoming.state),
        cursor: serverCursor(current?.cursor ?? null, incoming.cursor),
        lastHeartbeatAt:
          current?.lastHeartbeatAt ?? incoming.lastHeartbeatAt ?? saved?.lastHeartbeatAt,
        lastPollAt: current?.lastPollAt ?? incoming.lastPollAt ?? saved?.lastPollAt,
        lastError:
          incoming.status === "active" ? undefined : (incoming.lastError ?? current?.lastError),
        lastErrorAt:
          incoming.status === "active" ? undefined : (incoming.lastErrorAt ?? current?.lastErrorAt),
        recoveryFailures:
          current?.recoveryFailures ?? saved?.recoveryFailures ?? incoming.recoveryFailures,
        recoveryPending:
          current?.recoveryPending ?? saved?.recoveryPending ?? incoming.recoveryPending,
        recoveryStartedAt:
          current?.recoveryStartedAt ?? saved?.recoveryStartedAt ?? incoming.recoveryStartedAt,
        arguments:
          Object.keys(incoming.arguments).length === 0 &&
          current !== undefined &&
          Object.keys(current.arguments).length > 0
            ? current.arguments
            : incoming.arguments,
        lastEventAt: current?.lastEventAt ?? incoming.lastEventAt ?? saved?.lastEventAt,
        reconnects:
          incoming.status === "active"
            ? 0
            : (current?.reconnects ?? saved?.reconnects ?? incoming.reconnects),
        lastReconnectReason:
          current?.lastReconnectReason ??
          incoming.lastReconnectReason ??
          saved?.lastReconnectReason,
        endReason:
          incoming.status === "active"
            ? undefined
            : (incoming.endReason ?? current?.endReason ?? saved?.endReason),
      };
      this.storeView(subscription);
      this.persist(subscription);
      this.touch();
      return true;
    }

    if (action === "unsubscribe" && result.stopped === true) {
      const id = typeof args.subscription_id === "string" ? args.subscription_id : "";
      // Only the current adapter row may move to stopped. A result for an id
      // replaced by a later subscribe must not stop the newer stream.
      const current = id.length > 0 ? this.subscriptions.get(id) : undefined;
      if (current === undefined) return false;
      const subscription = {
        ...current,
        status: "stopped",
        state: "cancelled" as const,
        recoveryPending: false,
        recoveryStartedAt: undefined,
      };
      this.storeView(subscription);
      this.persist(subscription);
      this.touch();
      return true;
    }

    return false;
  }
}

export function liveSubscriptionNames(state: McpEventsState): string[] {
  const names: string[] = [];
  for (const subscription of state.subscriptions) {
    if (!LIVE_STATUS.has(subscription.status)) continue;
    if (!names.includes(subscription.server)) names.push(subscription.server);
  }
  return names;
}
