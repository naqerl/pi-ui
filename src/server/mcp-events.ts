import type { McpEventsState, McpEventView, McpSubscriptionView } from "../shared/types.js";
import type { McpSubscriptionRecord, McpSubscriptionRegistry } from "./mcp-subscriptions.js";

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

function subscriptionFrom(value: unknown): McpSubscriptionView | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || typeof value.server !== "string") return null;
  const name = typeof value.name === "string" ? value.name : "event";
  const status = typeof value.status === "string" ? value.status : "active";
  const args = isRecord(value.arguments) ? value.arguments : {};
  const cursor = typeof value.cursor === "string" ? value.cursor : null;
  return { id: value.id, server: value.server, name, status, arguments: args, cursor };
}

/**
 * Server-owned MCP subscription list and event log. Every connected client
 * reads this same snapshot, so a second browser does not keep a private feed.
 */
export class McpEventFeed {
  private readonly subscriptions = new Map<string, McpSubscriptionView>();
  /** Numeric cursor high-water per subscription, independent of opaque snapshots. */
  private readonly highWater = new Map<string, number>();
  private events: McpEventView[] = [];
  private notice: string | null = null;
  private revision = 0;

  constructor(private readonly registry?: McpSubscriptionRegistry) {}

  get state(): McpEventsState {
    return {
      subscriptions: [...this.subscriptions.values()],
      events: this.events,
      notice: this.notice,
      revision: this.revision,
    };
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

  private persist(subscription: McpSubscriptionView): void {
    if (this.registry === undefined) return;
    const record: McpSubscriptionRecord = {
      server: subscription.server,
      name: subscription.name,
      arguments: subscription.arguments,
      cursor: subscription.cursor,
      status: subscription.status,
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
    let changed = false;
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
        typeof event.timestamp === "string" ? event.timestamp : new Date().toISOString();
      const id =
        typeof event.eventId === "string"
          ? event.eventId
          : `${item.server}:${name}:${timestamp}:${this.events.length}`;
      const cursor = eventCursor(event);
      const subscriptionId =
        typeof item.subscription_id === "string" ? item.subscription_id : undefined;
      const mark = cursorHighWater(cursor);
      const high = subscriptionId === undefined ? undefined : this.highWater.get(subscriptionId);
      if (mark !== null && high !== undefined && mark <= high) {
        skipped += 1;
        if (!skippedServers.includes(item.server)) skippedServers.push(item.server);
        continue;
      }
      if (this.trackCursor(item, streamName, cursor)) changed = true;
      if (this.events.some((entry) => entry.id === id)) continue;
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
      this.notice = `new event from ${item.server}`;
      changed = true;
      stored += 1;
    }
    if (skipped > 0 && stored > 0) {
      const server = skippedServers[0] ?? "unknown";
      this.notice = `replayed ${skipped} event(s) from ${server}, skipped`;
    }
    if (!changed) return false;
    this.touch();
    return true;
  }

  /** Move the subscription's cursor to the event's, registering a subscription seen only through events. */
  private trackCursor(
    item: Record<string, unknown>,
    streamName: string,
    cursor: string | null,
  ): boolean {
    if (typeof item.subscription_id !== "string" || !isRecord(item.event)) return false;
    const current = this.subscriptions.get(item.subscription_id);
    if (current === undefined) {
      const subscription: McpSubscriptionView = {
        id: item.subscription_id,
        server: typeof item.server === "string" ? item.server : "unknown",
        name: streamName,
        status: "active",
        arguments: {},
        cursor,
      };
      this.subscriptions.set(item.subscription_id, subscription);
      this.observeCursor(subscription.id, cursor);
      this.persist(subscription);
      return true;
    }
    const nextCursor = newerCursor(current.cursor, cursor);
    this.observeCursor(current.id, nextCursor);
    if (nextCursor === current.cursor) return false;
    const next = { ...current, cursor: nextCursor };
    this.subscriptions.set(item.subscription_id, next);
    this.persist(next);
    return true;
  }

  private ingestStatuses(details: unknown): boolean {
    if (!isRecord(details) || !Array.isArray(details.subscriptions)) return false;
    let changed = false;
    for (const item of details.subscriptions) {
      const incoming = subscriptionFrom(item);
      if (incoming === null) continue;
      const current = this.subscriptions.get(incoming.id);
      const subscription =
        current === undefined
          ? incoming
          : {
              ...incoming,
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
        current.status === subscription.status &&
        current.cursor === subscription.cursor &&
        sameArguments(current.arguments, subscription.arguments);
      this.subscriptions.set(subscription.id, subscription);
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
      const previous = new Map(this.subscriptions);
      const previousHighWater = new Map(this.highWater);
      this.subscriptions.clear();
      this.highWater.clear();
      for (const item of result.subscriptions) {
        const incoming = subscriptionFrom(item);
        if (incoming === null) continue;
        const current = previous.get(incoming.id);
        const subscription: McpSubscriptionView = {
          ...incoming,
          cursor: newerCursor(current?.cursor ?? null, incoming.cursor),
        };
        this.subscriptions.set(subscription.id, subscription);
        this.noteHighWater(subscription.id, previousHighWater.get(subscription.id) ?? null);
        this.observeCursor(subscription.id, subscription.cursor);
        this.persist(subscription);
      }
      this.touch();
      return true;
    }

    if (action === "subscribe") {
      const incoming = subscriptionFrom(result.subscription);
      if (incoming === null) return false;
      const current = this.subscriptions.get(incoming.id);
      const subscription: McpSubscriptionView = {
        ...incoming,
        cursor: newerCursor(current?.cursor ?? null, incoming.cursor),
        arguments:
          Object.keys(incoming.arguments).length === 0 &&
          current !== undefined &&
          Object.keys(current.arguments).length > 0
            ? current.arguments
            : incoming.arguments,
      };
      this.subscriptions.set(subscription.id, subscription);
      this.observeCursor(subscription.id, current?.cursor ?? null);
      this.observeCursor(subscription.id, subscription.cursor);
      this.persist(subscription);
      this.touch();
      return true;
    }

    if (action === "unsubscribe" && result.stopped === true) {
      const id = typeof args.subscription_id === "string" ? args.subscription_id : "";
      const current = id.length > 0 ? this.subscriptions.get(id) : undefined;
      if (current === undefined) return false;
      const subscription = { ...current, status: "stopped" };
      this.subscriptions.set(id, subscription);
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
