import { toIsoTimestamp } from "../shared/time.js";
import type { McpEventsState, McpEventView, McpSubscriptionView } from "../shared/types.js";
import {
  deriveStableId,
  MAX_DELIVERED_EVENT_IDS,
  type McpSubscriptionRecord,
  type McpSubscriptionRegistry,
  recordStableId,
  subscriptionEnabled,
} from "./mcp-subscriptions.js";

export interface ExtensionNotice {
  customType?: string;
  details?: unknown;
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

/**
 * The comparable high-water mark of a cursor. Hub event cursors are
 * `hub:<n>`; anything else, including `hub:snapshot:a:b`, is opaque and can
 * only be stored, never compared.
 */
export function cursorHighWater(cursor: string | null | undefined): number | null {
  if (typeof cursor !== "string") return null;
  const match = /^hub:(\d+)$/.exec(cursor);
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

/** Alias used by callers that describe the value rather than the mark. */
export const comparableCursor = cursorHighWater;

/** The real position rides in `event.data.cursor`; the envelope cursor is often null. */
export function eventCursor(event: Record<string, unknown>): string | null {
  if (isRecord(event.data) && typeof event.data.cursor === "string") return event.data.cursor;
  return typeof event.cursor === "string" ? event.cursor : null;
}

function newerCursor(current: string | null, incoming: string | null): string | null {
  if (incoming === null) return current;
  if (current === null) return incoming;
  const currentMark = cursorHighWater(current);
  const incomingMark = cursorHighWater(incoming);
  if (currentMark !== null && incomingMark !== null && incomingMark < currentMark) return current;
  return incoming;
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
  return {
    id: value.id,
    stableId,
    server: value.server,
    name,
    ...(title === undefined ? {} : { title }),
    status,
    arguments: args,
    cursor,
  };
}

/**
 * Server-owned MCP subscription list and event log. Every connected client
 * reads this same snapshot, so a second browser does not keep a private feed.
 *
 * Replay detection is keyed by the durable stable id, not the adapter id: the
 * registry keeps the last `MAX_DELIVERED_EVENT_IDS` event ids for each stable
 * id. Ids seen before this process started are historical, so they are stored
 * with `replayed: true` and never become a chat notice. An id first delivered
 * by this process is live; a duplicate of it is dropped, but that first live
 * delivery always wins.
 */
export class McpEventFeed {
  private readonly subscriptions = new Map<string, McpSubscriptionView>();
  /** Numeric cursor high-water per subscription, independent of opaque snapshots. */
  private readonly highWater = new Map<string, number>();
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
  private revision = 0;

  constructor(private readonly registry?: McpSubscriptionRegistry) {
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
      const cancelled = { ...subscription, status: "cancelled" };
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
    return false;
  }

  private touch(): void {
    this.revision += 1;
  }

  private noteHighWater(id: string, mark: number | null): void {
    if (mark === null) return;
    const current = this.highWater.get(id);
    if (current === undefined || mark > current) this.highWater.set(id, mark);
  }

  private observeCursor(id: string, cursor: string | null): void {
    this.noteHighWater(id, cursorHighWater(cursor));
  }

  private seedRecords(records: readonly McpSubscriptionRecord[]): void {
    for (const record of records) {
      const stableId = recordStableId(record);
      this.restored.add(stableId);
      this.seedDelivered(stableId, record.deliveredEventIds ?? [], true);
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

  /** Seed from a row for a stable id if this feed has not seen the stream yet. */
  private seedFromRegistry(stableId: string): void {
    if (this.registry === undefined) return;
    const record = this.registry.list().find((entry) => recordStableId(entry) === stableId);
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
      return false;
    }
    delivered.add(eventId);
    if (historical) ids.add(eventId);
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

  private isHistorical(stableId: string, eventId: string | undefined): boolean {
    return eventId !== undefined && this.historical.get(stableId)?.has(eventId) === true;
  }

  private isLiveDuplicate(stableId: string, eventId: string | undefined): boolean {
    return (
      eventId !== undefined &&
      this.delivered.get(stableId)?.has(eventId) === true &&
      !this.isHistorical(stableId, eventId)
    );
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
      enabled: subscriptionEnabled(subscription.status),
      deliveredEventIds: this.deliveredIds(subscription.stableId),
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
    let replayStored = 0;
    let skipped = 0;
    let stored = 0;
    const skippedServers: string[] = [];
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
      const mark = cursorHighWater(cursor);
      const high = current === undefined ? undefined : this.highWater.get(current.id);
      const cursorReplay = mark !== null && high !== undefined && mark <= high;
      const historical = this.isHistorical(stableId, eventId);
      const liveDuplicate = this.isLiveDuplicate(stableId, eventId);
      const replay = historical || (cursorReplay && !liveDuplicate && this.restored.has(stableId));

      if (replay) {
        // A restored stream may redeliver an event whose id we know, or whose
        // cursor is already behind us. Keep it visibly marked, but never make
        // it a chat notice.
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
          replayStored += 1;
          stateChanged = true;
        }
        const tracked =
          subscriptionId === undefined ? undefined : this.viewForAdapter(subscriptionId);
        if (tracked !== undefined) this.persist(tracked);
        continue;
      }

      if (liveDuplicate) {
        // The first live copy already won. The one exception is a copy that
        // was only known as a replay before: now that it arrived live, deliver
        // exactly one non-replayed event for it.
        const index = this.events.findIndex((entry) => entry.id === id);
        const existing = index === -1 ? undefined : this.events[index];
        if (existing?.replayed === true) {
          this.events = this.events.map((entry, at) =>
            at === index ? { ...entry, replayed: undefined } : entry,
          );
          this.notice = `new event from ${item.server}`;
          deliveredNew = true;
          stored += 1;
          stateChanged = true;
        }
        if (this.trackCursor(item, streamName, cursor)) stateChanged = true;
        const tracked =
          subscriptionId === undefined ? undefined : this.viewForAdapter(subscriptionId);
        if (tracked !== undefined) this.persist(tracked);
        continue;
      }

      if (cursorReplay) {
        // A live stream at or below its high-water mark is a duplicate of an
        // event this process already saw. Drop it as before.
        skipped += 1;
        if (!skippedServers.includes(item.server)) skippedServers.push(item.server);
        continue;
      }

      if (this.trackCursor(item, streamName, cursor)) stateChanged = true;
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
      stored += 1;
      stateChanged = true;
      const tracked =
        subscriptionId === undefined ? undefined : this.viewForAdapter(subscriptionId);
      if (tracked !== undefined) this.persist(tracked);
    }
    if (skipped > 0 && (stored > 0 || replayStored > 0)) {
      const server = skippedServers[0] ?? "unknown";
      this.notice = `replayed ${skipped} event(s) from ${server}, skipped`;
    }
    if (stateChanged) this.touch();
    return deliveredNew;
  }

  /** Move the subscription's cursor to the event's, registering a subscription seen only through events. */
  private trackCursor(
    item: Record<string, unknown>,
    streamName: string,
    cursor: string | null,
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
        arguments: {},
        cursor,
      };
      this.storeView(subscription);
      this.observeCursor(subscription.id, cursor);
      this.persist(subscription);
      return true;
    }
    const nextCursor = newerCursor(current.cursor, cursor);
    this.observeCursor(current.id, nextCursor);
    if (nextCursor === current.cursor) return false;
    const next = { ...current, cursor: nextCursor };
    this.storeView(next);
    this.persist(next);
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
      const subscription =
        current === undefined
          ? incoming
          : {
              ...incoming,
              stableId: current.stableId,
              cursor: newerCursor(current.cursor, incoming.cursor),
              arguments:
                Object.keys(incoming.arguments).length === 0 &&
                Object.keys(current.arguments).length > 0
                  ? current.arguments
                  : incoming.arguments,
            };
      this.observeCursor(subscription.id, current?.cursor ?? null);
      this.observeCursor(subscription.id, subscription.cursor);
      const unchanged =
        current !== undefined &&
        current.name === subscription.name &&
        current.stableId === subscription.stableId &&
        current.status === subscription.status &&
        current.cursor === subscription.cursor &&
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
      const previousHighWater = new Map(this.highWater);
      const cancelledViews = previousViews.filter(
        (view) => view.status === "cancelled" || this.cancellationId(view.stableId) !== undefined,
      );
      this.subscriptions.clear();
      this.highWater.clear();
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
          cursor: newerCursor(current?.cursor ?? null, incoming.cursor),
        };
        this.storeView(subscription);
        const previousId = current?.id ?? incoming.id;
        this.noteHighWater(
          subscription.id,
          previousHighWater.get(previousId) ?? previousHighWater.get(incoming.id) ?? null,
        );
        this.observeCursor(subscription.id, subscription.cursor);
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
      const subscription: McpSubscriptionView = {
        ...incoming,
        stableId: current?.stableId ?? incoming.stableId,
        cursor: newerCursor(current?.cursor ?? null, incoming.cursor),
        arguments:
          Object.keys(incoming.arguments).length === 0 &&
          current !== undefined &&
          Object.keys(current.arguments).length > 0
            ? current.arguments
            : incoming.arguments,
      };
      this.storeView(subscription);
      this.observeCursor(subscription.id, current?.cursor ?? null);
      this.observeCursor(subscription.id, subscription.cursor);
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
      const subscription = { ...current, status: "stopped" };
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
