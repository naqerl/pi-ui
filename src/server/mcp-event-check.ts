import type { Transport } from "@modelcontextprotocol/client";
import { hasPosition } from "./mcp-subscriptions.js";

const EVENT_METHOD = "notifications/events/event";
const HEARTBEAT_METHOD = "notifications/events/heartbeat";
const ACTIVE_METHOD = "notifications/events/active";
const STREAM_METHOD = "events/stream";
const SUBSCRIPTION_META = "io.modelcontextprotocol/subscriptionId";

export interface EventTraffic {
  readonly subscriptionId?: string;
  readonly method: string;
  readonly cursor: string | null;
  readonly at: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

export function checkEventNotifications(
  transport: Transport,
  server: string,
  log: (line: string) => void = (line) => console.warn(line),
  observe?: (traffic: EventTraffic) => void,
): Transport {
  let onMessage = transport.onmessage;

  const streams = new Map<string, string>();

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
          } catch {}
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
