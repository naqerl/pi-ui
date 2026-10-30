import type { Transport } from "@modelcontextprotocol/client";

/**
 * pi-mcp-events drops an `events/event` notification without a word unless
 * it has a string `eventId` and `timestamp`, a `data` field, and the exact
 * `name` of the subscription's stream. Heartbeats still move the cursor, so a
 * server that sends, say, numeric ids or a `hub.job` kind on a `hub` stream
 * looks subscribed and healthy while every event vanishes. This guard sits
 * between the MCP client and the adapter's stream router. It repairs what has
 * one obvious meaning, logs each repair or drop once per server and reason,
 * and passes everything else through untouched.
 */

const EVENT_METHOD = "notifications/events/event";
const EVENTS_PREFIX = "notifications/events/";
const STREAM_METHOD = "events/stream";
const SUBSCRIPTION_META = "io.modelcontextprotocol/subscriptionId";
/** Limits pi-mcp-events enforces; longer values are dropped there. */
const MAX_EVENT_ID = 1024;
const MAX_NAME = 256;
const MAX_TIMESTAMP = 80;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export type EventRepair =
  | { kind: "kept"; params: Record<string, unknown>; repairs: string[] }
  | { kind: "dropped"; reason: string };

function isoFrom(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  // Seconds and milliseconds since the epoch are both common on the wire.
  const date = new Date(Math.abs(value) < 1e12 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Repair one `events/event` payload for the stream it belongs to. `stream` is
 * the `name` the subscription asked for, or undefined when it is not known.
 * A differing `name` is kept in `data.eventName` (record data only), and the
 * event is renamed to the stream so pi-mcp-events delivers it.
 */
export function repairEventParams(
  params: Record<string, unknown>,
  stream: string | undefined,
): EventRepair {
  const next: Record<string, unknown> = { ...params };
  const repairs: string[] = [];

  if (typeof next.eventId === "number" && Number.isFinite(next.eventId)) {
    next.eventId = String(next.eventId);
    repairs.push("numeric eventId");
  } else if (typeof next.eventId !== "string") {
    if (typeof next.cursor !== "string") return { kind: "dropped", reason: "no eventId" };
    next.eventId = next.cursor;
    repairs.push("eventId taken from cursor");
  }

  if (typeof next.timestamp === "number") {
    const iso = isoFrom(next.timestamp);
    if (iso === null) return { kind: "dropped", reason: "invalid timestamp" };
    next.timestamp = iso;
    repairs.push("numeric timestamp");
  } else if (typeof next.timestamp !== "string") {
    next.timestamp = new Date().toISOString();
    repairs.push("missing timestamp");
  }

  if (!("data" in next)) {
    next.data = null;
    repairs.push("missing data");
  }

  if (stream !== undefined && next.name !== stream) {
    const original = next.name;
    if (typeof original === "string" && isRecord(next.data) && !("eventName" in next.data)) {
      next.data = { ...next.data, eventName: original };
    }
    next.name = stream;
    repairs.push(
      typeof original === "string"
        ? `event name "${original}" is not the stream name "${stream}"`
        : "missing event name",
    );
  }

  if (
    (next.eventId as string).length > MAX_EVENT_ID ||
    typeof next.name !== "string" ||
    next.name.length > MAX_NAME ||
    (next.timestamp as string).length > MAX_TIMESTAMP
  ) {
    return { kind: "dropped", reason: "eventId, name or timestamp too long" };
  }
  return { kind: "kept", params: next, repairs };
}

function subscriptionOf(params: Record<string, unknown>): string | undefined {
  const meta = params._meta;
  if (!isRecord(meta)) return undefined;
  const id = meta[SUBSCRIPTION_META];
  return typeof id === "string" ? id : undefined;
}

/**
 * Wrap a protocol transport so `events/event` notifications reach
 * pi-mcp-events in a shape it accepts. Same handler-swapping pattern as
 * `watchStaleSession`: the router installs `onmessage` on the returned proxy,
 * frames are delivered by the wrapped transport.
 */
export function guardEventNotifications(
  transport: Transport,
  server: string,
  log: (line: string) => void = (line) => console.warn(line),
): Transport {
  let onMessage = transport.onmessage;
  /** Open `events/stream` request id → requested stream name. */
  const streams = new Map<string, string>();
  const reported = new Set<string>();
  const report = (reason: string, outcome: string) => {
    if (reported.has(reason)) return;
    reported.add(reason);
    log(`[mcp] ${server}: events/event ${reason}; ${outcome}`);
  };

  transport.onmessage = (message, extra) => {
    const frame = message as unknown;
    if (!isRecord(frame)) {
      onMessage?.(message, extra);
      return;
    }
    if (!("method" in frame) && typeof frame.id === "string") streams.delete(frame.id);
    const method = frame.method;
    if (typeof method !== "string" || !method.startsWith(EVENTS_PREFIX) || "id" in frame) {
      onMessage?.(message, extra);
      return;
    }
    if (!isRecord(frame.params)) {
      onMessage?.(message, extra);
      return;
    }
    let params = frame.params;
    let subscription = subscriptionOf(params);
    if (subscription === undefined || !streams.has(subscription)) {
      // With a single open stream there is only one place the frame can go.
      if (streams.size === 1) {
        const only = streams.keys().next().value as string;
        params = {
          ...params,
          _meta: { ...(isRecord(params._meta) ? params._meta : {}), [SUBSCRIPTION_META]: only },
        };
        report(
          `${method.slice(EVENTS_PREFIX.length)} without a known subscription id`,
          "routed to the only open stream",
        );
        subscription = only;
      } else if (method === EVENT_METHOD) {
        report("without a known subscription id", "pi-mcp-events cannot route it");
      }
    }
    if (method === EVENT_METHOD) {
      const repaired = repairEventParams(
        params,
        subscription === undefined ? undefined : streams.get(subscription),
      );
      if (repaired.kind === "dropped") {
        report(repaired.reason, "dropped");
        return;
      }
      for (const repair of repaired.repairs) report(repair, "repaired");
      params = repaired.params;
    }
    onMessage?.({ ...frame, params } as typeof message, extra);
  };

  return new Proxy(transport, {
    get(target, property) {
      if (property === "onmessage") return onMessage;
      if (property === "send") {
        return (message: unknown, options?: unknown) => {
          if (
            isRecord(message) &&
            message.method === STREAM_METHOD &&
            typeof message.id === "string" &&
            isRecord(message.params) &&
            typeof message.params.name === "string"
          ) {
            streams.set(message.id, message.params.name);
          } else if (
            isRecord(message) &&
            message.method === "notifications/cancelled" &&
            isRecord(message.params) &&
            typeof message.params.requestId === "string"
          ) {
            streams.delete(message.params.requestId);
          }
          return (target.send as (m: unknown, o?: unknown) => Promise<void>).call(
            target,
            message,
            options,
          );
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      if (property === "onmessage") {
        onMessage = typeof value === "function" ? (value as Transport["onmessage"]) : undefined;
        return true;
      }
      return Reflect.set(target, property, value, target);
    },
  });
}
