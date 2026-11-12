import type { Transport } from "@modelcontextprotocol/client";
import { hasPosition } from "./mcp-subscriptions.js";

/**
 * pi-mcp-events drops an `events/event` notification without a word unless
 * it has a string `eventId` and `timestamp`, a `data` field, a known
 * subscription id, and the exact `name` of the subscription's stream.
 * Heartbeats still move the cursor, so such a server looks subscribed and
 * healthy while every event vanishes (naqerl/pi-ui#3). This check watches the
 * protocol connection and logs, once per server and reason, each frame
 * pi-mcp-events is about to reject. Event frames are never changed or
 * dropped: the server is the one to fix. The one edit is on the adapter's own
 * cursor bookkeeping — heartbeat/active frames cannot advance an established
 * subscription past the last event this process actually received.
 */

const EVENT_METHOD = "notifications/events/event";
const HEARTBEAT_METHOD = "notifications/events/heartbeat";
const ACTIVE_METHOD = "notifications/events/active";
const STREAM_METHOD = "events/stream";
const SUBSCRIPTION_META = "io.modelcontextprotocol/subscriptionId";

/** A heartbeat proves the push stream is alive; an activation does not. */
export interface EventTraffic {
  readonly subscriptionId?: string;
  readonly method: string;
  readonly cursor: string | null;
  readonly at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Why pi-mcp-events would reject this `events/event` payload, or null when it
 * would accept it. `stream` is the subscription's requested name, undefined
 * when the subscription is not known.
 */
export function eventRejection(
  params: Record<string, unknown>,
  stream: string | undefined,
): string | null {
  if (stream === undefined) return "has no known subscription id";
  if (typeof params.eventId !== "string") return `has a ${typeof params.eventId} eventId`;
  if (typeof params.timestamp !== "string") return `has a ${typeof params.timestamp} timestamp`;
  if (!("data" in params)) return "has no data";
  if (params.name !== stream) {
    return typeof params.name === "string"
      ? `is named "${params.name}", not its stream "${stream}"`
      : "has no name";
  }
  return null;
}

/**
 * Wrap a protocol transport to log `events/event` frames pi-mcp-events will
 * drop. Same handler-swapping pattern as `watchStaleSession`: the router
 * installs `onmessage` on the returned proxy, and every frame is passed on
 * exactly as it arrived.
 */
export function checkEventNotifications(
  transport: Transport,
  server: string,
  log: (line: string) => void = (line) => console.warn(line),
  observe?: (traffic: EventTraffic) => void,
): Transport {
  let onMessage = transport.onmessage;
  /** Open `events/stream` request id → requested stream name. */
  const streams = new Map<string, string>();
  /** Last event cursor actually delivered for a subscription, never a heartbeat. */
  const deliveredCursor = new Map<string, string>();
  const reported = new Set<string>();

  transport.onmessage = (message, extra) => {
    const frame = message as unknown;
    if (isRecord(frame)) {
      if (!("method" in frame) && typeof frame.id === "string") streams.delete(frame.id);
      if (!("id" in frame) && isRecord(frame.params)) {
        const meta = frame.params._meta;
        const id = isRecord(meta) ? meta[SUBSCRIPTION_META] : undefined;
        const subscriptionId = typeof id === "string" ? id : undefined;
        if (frame.method === EVENT_METHOD) {
          const reason = eventRejection(
            frame.params,
            subscriptionId === undefined ? undefined : streams.get(subscriptionId),
          );
          if (reason !== null) {
            if (!reported.has(reason)) {
              reported.add(reason);
              log(`[mcp] ${server}: events/event ${reason}; pi-mcp-events drops it`);
            }
          } else if (subscriptionId !== undefined) {
            // The hub puts the position in `data.cursor` and leaves the
            // envelope cursor null. pi-mcp-events only reads the envelope, so
            // propagate the real position before handing it the frame.
            const data = isRecord(frame.params.data) ? frame.params.data : undefined;
            const cursor =
              typeof data?.cursor === "string" && hasPosition(data.cursor)
                ? data.cursor
                : typeof frame.params.cursor === "string" && hasPosition(frame.params.cursor)
                  ? frame.params.cursor
                  : undefined;
            if (cursor !== undefined) {
              deliveredCursor.set(subscriptionId, cursor);
              frame.params.cursor = cursor;
            }
          }
        }
        if (
          subscriptionId !== undefined &&
          (frame.method === HEARTBEAT_METHOD || frame.method === ACTIVE_METHOD)
        ) {
          // pi-mcp-events keeps one `sub.cursor` and uses it for the next
          // re-subscribe. A heartbeat or a re-activation may be ahead of the
          // last event pi-ui was handed, so resuming from it silently skips
          // that event. Pin an established subscription to its last delivered
          // event, while a brand-new stream (no event yet) keeps the cursor the
          // server announced.
          const last = deliveredCursor.get(subscriptionId);
          if (last !== undefined) frame.params.cursor = last;
        }
        if (observe !== undefined && frame.method === HEARTBEAT_METHOD) {
          try {
            observe({
              ...(subscriptionId === undefined ? {} : { subscriptionId }),
              method: frame.method,
              cursor: typeof frame.params.cursor === "string" ? frame.params.cursor : null,
              at: new Date().toISOString(),
            });
          } catch {
            // Observing traffic must never affect frame delivery.
          }
        }
      }
    }
    onMessage?.(message, extra);
  };

  return new Proxy(transport, {
    get(target, property) {
      if (property === "onmessage") return onMessage;
      if (property === "send") {
        return (message: unknown, options?: unknown) => {
          if (isRecord(message) && isRecord(message.params)) {
            if (
              message.method === STREAM_METHOD &&
              typeof message.id === "string" &&
              typeof message.params.name === "string"
            ) {
              streams.set(message.id, message.params.name);
            } else if (
              message.method === "notifications/cancelled" &&
              typeof message.params.requestId === "string"
            ) {
              streams.delete(message.params.requestId);
            }
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
