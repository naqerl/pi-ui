import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  MAX_PENDING_MCP_EVENTS,
  MCP_EVENTS_HEAD,
  parseMcpEventPayload,
} from "../shared/notices.js";
import { mcpEventText, mcpMergedNoticeTexts } from "./chat-service.js";
import { deriveStableId } from "./mcp-subscriptions.js";

/** Events kept in one waiting delivery. Older events are dropped and counted. */
export { MAX_PENDING_MCP_EVENTS };

export interface McpDelivery {
  id: string;
  /** The first text of the delivery; also the whole delivery when it fits. */
  text: string;
  at: string;
  /** Every text of an over-cap merged delivery, in order. Absent when text is enough. */
  texts?: string[];
  /** One part of a multi-part merge; it already carries its own remainder summary. */
  mergedChunk?: boolean;
  /** Event keys folded into this delivery, so a restart keeps the dedupe set. */
  keys?: string[];
}

/** All texts one delivery renders, including a merged delivery that had to split. */
export function deliveryTexts(item: McpDelivery): string[] {
  return item.texts !== undefined && item.texts.length > 0 ? item.texts : [item.text];
}

/** The bounded parts of one logical delivery, each with a stable per-part identity. */
export function deliveryParts(item: McpDelivery): McpDelivery[] {
  const texts = deliveryTexts(item);
  if (texts.length === 1) return [{ ...item, text: texts[0] ?? item.text, texts: undefined }];
  return texts.map((text, index) => ({
    id: `${item.id}:part:${index}`,
    text,
    at: item.at,
    mergedChunk: true,
    ...(item.keys === undefined ? {} : { keys: item.keys }),
  }));
}

interface DeliveryEnvelope {
  head: string;
  items: unknown[];
  dropped: number;
}

const DROP_SUFFIX = / \d+ older events? dropped from this batch\.$/;
const SUMMARY_SUFFIX = / This notice carries \d+ of \d+ merged events; \d+ remain\.$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the same envelope shape chat-service renders and splits. */
function deliveryEnvelope(text: string): DeliveryEnvelope | null {
  if (!text.startsWith(MCP_EVENTS_HEAD)) return null;
  const newline = text.indexOf("\n");
  if (newline < 0) return null;
  const payload = parseMcpEventPayload(text.slice(newline + 1));
  if (payload === null || !Array.isArray(payload.events)) return null;
  return {
    head: text.slice(0, newline),
    items: payload.events,
    dropped: typeof payload.dropped_events === "number" ? payload.dropped_events : 0,
  };
}

/** One transient line, replaced rather than appended when another batch is folded in. */
function batchHead(head: string, dropped: number): string {
  const base = head.replace(SUMMARY_SUFFIX, "").replace(DROP_SUFFIX, "");
  if (dropped <= 0) return base;
  const suffix = dropped === 1 ? "event" : "events";
  return `${base} ${dropped} older ${suffix} dropped from this batch.`;
}

/** Event ids are the dedupe key, including across two subscriptions to one server. */
function eventKey(item: unknown): string {
  if (isRecord(item) && isRecord(item.event)) {
    const event = item.event;
    if (typeof event.eventId === "string" || typeof event.eventId === "number") {
      const generation =
        typeof item.generation === "string" || typeof item.generation === "number"
          ? item.generation
          : typeof event.generation === "string" || typeof event.generation === "number"
            ? event.generation
            : undefined;
      const head = [
        typeof item.server === "string" ? item.server : "",
        typeof event.name === "string" ? event.name : "event",
      ];
      return JSON.stringify(
        generation === undefined ? [...head, event.eventId] : [...head, generation, event.eventId],
      );
    }
  }
  return `event:${JSON.stringify(item)}`;
}

/** Newest keys retained for one stable id in the durable dedupe set. */
export const MAX_SEEN_PER_STABLE_ID = 500;

