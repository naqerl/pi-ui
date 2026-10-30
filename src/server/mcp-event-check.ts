import type { Transport } from "@modelcontextprotocol/client";

/**
 * pi-mcp-events drops an `events/event` notification without a word unless
 * it has a string `eventId` and `timestamp`, a `data` field, a known
 * subscription id, and the exact `name` of the subscription's stream.
 * Heartbeats still move the cursor, so such a server looks subscribed and
 * healthy while every event vanishes (naqerl/pi-ui#3). This check watches the
 * protocol connection and logs, once per server and reason, each frame
 * pi-mcp-events is about to reject. It never changes or drops a frame: the
 * server is the one to fix.
 */

const EVENT_METHOD = "notifications/events/event";
const STREAM_METHOD = "events/stream";
const SUBSCRIPTION_META = "io.modelcontextprotocol/subscriptionId";

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
): Transport {
  let onMessage = transport.onmessage;
  /** Open `events/stream` request id → requested stream name. */
  const streams = new Map<string, string>();
  const reported = new Set<string>();

  transport.onmessage = (message, extra) => {
    const frame = message as unknown;
    if (isRecord(frame)) {
      if (!("method" in frame) && typeof frame.id === "string") streams.delete(frame.id);
      if (frame.method === EVENT_METHOD && !("id" in frame) && isRecord(frame.params)) {
        const meta = frame.params._meta;
        const id = isRecord(meta) ? meta[SUBSCRIPTION_META] : undefined;
        const reason = eventRejection(
          frame.params,
          typeof id === "string" ? streams.get(id) : undefined,
        );
        if (reason !== null && !reported.has(reason)) {
          reported.add(reason);
          log(`[mcp] ${server}: events/event ${reason}; pi-mcp-events drops it`);
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
