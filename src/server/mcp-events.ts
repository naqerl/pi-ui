import type { McpEventsState, McpEventView, McpSubscriptionView } from "../shared/types.js";

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
  private events: McpEventView[] = [];
  private notice: string | null = null;
  private revision = 0;

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

  private ingestEvents(details: unknown): boolean {
    if (!isRecord(details) || !Array.isArray(details.events)) return false;
    let changed = false;
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
      if (this.trackCursor(item, streamName)) changed = true;
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
    }
    if (!changed) return false;
    this.touch();
    return true;
  }

  /** Move the subscription's cursor to the event's, registering a subscription seen only through events. */
  private trackCursor(item: Record<string, unknown>, streamName: string): boolean {
    if (typeof item.subscription_id !== "string" || !isRecord(item.event)) return false;
    const cursor = typeof item.event.cursor === "string" ? item.event.cursor : null;
    const current = this.subscriptions.get(item.subscription_id);
    if (current === undefined) {
      this.subscriptions.set(item.subscription_id, {
        id: item.subscription_id,
        server: typeof item.server === "string" ? item.server : "unknown",
        name: streamName,
        status: "active",
        arguments: {},
        cursor,
      });
      return true;
    }
    if (cursor === null || cursor === current.cursor) return false;
    this.subscriptions.set(item.subscription_id, { ...current, cursor });
    return true;
  }

  private ingestStatuses(details: unknown): boolean {
    if (!isRecord(details) || !Array.isArray(details.subscriptions)) return false;
    let changed = false;
    for (const item of details.subscriptions) {
      const subscription = subscriptionFrom(item);
      if (subscription === null) continue;
      this.subscriptions.set(subscription.id, subscription);
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
      this.subscriptions.clear();
      for (const item of result.subscriptions) {
        const subscription = subscriptionFrom(item);
        if (subscription !== null) this.subscriptions.set(subscription.id, subscription);
      }
      this.touch();
      return true;
    }

    if (action === "subscribe") {
      const subscription = subscriptionFrom(result.subscription);
      if (subscription === null) return false;
      this.subscriptions.set(subscription.id, subscription);
      this.touch();
      return true;
    }

    if (action === "unsubscribe" && result.stopped === true) {
      const id = typeof args.subscription_id === "string" ? args.subscription_id : "";
      const current = id.length > 0 ? this.subscriptions.get(id) : undefined;
      if (current === undefined) return false;
      this.subscriptions.set(id, { ...current, status: "stopped" });
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