/** The stable id is the first part of every JSON-array event key. */
function keyStableId(key: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(key);
    return Array.isArray(parsed) && typeof parsed[0] === "string" ? parsed[0] : undefined;
  } catch {
    return undefined;
  }
}

/** Keep the newest keys per stable id, preserving their original global order. */
function boundSeen(keys: readonly string[]): string[] {
  const totals = new Map<string, number>();
  for (const key of keys) {
    const stableId = keyStableId(key);
    if (stableId !== undefined) totals.set(stableId, (totals.get(stableId) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const bounded: string[] = [];
  for (const key of keys) {
    const stableId = keyStableId(key);
    if (stableId === undefined) {
      bounded.push(key);
      continue;
    }
    const index = (seen.get(stableId) ?? 0) + 1;
    seen.set(stableId, index);
    if (index > (totals.get(stableId) ?? 0) - MAX_SEEN_PER_STABLE_ID) bounded.push(key);
  }
  return bounded;
}

/** Stable ids named by an older delivery that predates per-event keys. */
function envelopeStableIds(item: McpDelivery): Set<string> {
  const ids = new Set<string>();
  for (const text of deliveryTexts(item)) {
    const envelope = deliveryEnvelope(text);
    if (envelope === null) continue;
    for (const entry of envelope.items) {
      if (!isRecord(entry) || typeof entry.server !== "string" || !isRecord(entry.event)) continue;
      const name = typeof entry.event.name === "string" ? entry.event.name : "event";
      ids.add(deriveStableId(entry.server, name, {}));
    }
  }
  return ids;
}

function deliveryStableIds(item: McpDelivery): Set<string> {
  const ids = new Set<string>();
  for (const key of item.keys ?? []) {
    const stableId = keyStableId(key);
    if (stableId !== undefined) ids.add(stableId);
  }
  return ids.size === 0 ? envelopeStableIds(item) : ids;
}

/** The cursor/event id is the last part of an event key. */
function keyCursor(key: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(key);
    if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
    const cursor = parsed.at(-1);
    return typeof cursor === "string" || typeof cursor === "number" ? String(cursor) : undefined;
  } catch {
    return undefined;
  }
}

function itemCursor(item: unknown): string | undefined {
  if (!isRecord(item) || !isRecord(item.event)) return undefined;
  const cursor = item.event.eventId ?? item.event.cursor ?? item.event;
  return typeof cursor === "string" || typeof cursor === "number" ? String(cursor) : undefined;
}

/** Remove only one stable id's events from a batch that may also carry siblings. */
function withoutStable(item: McpDelivery, stableId: string): McpDelivery | null {
  const keys = item.keys ?? [];
  const forgottenKeys = keys.filter((key) => keyStableId(key) === stableId);
  if (forgottenKeys.length === 0 && keys.length > 0) return item;
  const keptKeys = keys.filter((key) => keyStableId(key) !== stableId);
  // A split delivery stores every part in `texts`; never rebuild from `text` alone.
  const envelopes = deliveryTexts(item).map(deliveryEnvelope);
  if (envelopes.some((envelope) => envelope === null)) return null;
  const parsed = envelopes as DeliveryEnvelope[];
  const first = parsed[0];
  if (first === undefined) return null;
  const head = batchHead(first.head, 0);
  const dropped = parsed.reduce((total, envelope) => total + envelope.dropped, 0);
  const events = parsed.flatMap((envelope) => envelope.items);
  let kept = events;
  if (keys.length === 0) {
    kept = events.filter((entry) => {
      if (!isRecord(entry) || typeof entry.server !== "string" || !isRecord(entry.event)) {
        return true;
      }
      const name = typeof entry.event.name === "string" ? entry.event.name : "event";
      return deriveStableId(entry.server, name, {}) !== stableId;
    });
  } else if (keys.length === events.length) {
    // The intake supplies one key per event, in envelope order. This also
    // distinguishes two streams that reuse the same cursor in one generation.
    kept = events.filter((_entry, index) => keyStableId(keys[index] ?? "") !== stableId);
  } else {
    // Key/event counts differ when mergeDeliveryTexts dedupes two sibling
    // subscriptions that share a cursor. Cursor-only deletion would then take
    // the surviving sibling with the forgotten one: keep any event that still
    // has a remaining key for that cursor.
    const keptCursors = new Set(
      keptKeys.flatMap((key) => {
        const cursor = keyCursor(key);
        return cursor === undefined ? [] : [cursor];
      }),
    );
    const forgottenCursors = new Set(
      forgottenKeys.flatMap((key) => {
        const cursor = keyCursor(key);
        return cursor === undefined ? [] : [cursor];
      }),
    );
    kept = events.filter((entry) => {
      const cursor = itemCursor(entry);
      if (cursor === undefined || keptCursors.has(cursor)) return true;
      return !forgottenCursors.has(cursor);
    });
  }
  if (kept.length === events.length) {
    return keys.length === 0 ? item : { ...item, keys: keptKeys };
  }
  if (kept.length === 0) return null;
  // Rebuild the split so each surviving part gets a correct remainder summary.
  const texts = mcpMergedNoticeTexts({ head, items: kept, dropped }, kept);
  return {
    ...item,
    text: texts[0] ?? "",
    ...(texts.length <= 1 ? { texts: undefined } : { texts }),
    ...(keptKeys.length === 0 ? { keys: undefined } : { keys: keptKeys }),
  };
}

/** Join delivery texts into bounded envelopes (or one plain notice). */
export function mergeDeliveryTexts(texts: readonly string[]): string[] {
  if (texts.length === 0) return [];
  // An identical notice queued twice (a replay) must not count its gap twice.
  const uniqueTexts = [...new Set(texts)];
  const envelopes = uniqueTexts.map(deliveryEnvelope);
  if (envelopes.every((envelope) => envelope !== null)) {
    const parsed = envelopes as DeliveryEnvelope[];
    const head = parsed[0]?.head ?? MCP_EVENTS_HEAD;
    let dropped = 0;
    const events: unknown[] = [];
    const seen = new Set<string>();
    for (const envelope of parsed) {
      dropped += envelope.dropped;
      for (const item of envelope.items) {
        const key = eventKey(item);
        if (seen.has(key)) continue;
        seen.add(key);
        events.push(item);
      }
    }
    if (events.length > MAX_PENDING_MCP_EVENTS) {
      dropped += events.length - MAX_PENDING_MCP_EVENTS;
      events.splice(0, events.length - MAX_PENDING_MCP_EVENTS);
    }
    const envelope = { head: batchHead(head, dropped), items: events, dropped };
    // A gap-only batch has no events to split, but must still reach chat.
    if (events.length === 0) return [mcpEventText(envelope, [])];
    // Keep the split contract: an over-cap merge renders several bounded parts,
    // each carrying the remaining count, instead of one oversized notice.
    return mcpMergedNoticeTexts(envelope, events);
  }
  // Status and raw notices have no event list. Keep one bounded text rather than
  // turning a merged delivery into a second queue entry.
  return [uniqueTexts.join("\n\n")];
}

function mergeKeys(items: readonly McpDelivery[]): string[] {
  return [...new Set(items.flatMap((item) => item.keys ?? []))];
}

type DeliveryKind = "events" | "notice";

function deliveryKind(item: McpDelivery): DeliveryKind {
  return deliveryEnvelope(item.text) === null ? "notice" : "events";
}

function mergeItems(items: readonly McpDelivery[]): McpDelivery {
  if (items.length === 1) return items[0] as McpDelivery;
  const first = items[0];
  if (first === undefined) throw new Error("Cannot merge an empty delivery");
  const texts = mergeDeliveryTexts(items.flatMap((item) => deliveryTexts(item)));
  const [text = "", ...rest] = texts;
  return {
    id: first.id,
    text,
    at: first.at,
    ...(rest.length === 0 ? {} : { texts }),
    ...(mergeKeys(items).length === 0 ? {} : { keys: mergeKeys(items) }),
  };
}

/** Event envelopes and status/raw notices never share a text: a blank-line join
 * would start with the event head but no longer parse as an envelope. Keep one
 * waiting item of each kind and merge each kind with its own shape. */
function mergeByKind(items: readonly McpDelivery[], freshMergedIds = false): McpDelivery[] {
  const groups: Record<DeliveryKind, McpDelivery[]> = { events: [], notice: [] };
  for (const item of items) groups[deliveryKind(item)].push(item);
  return [groups.events, groups.notice]
    .filter((group) => group.length > 0)
    .map((group) => {
      const merged = mergeItems(group);
      // A single restored item keeps the durable id it was submitted under.
      // Only a real merge of several old rows needs a new request id.
      return freshMergedIds && group.length > 1 ? { ...merged, id: randomUUID() } : merged;
    });
}

/** Persist before acknowledging the provider cursor. Delivery uses a durable request id,
 * so a crash after submission but before removal is harmless. One waiting item, one FIFO
 * retry loop: a burst while the first item is in flight is folded into the next delivery. */
export class McpOutbox {
  private pending: McpDelivery[] = [];
  private seen: string[] = [];
  private writes: Promise<unknown> = Promise.resolve();
  private draining: Promise<void> | undefined;
  private delivering: string | undefined;
  /** Delivered parts whose item removal write has not succeeded yet; keep them protected. */
  private readonly delivered = new Set<string>();
  /** A restored pending item may already be durable; never fold new events into its id. */
  private restoredHead: string | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    private readonly path: string,
    private readonly deliver: (item: McpDelivery) => Promise<void>,
    private readonly retryMs = 1_000,
  ) {}

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.path, "utf8"));
      if (
        data.version !== 1 ||
        !Array.isArray(data.pending) ||
        data.pending.some(
          (item: McpDelivery) =>
            typeof item.id !== "string" ||
            typeof item.text !== "string" ||
            typeof item.at !== "string" ||
            (item.texts !== undefined &&
              (!Array.isArray(item.texts) ||
                item.texts.some((text: unknown) => typeof text !== "string"))),
        )
      )
        throw new Error("Invalid MCP outbox");
      // The first item may already have reached durable before the crash, so
      // keep its request id and deliver it separately. An older file may hold
      // one item per event behind it; that tail is the one waiting delivery.
      const [head, ...tail] = data.pending as McpDelivery[];
      const waiting = mergeByKind(tail, true);
      this.pending = head === undefined ? [] : [head, ...waiting];
      this.restoredHead = head?.id;
      const seen = Array.isArray(data.seen) ? data.seen : [];
      this.seen = boundSeen(seen);
      // Persist a trim left by an older file instead of waiting for a delivery.
      if (this.seen.length !== seen.length) {
        await this.write(this.pending, this.seen);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async write(items: McpDelivery[], seen: string[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const temp = `${this.path}.tmp`;
    await writeFile(temp, `${JSON.stringify({ version: 1, pending: items, seen })}\n`, {
      mode: 0o600,
    });
    await rename(temp, this.path);
  }

  private update(
    change: (items: McpDelivery[]) => McpDelivery[],
    keys: string[] = [],
    forgetStableId?: string,
  ): Promise<void> {
    const run = this.writes.then(async () => {
      const next = change(this.pending);
      const merged = [...new Set([...this.seen, ...keys])].filter(
        (key) => forgetStableId === undefined || keyStableId(key) !== forgetStableId,
      );
      const seen = boundSeen(merged);
      await this.write(next, seen);
      this.pending = next;
      this.seen = seen;
    });
    this.writes = run.catch(() => {});
    return run;
  }

  has(key: string): boolean {
    return this.seen.includes(key);
  }

  /**
   * Drop one stable id's old generation from both the durable seen set and any
   * waiting delivery. Other streams keep their keys and pending batches.
   */
  forgetStable(stableId: string): Promise<void> {
    return this.update(
      (items) =>
        items.flatMap((item) => {
          if (!deliveryStableIds(item).has(stableId)) return [item];
          const kept = withoutStable(item, stableId);
          return kept === null ? [] : [kept];
        }),
      [],
      stableId,
    );
  }

  async enqueue(text: string, keys: string[] = []): Promise<void> {
    await this.enqueueMany([text], keys);
  }

  async enqueueMany(texts: string[], keys: string[] = []): Promise<void> {
    if (this.closed) throw new Error("MCP outbox closed");
    if (texts.length === 0) {
      // A gap-only batch has no novel text but its event keys still belong in
      // the seen set. Keep any pending delivery exactly as it was.
      if (keys.length > 0) await this.update((items) => items, keys);
      return;
    }
    const added = texts.map(
      (text): McpDelivery => ({ id: randomUUID(), text, at: new Date().toISOString() }),
    );
    await this.update((items) => {
      // Resolve the protected item inside the serialized write. Capturing it
      // before this callback lets an enqueue that runs while drain() is just
      // starting merge into an item whose old text is already being delivered.
      const protectedId = this.delivering ?? this.restoredHead;
      const inFlight =
        protectedId === undefined ? undefined : items.find((item) => item.id === protectedId);
      const waiting = items.filter((item) => item.id !== protectedId);
      const merged = mergeByKind([...waiting, ...added]).map((item) => ({
        ...item,
        keys: [...new Set([...(item.keys ?? []), ...keys])],
      }));
      return inFlight === undefined ? merged : [inFlight, ...merged];
    }, keys);
  }

  /** Start after chat recovery, and after newly accepted batches have advanced the feed. */
  start(): void {
    if (this.closed || this.draining !== undefined) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
      if (!this.closed && this.timer === undefined && this.pending.length > 0) this.start();
    });
  }

  private async drain(): Promise<void> {
    try {
      while (!this.closed) {
        await this.writes;
        const item = this.pending[0];
        if (item === undefined) return;
        this.delivering = item.id;
        const parts = deliveryParts(item);
        // A removal-write failure leaves a successfully delivered item in the
        // file. Retry the removal, not the submission: its durable request id
        // already names this exact text, so merging another event into it would
        // be deduplicated away without ever reaching the chat. Each part has its
        // own stable identity, so a retry resumes rather than replaying earlier parts.
        for (const part of parts) {
          if (this.delivered.has(part.id)) continue;
          await this.deliver(part);
          this.delivered.add(part.id);
        }
        await this.update((items) => items.filter((entry) => entry.id !== item.id));
        if (this.restoredHead === item.id) this.restoredHead = undefined;
        for (const part of parts) this.delivered.delete(part.id);
        this.delivering = undefined;
      }
    } catch (error) {
      // Keep delivering/delivered parts: an item already passed to deliver() must
      // stay protected until its removal write succeeds.
      console.error("[mcp] durable delivery pending; will retry", error);
      if (!this.closed) {
        this.timer = setTimeout(() => this.start(), this.retryMs);
        this.timer.unref?.();
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    await this.draining;
    await this.writes;
  }
}

/** Do not let a later cursor overtake a batch whose disk write failed. Shutdown
 * leaves the cursor unacknowledged so the provider can replay it next time. */
export class McpIntake {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(private readonly retryMs = 1_000) {}
  enqueue(accept: () => Promise<void>): void {
    this.tail = this.tail.then(async () => {
      while (!this.closed) {
        try {
          await accept();
          return;
        } catch (error) {
          console.error("[mcp] intake pending; cursor not acknowledged", error);
          await new Promise((resolve) => setTimeout(resolve, this.retryMs));
        }
      }
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
  }
}
