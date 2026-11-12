import { boundMcpEventBatch, MCP_STATUS_HEAD } from "../shared/notices.js";
import { toIsoTimestamp } from "../shared/time.js";
import type { McpEventsState, McpEventView, McpSubscriptionView } from "../shared/types.js";
import {
  deriveStableId,
  deriveSubscriptionState,
  hasPosition,
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
/**
 * A restart is allowed to replay what it missed while it was down, but only
 * for a short window and only for a handful of events. A stream whose first
 * missed event predates this process by more than the grace horizon is old
 * history, not a restart: resuming it would replay days of backlog into the
 * chat queue. A short outage on a busy hub is the same problem in miniature —
 * ten minutes can hold a hundred events — so a full probe page means "this is
 * a backlog, not a handful", however recent it looks. This is also the age
 * gate for the stream itself, so every ingest path uses the same horizon.
 */
export const RESTORE_GRACE_MS = 15 * 60_000;
/** A restored stream is capped for this long; a continuous replay cannot outrun the outbox. */
const RESTORE_CAP_WINDOW_MS = RESTORE_GRACE_MS;

/**
 * A stream the user could still be depending on. `failed` is deliberately not
 * live: retry exhaustion is the outage the status notice must announce.
 */
function isLiveSubscription(view: McpSubscriptionView): boolean {
  if (view.state === "cancelled" || view.state === "dead" || view.state === "stalled") return false;
  return view.status === "active" || view.status === "reconnecting" || view.status === "opening";
}

/**
 * The extension's own heartbeat deadline. A stream that ends has not stopped
 * delivering until this long passes without an event or heartbeat: the adapter
 * reconnects inside that window and a quick generation swap is not an outage.
 */
export const MCP_STREAM_HEARTBEAT_TIMEOUT_MS = 65_000;

function parsedTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** The newest proof that this subscription delivered something. */
function lastDeliveryAt(view: McpSubscriptionView): number | undefined {
  const eventAt = parsedTime(view.lastEventAt);
  const heartbeatAt = parsedTime(view.lastHeartbeatAt);
  if (eventAt === undefined) return heartbeatAt;
  if (heartbeatAt === undefined) return eventAt;
  return Math.max(eventAt, heartbeatAt);
}

/** True while the silence still fits inside the extension's heartbeat window. */
function deliveryIsFresh(view: McpSubscriptionView, now = Date.now()): boolean {
  const at = lastDeliveryAt(view);
  return at !== undefined && now - at <= MCP_STREAM_HEARTBEAT_TIMEOUT_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One bounded event list plus how many events were too old to deliver. */
export interface FreshMcpEvents {
  readonly items: unknown[];
  readonly dropped: number;
}

function eventTimestampMs(event: Record<string, unknown>): number | undefined {
  const raw = event.timestamp;
  const parsed =
    typeof raw === "number"
      ? raw
      : typeof raw === "string"
        ? Date.parse(raw)
        : raw instanceof Date
          ? raw.getTime()
          : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function eventLabel(item: Record<string, unknown>): string {
  const event = isRecord(item.event) ? item.event : {};
  const server = typeof item.server === "string" ? item.server : "unknown";
  const name = typeof event.name === "string" ? event.name : "event";
  const id = typeof event.eventId === "string" ? ` ${event.eventId}` : "";
  return `${server}/${name}${id}`;
}

/**
 * A stream can reconnect and hand over its adapter's own buffered backlog,
 * not only the replay the cursor probe saw. The only thing pi-ui can judge is
 * whether an event is news, so each event is tested against the restore grace
 * individually: one old sibling must not drop a fresh event, and one fresh
 * sibling must not carry an old event into the queue. An event without a usable
 * timestamp cannot be judged, so it is delivered as before and logged.
 */
export function filterStaleMcpEvents(
  items: readonly unknown[],
  startedAt: number,
  log = true,
): FreshMcpEvents {
  const cutoff = startedAt - RESTORE_GRACE_MS;
  const fresh: unknown[] = [];
  let dropped = 0;
  for (const item of items) {
    if (!isRecord(item) || !isRecord(item.event)) {
      fresh.push(item);
      continue;
    }
    const at = eventTimestampMs(item.event);
    if (at === undefined) {
      if (log) {
        console.debug(
          `[mcp] delivering ${eventLabel(item)} without a usable timestamp; its age cannot be judged`,
        );
      }
      fresh.push(item);
      continue;
    }
    if (at < cutoff) {
      dropped += 1;
      if (log) {
        console.debug(
          `[mcp] dropped ${eventLabel(item)} older than the restore grace (${new Date(
            at,
          ).toISOString()} < ${new Date(cutoff).toISOString()})`,
        );
      }
      continue;
    }
    fresh.push(item);
  }
  return { items: fresh, dropped };
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

/**
 * Cursors are opaque, but a zero position is not a position. Keep the last real
 * cursor instead of letting a `:0` from an event or heartbeat become the value
 * a later transport subscribes from.
 */
function serverCursor(current: string | null, incoming: string | null): string | null {
  if (hasPosition(incoming)) return incoming;
  if (hasPosition(current)) return current;
  return null;
}

/** The first real position in priority order; never returns a zero cursor. */
function positionOf(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (hasPosition(value)) return value;
  }
  return null;
}

function sameArguments(first: Record<string, unknown>, second: Record<string, unknown>): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

/**
 * Trailing number of a cursor-style id (`hub:738` → 738). Hub ids are cursor
 * strings, so a reinstall or a state reset restarts the numbering; ids from an
 * older generation then collide with fresh ones and would look delivered.
 */
function idSequence(value: string): number | undefined {
  // A cursor-style id (`hub:738`) or a bare sequence is comparable. A
  // synthetic event id such as `event-5` has a trailing number but says
  // nothing about the hub cursor.
  const match = /^(\d+)$/.exec(value) ?? /:(\d+)$/.exec(value);
  if (match === null) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function eventIdsFrom(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.deliveredEventIds)) return [];
  return value.deliveredEventIds.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
  );
}

/** A server-stated generation, or the adapter session identity beside it. */
function subscriptionGeneration(value: Record<string, unknown>): string | number | undefined {
  for (const candidate of [
    value.generation,
    value.sessionId,
    value.session_id,
    value.adapterSessionId,
    value.adapter_session_id,
  ]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

function sameGeneration(
  first: string | number | undefined,
  second: string | number | undefined,
): boolean {
  return first !== undefined && second !== undefined && String(first) === String(second);
}

function subscriptionFrom(value: unknown): McpSubscriptionView | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || typeof value.server !== "string") return null;
  const name = typeof value.name === "string" ? value.name : "event";
  const status = typeof value.status === "string" ? value.status : "active";
  const args = isRecord(value.arguments) ? value.arguments : {};
  const cursor = typeof value.cursor === "string" ? value.cursor : null;
  const generation = subscriptionGeneration(value);
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
    ...(generation === undefined ? {} : { generation }),
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

interface StatusView {
  id?: string;
  stableId?: string;
  status?: string;
  server?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

function collectStatusViews(value: unknown, views: StatusView[], depth = 0): void {
  if (depth > 3 || !isRecord(value)) return;
  const id =
    typeof value.id === "string"
      ? value.id
      : typeof value.subscription_id === "string"
        ? value.subscription_id
        : typeof value.subscriptionId === "string"
          ? value.subscriptionId
          : undefined;
  const stableId =
    typeof value.stableId === "string"
      ? value.stableId
      : typeof value.stable_id === "string"
        ? value.stable_id
        : undefined;
  const status = typeof value.status === "string" ? value.status : undefined;
  const server = typeof value.server === "string" ? value.server : undefined;
  const name = typeof value.name === "string" ? value.name : undefined;
  const args = isRecord(value.arguments) ? value.arguments : undefined;
  if (id !== undefined || stableId !== undefined || status !== undefined) {
    views.push({
      ...(id === undefined ? {} : { id }),
      ...(stableId === undefined ? {} : { stableId }),
      ...(status === undefined ? {} : { status }),
      ...(server === undefined ? {} : { server }),
      ...(name === undefined ? {} : { name }),
      ...(args === undefined ? {} : { arguments: args }),
    });
  }
  if (Array.isArray(value.ids)) {
    for (const entry of value.ids) {
      if (typeof entry === "string" && entry.length > 0) views.push({ id: entry });
    }
  }
  if (isRecord(value.subscription)) collectStatusViews(value.subscription, views, depth + 1);
  if (Array.isArray(value.subscriptions)) {
    for (const item of value.subscriptions) collectStatusViews(item, views, depth + 1);
  } else if (isRecord(value.subscriptions)) {
    collectStatusViews(value.subscriptions, views, depth + 1);
  }
  if (Array.isArray(value.items)) {
    for (const item of value.items) collectStatusViews(item, views, depth + 1);
  }
}

/**
 * The one parser for status identity and state. JSON items name an id and a
 * state; prose can name either a bare adapter id, `subscription=<id>`, or an
 * `id is <state>` line. Identity checks and outage tracking read this same set.
 */
function statusViews(text: string, details: unknown): StatusView[] {
  const views: StatusView[] = [];
  collectStatusViews(details, views);
  const payloadStart = text.indexOf("{");
  if (payloadStart >= 0) {
    try {
      collectStatusViews(JSON.parse(text.slice(payloadStart)), views);
    } catch {
      // A prose line can contain a brace; it is not a status payload.
    }
  }
  const body = text.startsWith(MCP_STATUS_HEAD) ? text.slice(MCP_STATUS_HEAD.length) : text;
  for (const match of body.matchAll(/\bmcp-extension-[A-Za-z0-9][A-Za-z0-9._:-]*/gi)) {
    const id = match[0]?.replace(/[.:]+$/, "");
    if (id !== undefined && id.length > 0) views.push({ id });
  }
  for (const match of body.matchAll(
    /\b(?:subscription(?:_id|Id)?|sub|stableId|stable_id)\s*(?:=|:)\s*["'`]?([A-Za-z0-9][A-Za-z0-9._:/#-]*)/gi,
  )) {
    if (match[1] !== undefined) views.push({ id: match[1] });
  }
  const stateWords = "(opening|active|reconnecting|failed|ended|stopped|cancelled|stalled|dead)";
  for (const match of body.matchAll(
    new RegExp(`^[^:\\n]+:\\s+([A-Za-z0-9][A-Za-z0-9._:/#-]*)\\s+is\\s+${stateWords}\\b`, "gim"),
  )) {
    views.push({ id: match[1] ?? "", status: match[2] ?? "" });
  }
  for (const match of body.matchAll(
    new RegExp(`^\\s*([A-Za-z0-9][A-Za-z0-9._:/#-]*)\\s+is\\s+${stateWords}\\b`, "gim"),
  )) {
    views.push({ id: match[1] ?? "", status: match[2] ?? "" });
  }
  return views;
}

/** Every subscription id a status notice names, from its details or prose body. */
function statusNoticeIds(text: string, details: unknown): string[] {
  const ids = new Set<string>();
  for (const view of statusViews(text, details)) {
    if (view.id !== undefined && view.id.length > 0) ids.add(view.id);
    if (view.stableId !== undefined && view.stableId.length > 0) ids.add(view.stableId);
  }
  return [...ids];
}

/** Accept either `(text, details)` or one extension notice in the status checks. */
function statusInput(
  textOrDetails: string | unknown,
  details?: unknown,
): { text: string; source: unknown; customType?: string } {
  if (typeof textOrDetails === "string") return { text: textOrDetails, source: details };
  if (isRecord(textOrDetails)) {
    const content = typeof textOrDetails.content === "string" ? textOrDetails.content : "";
    const customType =
      typeof textOrDetails.customType === "string" ? textOrDetails.customType : undefined;
    if (content.length > 0 || "details" in textOrDetails) {
      return {
        text: content,
        source: textOrDetails.details,
        ...(customType ? { customType } : {}),
      };
    }
  }
  return { text: "", source: textOrDetails };
}

/** The `(server, name)` a prose line or details value attributes itself to. */
function statusAttribution(text: string, details: unknown): { server?: string; name?: string } {
  const source = isRecord(details) ? details : {};
  const server = typeof source.server === "string" ? source.server : undefined;
  const name = typeof source.name === "string" ? source.name : undefined;
  if (server !== undefined) return { server, ...(name === undefined ? {} : { name }) };
  const line = statusProseLine(text);
  if (line === null) return {};
  const pair = /^\s*([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+):\s+/.exec(line);
  if (pair?.[1] !== undefined && pair[2] !== undefined) {
    return { server: pair[1], name: pair[2] };
  }
  const single = /^\s*([A-Za-z0-9_.-]+):\s+/.exec(line);
  return single?.[1] === undefined ? {} : { server: single[1] };
}

/** The first prose line after the status head, or null for a JSON-only notice. */
function statusProseLine(text: string): string | null {
  const body = text.startsWith(MCP_STATUS_HEAD) ? text.slice(MCP_STATUS_HEAD.length) : text;
  const line = body
    .split("\n")
    .map((part) => part.trim())
    .find(
      (part) =>
        part.length > 0 &&
        !part.startsWith(MCP_STATUS_HEAD) &&
        !part.startsWith("Server-provided text is external data"),
    );
  if (line === undefined) return null;
  return line.includes("{") ? null : line;
}

/**
 * A truncation warning names the tracked stream, not an old generation. It is
 * emitted on the adapter's prose channel without an id, so the generic live
 * fallback must not treat it as stale.
 */
function isTruncationWarning(text: string): boolean {
  const line = statusProseLine(text);
  return line !== null && /^[^:\n]+:\s+replay is truncated for\b/i.test(line);
}

/** The adapter's failure prose (`server: error`) that may describe an old id. */
function isAdapterFailureProse(text: string): boolean {
  const line = statusProseLine(text);
  if (line === null) return false;
  return /^[^:\n]+:\s+(?:Reconnect attempts exhausted\b|Event stream heartbeat timed out\b|Event stream (?:interrupted|ended)\b|Event subscription terminated\b|Upstream event error\b|MCP connection or session ended\b)/i.test(
    line,
  );
}

/** Remove status items whose id this feed does not track from a JSON payload. */
function filterUntrackedStatusItems(
  text: string,
  tracked: (id: string) => boolean,
): { text: string; dropped: string[] } {
  const payloadStart = text.indexOf("{");
  if (payloadStart < 0) return { text, dropped: [] };
  let payload: unknown;
  try {
    payload = JSON.parse(text.slice(payloadStart));
  } catch {
    return { text, dropped: [] };
  }
  if (!isRecord(payload) || !Array.isArray(payload.subscriptions)) {
    return { text, dropped: [] };
  }
  const subscriptions: unknown[] = [];
  const dropped: string[] = [];
  for (const item of payload.subscriptions) {
    const id = isRecord(item) && typeof item.id === "string" ? item.id : undefined;
    const stableId =
      isRecord(item) && typeof item.stableId === "string"
        ? item.stableId
        : isRecord(item) && typeof item.stable_id === "string"
          ? item.stable_id
          : undefined;
    const idTracked = id !== undefined && id.length > 0 && tracked(id);
    const stableTracked = stableId !== undefined && stableId.length > 0 && tracked(stableId);
    // An item can name only its durable identity. If neither name is tracked,
    // it belongs to a zombie generation just like an unknown adapter id.
    if ((id !== undefined || stableId !== undefined) && !idTracked && !stableTracked) {
      dropped.push(id ?? stableId ?? "unknown");
      continue;
    }
    subscriptions.push(item);
  }
  if (dropped.length === 0) return { text, dropped };
  const prefix = text.slice(0, payloadStart);
  const separator = prefix.endsWith("\n") ? "" : "\n";
  return {
    text: `${prefix}${separator}${JSON.stringify({ ...payload, subscriptions })}`,
    dropped,
  };
}

/**
 * Server-owned MCP subscription list and event log. Every connected client
 * reads this same snapshot, so a second browser does not keep a private feed.
 *
 * Replay detection is keyed by the durable stable id, not the adapter id: the
 * registry keeps the last `MAX_DELIVERED_EVENT_IDS` event ids for each stable
 * id. Novelty is judged from that id set per conversation: an id already
 * delivered is a re-delivery and never becomes a chat notice, and a novel id is
 * news even when it was produced while this process was down. Age is a separate
 * gate: an event older than the restore grace is news for neither the queue nor
 * the ledger, because the stream itself can hand over a stale adapter backlog.
 */
export class McpEventFeed {
  private readonly subscriptions = new Map<string, McpSubscriptionView>();
  /** Event ids whose notice was submitted (a chip was committed) for a stable id. */
  private readonly delivered = new Map<string, Set<string>>();
  /** Event ids observed in this process, chipped or not. */
  private readonly seen = new Map<string, Set<string>>();
  /** Replayed feed entries that have not produced a chip yet; the next drain retries them. */
  private readonly unchipped = new Map<string, { stableId: string; item: unknown }>();
  /** Stable ids that existed before this feed started, so cursor fallback can replay. */
  private readonly restored = new Set<string>();
  /** Stable ids explicitly cancelled; a late status notice must not revive them. */
  private readonly cancelled = new Set<string>();
  /** Stable ids whose generation changed; the outbox must drop their old keys too. */
  private readonly generationClears = new Set<string>();
  /** Every adapter id that ever represented a stable id, including replaced ones. */
  private readonly adapterAliases = new Map<string, string>();
  private events: McpEventView[] = [];
  /** The last status text allowed to chat for an id, so an exact repeat is one chip. */
  private readonly reportedStatus = new Map<string, string>();
  /** Stable ids whose last accepted status was an outage, not healthy traffic. */
  private readonly outageReported = new Set<string>();
  /** Stable ids whose traffic recovered; the next active status is its one recovery. */
  private readonly recoveryPending = new Set<string>();
  /** Stable ids that already spoke after their stream failed terminally. */
  private readonly terminalReported = new Set<string>();
  private notice: string | null = null;
  private gap:
    | { dropped: number; at: string; from?: string | null; missedSince?: string }
    | undefined;
  /** Stable ids recently restored; their first batches may be a replay burst. */
  private readonly restoreBatchUntil = new Map<string, number>();
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

  /**
   * True only for a status notice about a generation superseded by another
   * subscription for the same durable identity. Ingest such a notice, but do
   * not submit it to chat: the user depends on that other generation.
   *
   * The predicate runs after `ingestStatuses`, so the incoming ids are already
   * known. It compares against *other* ids, never absence. A sibling is
   * superseding when it is live, or when it owns the same durable identity:
   * the current row stays authoritative even after its own failure, and its
   * failure notice is the one the user needs. An item with no adapter id names
   * the durable subscription itself, so only a live row that is still
   * delivering makes it stale; silence must reach chat. A notice that names
   * the live id itself, or one with no sibling at all, is authentic.
   */
  isSupersededStatus(details: unknown): boolean {
    return this.isSupersededStatusInput("", details);
  }

  /** The durable identity a status item names, resolving adapter aliases. */
  private statusStableId(item: StatusView): string | undefined {
    if (item.stableId !== undefined && item.stableId.length > 0) return item.stableId;
    if (item.id !== undefined && item.id.length > 0) {
      const known = this.findByStableId(item.id);
      if (known !== undefined) return known.stableId;
      const alias = this.adapterAliases.get(item.id);
      if (alias !== undefined) return alias;
    }
    if (item.server !== undefined) {
      return deriveStableId(item.server, item.name ?? "event", item.arguments);
    }
    return undefined;
  }

  /**
   * True when every status item describes a generation some other live row
   * already supersedes. The durable id, not the adapter id, carries identity:
   * a payload can name `stableId` without naming a generation at all, and that
   * is still noise while the row is live or reconnecting.
   */
  private isSupersededStatusInput(text: string, details: unknown): boolean {
    const incoming: Array<StatusView & { stableId?: string }> = [];
    for (const item of statusViews(text, details)) {
      if (item.id === undefined && item.stableId === undefined && item.server === undefined) {
        continue;
      }
      const stableId = this.statusStableId(item);
      incoming.push({ ...item, ...(stableId === undefined ? {} : { stableId }) });
    }
    if (incoming.length === 0) return false;
    const known = [...this.subscriptions.values()];
    return incoming.every((item) =>
      known.some((view) => {
        // A notice that names the current adapter id itself is authoritative.
        if (item.id !== undefined && view.id === item.id) return false;
        if (item.stableId !== undefined) {
          if (view.stableId !== item.stableId) return false;
          // Supersession needs a generation identity. An item without an
          // adapter id names only the durable subscription; freshness decides
          // that case in `suppressDurableStatusWhileDelivering` instead.
          if (item.id === undefined) return false;
          // The current row stays authoritative even after its own failure.
          return isLiveSubscription(view) || view.stableId === item.stableId;
        }
        if (item.server === undefined || view.server !== item.server) return false;
        if (item.name !== undefined && view.name !== item.name) return false;
        return isLiveSubscription(view);
      }),
    );
  }

  /**
   * A status id is tracked when it is the current adapter id, the durable
   * stable id, or an adapter id already known to represent that stable id in
   * this process. An id from before a restart has no alias and stays untracked.
   */
  private tracksStatusId(id: string): boolean {
    if (this.subscriptions.has(id)) return true;
    for (const view of this.subscriptions.values()) {
      if (view.stableId === id) return true;
    }
    const stableId = this.adapterAliases.get(id);
    return stableId !== undefined && this.findByStableId(stableId) !== undefined;
  }

  private trackedStatusEntries(
    text: string,
    details: unknown,
  ): Array<{ view: McpSubscriptionView; status: string }> {
    const entries: Array<{ view: McpSubscriptionView; status: string }> = [];
    const seen = new Set<string>();
    for (const item of statusViews(text, details)) {
      if (item.status === undefined) continue;
      const tracked =
        (item.id === undefined ? undefined : this.subscriptions.get(item.id)) ??
        (item.stableId === undefined ? undefined : this.findByStableId(item.stableId)) ??
        (item.id === undefined ? undefined : this.findByStableId(item.id));
      // An untracked sibling is filtered from the payload separately; it must
      // not force a healthy tracked row to speak before that happens.
      if (tracked === undefined) continue;
      const key = `${tracked.stableId}\u0000${item.status}`;
      if (seen.has(key)) continue;
      seen.add(key);
      entries.push({ view: tracked, status: item.status });
    }
    return entries;
  }

  private hasReportedOutage(view: McpSubscriptionView): boolean {
    return this.outageReported.has(view.stableId) || this.recoveryPending.has(view.stableId);
  }

  private clearReportedOutage(view: McpSubscriptionView): void {
    this.outageReported.delete(view.stableId);
    this.recoveryPending.delete(view.stableId);
    this.terminalReported.delete(view.stableId);
  }

  private isTerminalStatus(status: string): boolean {
    return (
      status === "failed" ||
      status === "ended" ||
      status === "stopped" ||
      status === "cancelled" ||
      status === "stalled" ||
      status === "dead"
    );
  }

  /**
   * A healthy stream does not need a chat turn to say it is still healthy.
   * Recovery notices are different: the explicit outage state makes the
   * first active/opening status after it the one recovery.
   */
  private isHealthyStatusNotice(text: string, details: unknown): boolean {
    let sawTracked = false;
    let sawRecovery = false;
    let sawSuppressedOutage = false;
    for (const { view, status } of this.trackedStatusEntries(text, details)) {
      if (status !== "active" && status !== "opening") return false;
      if (this.hasReportedOutage(view)) {
        if (status === "active") {
          // The first active status after an outage is the one recovery.
          this.clearReportedOutage(view);
          sawRecovery = true;
        } else {
          // A recovering row's opening is not a second recovery notice. Keep
          // the outage marker so its active status can still speak once.
          sawSuppressedOutage = true;
        }
        continue;
      }
      if (
        view.state !== "active" ||
        view.recoveryPending === true ||
        (view.status !== "active" && view.status !== "opening")
      ) {
        return false;
      }
      sawTracked = true;
    }
    if (sawRecovery) return false;
    return sawTracked || sawSuppressedOutage;
  }

  /**
   * A non-terminal stream end only says the adapter object stopped, not that
   * delivery did: the replacement can announce itself within the heartbeat
   * window. Keep the visible row healthy and stay silent until the silence is
   * longer than the extension's own heartbeat timeout.
   */
  private isGenerationDeathWhileDelivering(view: McpSubscriptionView, status: string): boolean {
    if (status === "active" || status === "opening" || this.isTerminalStatus(status)) return false;
    return deliveryIsFresh(view);
  }

  private suppressGenerationDeathWhileDelivering(text: string, details: unknown): boolean {
    const entries = this.trackedStatusEntries(text, details);
    if (entries.length === 0) return false;
    let sawDeath = false;
    for (const { view, status } of entries) {
      if (!this.isGenerationDeathWhileDelivering(view, status)) return false;
      sawDeath = true;
    }
    return sawDeath;
  }

  /**
   * An id-less status names the durable row, not one generation. While that row
   * is live and still delivering, even a terminal-looking state is stale; once
   * the heartbeat window has really passed it must reach chat.
   */
  private suppressDurableStatusWhileDelivering(text: string, details: unknown): boolean {
    let sawDeath = false;
    for (const item of statusViews(text, details)) {
      if (item.status === undefined || item.status === "active" || item.status === "opening") {
        continue;
      }
      if (item.id !== undefined || item.stableId === undefined) return false;
      const stableId = this.statusStableId(item);
      const view = stableId === undefined ? undefined : this.findByStableId(stableId);
      if (view === undefined || !isLiveSubscription(view) || !deliveryIsFresh(view)) return false;
      sawDeath = true;
    }
    return sawDeath;
  }

  /**
   * Mark a fresh outage or terminal failure. A second outage of the same kind
   * for the same stable id is suppressed; a terminal failure after a mere
   * outage is still news, and an active status after either is the recovery.
   * Returns true when there is nothing new to say.
   */
  private suppressReportedOutage(
    text: string,
    details: unknown,
    suppressDuplicate = true,
  ): boolean {
    const unhealthy = this.trackedStatusEntries(text, details).filter(
      ({ status }) => status !== "active" && status !== "opening",
    );
    if (unhealthy.length === 0) return false;
    const fresh = unhealthy.filter(({ view, status }) => {
      if (!this.outageReported.has(view.stableId) && !this.recoveryPending.has(view.stableId)) {
        return true;
      }
      return this.isTerminalStatus(status) && !this.terminalReported.has(view.stableId);
    });
    if (fresh.length === 0) {
      if (suppressDuplicate) {
        console.debug(
          `[mcp] dropped repeated outage status for ${unhealthy
            .map(({ view }) => view.stableId)
            .join(", ")}`,
        );
      }
      return suppressDuplicate;
    }
    for (const { view, status } of fresh) {
      this.outageReported.add(view.stableId);
      this.recoveryPending.delete(view.stableId);
      if (this.isTerminalStatus(status)) this.terminalReported.add(view.stableId);
    }
    return false;
  }

  /** Traffic after an outage becomes the pending recovery for the next active status. */
  private noteTraffic(view: McpSubscriptionView): void {
    if (!this.outageReported.has(view.stableId)) return;
    this.outageReported.delete(view.stableId);
    this.terminalReported.delete(view.stableId);
    this.recoveryPending.add(view.stableId);
  }

  /**
   * True when every subscription id a status notice carries is absent from the
   * live feed. Identity — not the notice's age — decides: an id minted before a
   * restart is a different subscription even when its `(server, name)` matches
   * the row this process restored. A notice with no id has no attribution.
   */
  isUntrackedStatus(textOrDetails: string | unknown, details?: unknown): boolean {
    const { text, source } = statusInput(textOrDetails, details);
    const ids = statusNoticeIds(text, source);
    if (ids.length === 0) return false;
    return ids.every((id) => !this.tracksStatusId(id));
  }

  /**
   * The identity-only part of the status gate. The intake runs the full gate
   * once; a later delivery pass must not re-decide health or duplicate state,
   * or it would drop the recovery that the intake just accepted.
   */
  private isUntrackedOrSuperseded(text: string, details: unknown): boolean {
    const ids = statusNoticeIds(text, details);
    if (ids.length > 0 && ids.every((id) => !this.tracksStatusId(id))) return true;
    return this.isSupersededStatusInput(text, details);
  }

  /**
   * Re-apply only the identity rules to an already accepted status notice.
   * Mixed batches still lose every item whose adapter id and stable id are
   * both untracked.
   */
  filterStatusIdentityNotice(textOrDetails: string | unknown, details?: unknown): string | null {
    const input = statusInput(textOrDetails, details);
    if (this.isUntrackedOrSuperseded(input.text, input.source)) return null;
    const filtered = filterUntrackedStatusItems(input.text, (id) => this.tracksStatusId(id));
    if (filtered.dropped.length > 0) {
      console.debug(
        `[mcp] dropped status items for untracked subscriptions ${filtered.dropped.join(", ")}`,
      );
    }
    return filtered.text;
  }

  /**
   * Decide one status notice before it reaches chat. A notice that names only
   * ids this feed does not track is dropped and logged at debug; otherwise the
   * existing supersession rule applies. With no id at all, a prose line can
   * still be attributed to its server, and a live tracked stream there makes it
   * a report about a generation this app is no longer using.
   */
  shouldDropStatus(
    textOrDetails: string | unknown,
    details?: unknown,
    customType?: string,
    options: { readonly markReported?: boolean } = {},
  ): boolean {
    const input = statusInput(textOrDetails, details);
    const text = input.text;
    const source = input.source;
    const ids = statusNoticeIds(text, source);
    if (ids.length > 0 && ids.every((id) => !this.tracksStatusId(id))) {
      console.debug(`[mcp] dropped status notice for untracked subscription ${ids.join(", ")}`);
      return true;
    }
    if (this.isSupersededStatusInput(text, source)) {
      console.debug(
        `[mcp] dropped superseded status notice${ids.length === 0 ? "" : ` for ${ids.join(", ")}`}`,
      );
      return true;
    }
    if (
      this.suppressDurableStatusWhileDelivering(text, source) ||
      this.suppressGenerationDeathWhileDelivering(text, source)
    ) {
      console.debug(
        `[mcp] dropped a stream-end status while delivery is still fresh${
          ids.length === 0 ? "" : ` for ${ids.join(", ")}`
        }`,
      );
      return true;
    }
    if (this.suppressReportedOutage(text, source, options.markReported !== false)) {
      return true;
    }
    if (this.isHealthyStatusNotice(text, source)) {
      console.debug(
        `[mcp] dropped healthy status notice${ids.length === 0 ? "" : ` for ${ids.join(", ")}`}`,
      );
      return true;
    }
    if (ids.length > 0) {
      // Suppress a repeat per tracked subscription, not per whole batch. An
      // untracked id must not keep a recovered tracked id's old failure
      // fingerprint alive, or the next identical batch would stay silent.
      const tracked = ids.filter((id) => this.tracksStatusId(id));
      if (options.markReported === false) return false;
      const fingerprint = JSON.stringify([tracked, text.trim()]);
      if (
        tracked.length > 0 &&
        tracked.every((id) => this.reportedStatus.get(id) === fingerprint)
      ) {
        console.debug(`[mcp] dropped duplicate status notice for ${tracked.join(", ")}`);
        return true;
      }
      for (const id of tracked) this.reportedStatus.set(id, fingerprint);
      return false;
    }
    // A gap or channel notice is not a subscription status even though it uses
    // the status head. Only the adapter's prose channel may fall back to server.
    const kind = customType ?? input.customType;
    if (kind !== undefined && kind !== "mcp-ui-status" && kind !== "mcp-events-status") {
      return false;
    }
    if (isTruncationWarning(text)) return false;
    const attribution = statusAttribution(text, source);
    if (attribution.server === undefined) return false;
    const known = [...this.subscriptions.values()].filter(
      (view) =>
        view.server === attribution.server &&
        (attribution.name === undefined || view.name === attribution.name),
    );
    if (known.length === 0) {
      console.debug(
        `[mcp] dropped status notice for ${attribution.server}: no tracked subscription`,
      );
      return true;
    }
    // A prose line that names no generation can still be the adapter reporting
    // the death of one. The same freshness rule the JSON payload uses applies:
    // if every tracked row on this server is live and recently delivering, the
    // line belongs to a generation whose replacement is already connected.
    const freshLive = known.every((view) => isLiveSubscription(view) && deliveryIsFresh(view));
    if (!isAdapterFailureProse(text) && !freshLive) return false;
    const down = known.filter((view) => !isLiveSubscription(view));
    if (down.length > 0) {
      const fresh = down.filter((view) => !this.hasReportedOutage(view));
      if (fresh.length === 0) {
        console.debug(`[mcp] dropped repeated failure prose for ${attribution.server}`);
        return true;
      }
      for (const view of fresh) this.outageReported.add(view.stableId);
      return false;
    }
    console.debug(
      `[mcp] dropped status notice for ${attribution.server}${
        attribution.name === undefined ? "" : `/${attribution.name}`
      }: the tracked subscription is live`,
    );
    return true;
  }

  /**
   * The text to submit for one status notice, or null when nothing should reach
   * chat. A mixed batch keeps its tracked items and drops the untracked ones,
   * so one stale id cannot carry its whole payload into the model context.
   */
  filterStatusNotice(
    textOrDetails: string | unknown,
    details?: unknown,
    customType?: string,
    options: { readonly markReported?: boolean } = {},
  ): string | null {
    const input = statusInput(textOrDetails, details);
    if (this.shouldDropStatus(textOrDetails, details, customType, options)) return null;
    const filtered = filterUntrackedStatusItems(input.text, (id) => this.tracksStatusId(id));
    if (filtered.dropped.length > 0) {
      console.debug(
        `[mcp] dropped status items for untracked subscriptions ${filtered.dropped.join(", ")}`,
      );
    }
    return filtered.text;
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
      ...(record.generation === undefined ? {} : { generation: record.generation }),
      cursor: positionOf(record.cursor, current?.cursor),
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
      current.generation !== next.generation ||
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
    const previous = this.subscriptions.get(view.id);
    for (const [adapterId, existing] of this.subscriptions) {
      if (adapterId !== view.id && existing.stableId === view.stableId) {
        this.subscriptions.delete(adapterId);
        this.reportedStatus.delete(adapterId);
      }
    }
    this.subscriptions.set(view.id, view);
    this.adapterAliases.set(view.id, view.stableId);
    // A recovered stream is a new opportunity to fail: the next identical
    // failure is news again, not a duplicate of the failure before recovery.
    if (previous !== undefined && !isLiveSubscription(previous) && isLiveSubscription(view)) {
      this.reportedStatus.delete(view.id);
    }
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

  /**
   * Stable across adapter replacement/restart, never based on timestamps. A
   * stated generation separates two server epochs that reuse the same cursor;
   * without one the key keeps the original two-part shape.
   */
  eventKey(item: unknown): string {
    if (!isRecord(item) || !isRecord(item.event)) return JSON.stringify(item);
    const event = item.event;
    const current =
      typeof item.subscription_id === "string"
        ? this.viewForAdapter(item.subscription_id)
        : undefined;
    const stable =
      current?.stableId ??
      deriveStableId(String(item.server), String(event.name ?? "event"), current?.arguments ?? {});
    const generation = current?.generation ?? this.savedRecord(stable)?.generation;
    const cursor = event.eventId ?? event.cursor ?? event;
    return generation === undefined
      ? JSON.stringify([stable, cursor])
      : JSON.stringify([stable, generation, cursor]);
  }

  /** Generation changes detected since the caller last drained them. */
  takeGenerationClears(): string[] {
    const cleared = [...this.generationClears];
    this.generationClears.clear();
    return cleared;
  }

  /**
   * A new generation must not inherit the previous one's seen/delivered ids:
   * same-numbered cursors are fresh news, and old pending entries may never
   * block them. Only this stable id is touched.
   */
  private clearGeneration(stableId: string): void {
    this.seen.delete(stableId);
    this.delivered.delete(stableId);
    for (const [key, entry] of this.unchipped) {
      if (entry.stableId === stableId) this.unchipped.delete(key);
    }
    this.generationClears.add(stableId);
  }

  private noteGeneration(
    stableId: string,
    previous: string | number | undefined,
    incoming: string | number | undefined,
  ): void {
    if (incoming === undefined || sameGeneration(previous, incoming)) return;
    // The first stated generation is not a change. It still replaces history
    // left by a row that predates generations, but only when there is any.
    if (
      previous === undefined &&
      !this.seen.has(stableId) &&
      !this.delivered.has(stableId) &&
      ![...this.unchipped.values()].some((entry) => entry.stableId === stableId)
    ) {
      return;
    }
    this.clearGeneration(stableId);
  }

  /** The durable identity and event id of one adapter item, when it has both. */
  private itemIdentity(item: unknown): { stableId: string; eventId: string | undefined } | null {
    if (!isRecord(item) || typeof item.server !== "string" || !isRecord(item.event)) return null;
    const event = item.event;
    const name = typeof event.name === "string" ? event.name : "event";
    const current =
      typeof item.subscription_id === "string"
        ? this.viewForAdapter(item.subscription_id)
        : undefined;
    const stableId =
      current?.stableId ?? deriveStableId(item.server, name, current?.arguments ?? {});
    return {
      stableId,
      eventId: typeof event.eventId === "string" ? event.eventId : undefined,
    };
  }

  /**
   * True when every item belongs to a stream restored in this process and the
   * restore cap window is still open. A replay arrives as a continuous run of
   * batches; treating each batch as a burst keeps it to one chip plus a gap,
   * so it cannot outrun the outbox merger.
   */
  isRestoreBatch(items: readonly unknown[]): boolean {
    if (items.length === 0) return false;
    const now = Date.now();
    return items.every((item) => {
      const identity = this.itemIdentity(item);
      if (identity === null) return false;
      const until = this.restoreBatchUntil.get(identity.stableId);
      return until !== undefined && until >= now;
    });
  }

  /**
   * Keep only the events that are news for this process. The delivery path runs
   * this before it bounds a batch or writes the outbox, so an old adapter
   * backlog never occupies a queue slot and never evicts a fresh sibling.
   */
  filterStaleEvents(items: readonly unknown[], log = true): FreshMcpEvents {
    return filterStaleMcpEvents(items, this.startedAt, log);
  }

  /**
   * Exact novel subset, without advancing cursor/ids. Persist it before ingesting.
   * A replayed entry that never produced a chip is included again, with the
   * original item, so the next drain can still commit exactly one chip for it.
   */
  novelEvents(items: readonly unknown[]): unknown[] {
    const batch = new Set<string>();
    const result: unknown[] = [];
    const add = (item: unknown): void => {
      const identity = this.itemIdentity(item);
      if (identity === null) return;
      if (this.isDelivered(identity.stableId, identity.eventId)) return;
      if (identity.eventId === undefined) {
        result.push(item);
        return;
      }
      const key = JSON.stringify([identity.stableId, identity.eventId]);
      if (batch.has(key)) return;
      batch.add(key);
      result.push(item);
    };
    for (const entry of this.unchipped.values()) add(entry.item);
    for (const item of items) add(item);
    return result;
  }

  /**
   * Commit the chip for these adapter items. Call this only after their notice
   * was submitted; an id in the durable delivered set always means a chip exists.
   */
  markDelivered(items: readonly unknown[]): void;
  markDelivered(stableId: string, eventId: string): void;
  markDelivered(itemsOrStableId: readonly unknown[] | string, eventId?: string): void {
    if (typeof itemsOrStableId === "string") {
      if (eventId !== undefined && eventId.length > 0) {
        this.recordDelivered(itemsOrStableId, eventId);
      }
      return;
    }
    for (const item of itemsOrStableId) {
      const identity = this.itemIdentity(item);
      if (identity?.eventId === undefined) continue;
      this.recordDelivered(identity.stableId, identity.eventId);
    }
  }

  /** Alternate names for callers that describe the committed notice as a chip. */
  markChipped(items: readonly unknown[]): void;
  markChipped(stableId: string, eventId: string): void;
  markChipped(itemsOrStableId: readonly unknown[] | string, eventId?: string): void {
    if (typeof itemsOrStableId === "string") {
      this.markDelivered(itemsOrStableId, eventId ?? "");
      return;
    }
    this.markDelivered(itemsOrStableId);
  }

  commitDelivered(items: readonly unknown[]): void;
  commitDelivered(stableId: string, eventId: string): void;
  commitDelivered(itemsOrStableId: readonly unknown[] | string, eventId?: string): void {
    if (typeof itemsOrStableId === "string") {
      this.markDelivered(itemsOrStableId, eventId ?? "");
      return;
    }
    this.markDelivered(itemsOrStableId);
  }

  commit(items: readonly unknown[]): void;
  commit(stableId: string, eventId: string): void;
  commit(itemsOrStableId: readonly unknown[] | string, eventId?: string): void {
    if (typeof itemsOrStableId === "string") {
      this.markDelivered(itemsOrStableId, eventId ?? "");
      return;
    }
    this.markDelivered(itemsOrStableId);
  }

  ingest(notice: ExtensionNotice): boolean {
    if (notice.customType === "mcp-events") return this.ingestEvents(notice.details);
    if (notice.customType === "mcp-events-status") return this.ingestStatuses(notice.details);
    if (notice.customType === "mcp-events-tool") return this.ingestTool(notice.details);
    if (notice.customType === "mcp-events-traffic") return this.ingestTraffic(notice.details);
    if (notice.customType === "mcp-events-gap") return this.ingestGap(notice.details);
    return false;
  }

  /** Record a window a restore deliberately skipped instead of replaying it. */
  private ingestGap(details: unknown): boolean {
    if (!isRecord(details)) return false;
    const raw = typeof details.count === "number" ? details.count : 0;
    const count = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
    const at =
      typeof details.at === "string" && details.at.length > 0
        ? details.at
        : new Date().toISOString();
    const from = typeof details.from === "string" ? details.from : null;
    const missedSince =
      typeof details.missedSince === "string" && details.missedSince.length > 0
        ? details.missedSince
        : undefined;
    const truncated = details.truncated === true;
    const label = count > 0 ? `${count}${truncated ? "+" : ""}` : "Some";
    this.gap = {
      dropped: count,
      at,
      from,
      ...(missedSince === undefined ? {} : { missedSince }),
    };
    this.notice = `${label} events were missed while pi was not running`;
    this.touch();
    return false;
  }

  private touch(): void {
    this.revision += 1;
  }

  private seedRecords(records: readonly McpSubscriptionRecord[]): void {
    for (const record of records) {
      const stableId = recordStableId(record);
      this.restored.add(stableId);
      // Events can arrive before the subscribe result is observed. Open the
      // replay cap from the durable row so that early burst is still one batch.
      this.restoreBatchUntil.set(stableId, Date.now() + RESTORE_CAP_WINDOW_MS);
      this.seedDelivered(
        stableId,
        record.deliveredEventIds ?? [],
        true,
        record.cursor ?? undefined,
      );
      // A restore rejected by the server has no live adapter session, but the
      // durable cancellation must still be visible in /api/state.
      if (record.status === "cancelled" || record.state === "cancelled") {
        const view = subscriptionFrom({ ...record, id: record.id ?? stableId });
        if (view !== null) this.storeView(view);
      }
    }
  }

  private seedDelivered(
    stableId: string,
    ids: readonly string[],
    historical: boolean,
    cursor?: string,
  ): void {
    if (!historical || ids.length === 0) return;
    // The cursor may arrive from any of three callers (startup record, registry
    // row, restore result); resolve it here so no path can skip the epoch check.
    const resumeFrom =
      cursor ??
      this.savedRecord(stableId)?.cursor ??
      this.findByStableId(stableId)?.cursor ??
      undefined;
    const cursorSequence = resumeFrom === undefined ? undefined : idSequence(resumeFrom);
    if (cursorSequence === undefined) {
      // Without a cursor there is nothing to compare against, and trusting the
      // set is what silently killed every chip. Treat it as unknown instead.
      this.persistStaleEpoch(stableId, resumeFrom);
      return;
    }
    const ahead = ids.some((id) => {
      const sequence = idSequence(id);
      return sequence !== undefined && sequence > cursorSequence;
    });
    if (ahead) {
      this.delivered.delete(stableId);
      this.persistStaleEpoch(stableId, resumeFrom);
      return;
    }
    // Once this process has delivered something, a durable row is already
    // represented by the in-memory sets and must not be relabelled historical.
    const known = this.delivered.get(stableId);
    if (known !== undefined && known.size > 0) return;
    const delivered = new Set<string>();
    for (const id of ids) {
      if (id.length === 0 || delivered.has(id)) continue;
      delivered.add(id);
    }
    while (delivered.size > MAX_DELIVERED_EVENT_IDS) {
      const oldest = delivered.values().next().value;
      if (oldest === undefined) break;
      delivered.delete(oldest);
    }
    this.delivered.set(stableId, delivered);
    this.seedSeen(stableId, delivered);
  }

  /** Adapter metadata proves an id was seen, never that pi-ui committed a chip. */
  private seedSeen(stableId: string, ids: Iterable<string>): void {
    let seen = this.seen.get(stableId);
    if (seen === undefined) {
      seen = new Set<string>();
      this.seen.set(stableId, seen);
    }
    for (const id of ids) {
      if (id.length > 0) seen.add(id);
    }
    while (seen.size > MAX_DELIVERED_EVENT_IDS) {
      const oldest = seen.values().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
  }

  private savedRecord(stableId: string): McpSubscriptionRecord | undefined {
    return this.registry?.list().find((entry) => recordStableId(entry) === stableId);
  }

  /** Seed from a row for a stable id if this feed has not seen the stream yet. */
  private seedFromRegistry(stableId: string): void {
    const record = this.savedRecord(stableId);
    if (record === undefined) return;
    this.restored.add(stableId);
    if (!this.restoreBatchUntil.has(stableId)) {
      this.restoreBatchUntil.set(stableId, Date.now() + RESTORE_CAP_WINDOW_MS);
    }
    this.seedDelivered(stableId, record.deliveredEventIds ?? [], true, record.cursor ?? undefined);
  }

  /**
   * Record an observation. `chipped` is the only way into the durable delivered
   * set; seeing an id (even repeatedly) never implies its notice was submitted.
   */
  private remember(stableId: string, eventId: string, chipped: boolean): boolean {
    let seen = this.seen.get(stableId);
    if (seen === undefined) {
      seen = new Set<string>();
      this.seen.set(stableId, seen);
    }
    seen.add(eventId);
    while (seen.size > MAX_DELIVERED_EVENT_IDS) {
      const oldest = seen.values().next().value;
      if (oldest === undefined) break;
      seen.delete(oldest);
    }
    if (!chipped) return false;
    let delivered = this.delivered.get(stableId);
    if (delivered === undefined) {
      delivered = new Set<string>();
      this.delivered.set(stableId, delivered);
    }
    if (delivered.has(eventId)) return false;
    delivered.add(eventId);
    while (delivered.size > MAX_DELIVERED_EVENT_IDS) {
      const oldest = delivered.values().next().value;
      if (oldest === undefined) break;
      delivered.delete(oldest);
    }
    return true;
  }

  private rememberUnchipped(stableId: string, eventId: string, item: unknown): void {
    const key = JSON.stringify([stableId, eventId]);
    // Keep the first observation: the eventual chip must carry its timestamp
    // and cursor, not those of a later duplicate delivery.
    if (!this.unchipped.has(key)) this.unchipped.set(key, { stableId, item });
    while (this.unchipped.size > MAX_DELIVERED_EVENT_IDS) {
      const oldest = this.unchipped.keys().next().value;
      if (oldest === undefined) break;
      this.unchipped.delete(oldest);
    }
  }

  private forgetUnchipped(stableId: string, eventId: string): void {
    this.unchipped.delete(JSON.stringify([stableId, eventId]));
  }

  /** A durable set from an older hub epoch was discarded; say so once in the log. */
  private persistStaleEpoch(stableId: string, cursor: string | undefined): void {
    console.warn(
      `mcp: dropped stale delivered-id set for ${stableId} (cursor ${cursor ?? "unknown"}) — the hub renumbered its ids`,
    );
  }

  private recordDelivered(stableId: string, eventId: string): void {
    const added = this.remember(stableId, eventId, true);
    this.forgetUnchipped(stableId, eventId);
    let changed = false;
    this.events = this.events.map((entry) => {
      if (entry.id !== eventId || entry.replayed !== true) return entry;
      changed = true;
      return { ...entry, replayed: undefined };
    });
    const view = this.findByStableId(stableId);
    if (view !== undefined && (added || changed)) this.persist(view);
    if (changed) this.touch();
  }

  private deliveredIds(stableId: string): string[] {
    return [...(this.delivered.get(stableId) ?? [])];
  }

  private isDelivered(stableId: string, eventId: string | undefined): boolean {
    return eventId !== undefined && this.delivered.get(stableId)?.has(eventId) === true;
  }

  private isSeen(stableId: string, eventId: string | undefined): boolean {
    return eventId !== undefined && this.seen.get(stableId)?.has(eventId) === true;
  }

  private persist(subscription: McpSubscriptionView): void {
    if (this.registry === undefined) return;
    const record: McpSubscriptionRecord = {
      server: subscription.server,
      name: subscription.name,
      stableId: subscription.stableId,
      ...(subscription.generation === undefined ? {} : { generation: subscription.generation }),
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
    // A stream may hand over old adapter history and a subscribe may hand us a
    // whole retained history. Age first, then size: dropping stale events must
    // not consume the batch bound and evict a fresh sibling.
    const aged = filterStaleMcpEvents(details.events, this.startedAt);
    const batch = boundMcpEventBatch(aged.items);
    const reportedDropped = typeof details.dropped_events === "number" ? details.dropped_events : 0;
    const dropped = reportedDropped + aged.dropped + batch.dropped;
    if (dropped > 0) {
      this.gap = { dropped, at: new Date().toISOString() };
      this.notice =
        reportedDropped > 0
          ? `${dropped} events dropped while reconnecting`
          : `${dropped} older events dropped from this batch`;
      stateChanged = true;
    }
    for (const item of batch.items) {
      if (!isRecord(item) || typeof item.server !== "string" || !isRecord(item.event)) continue;
      const server = item.server;
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
      const id = eventId ?? `${server}:${name}:${timestamp}:${this.events.length}`;
      const cursor = eventCursor(event);
      const subscriptionId =
        typeof item.subscription_id === "string" ? item.subscription_id : undefined;
      const current =
        subscriptionId === undefined ? undefined : this.viewForAdapter(subscriptionId);
      const stableId =
        current?.stableId ?? deriveStableId(server, streamName, current?.arguments ?? {});
      const generation = current?.generation ?? this.savedRecord(stableId)?.generation;
      const sameLogGeneration = (entry: McpEventView): boolean =>
        generation === undefined || sameGeneration(entry.generation, generation);
      const eventView = (): McpEventView => ({
        id,
        server,
        name,
        ...(generation === undefined ? {} : { generation }),
        timestamp,
        summary: summarize(event.data),
      });
      // Novelty belongs to the conversation, not to this process. An id whose
      // chip was committed — in this process or before it started — is a
      // re-delivery; anything else is news, however old its timestamp looks.
      const delivered = this.isDelivered(stableId, eventId);
      const duplicate = eventId !== undefined && (delivered || this.isSeen(stableId, eventId));

      if (duplicate) {
        // A duplicate may move the cursor but it never commits a chip. If the
        // id was only seen before, keep the replay entry retryable for the next
        // drain instead of silently recording it as delivered.
        if (this.trackCursor(item, streamName, cursor)) stateChanged = true;
        if (eventId !== undefined) this.remember(stableId, eventId, false);
        const index = this.events.findIndex((entry) => entry.id === id);
        const existing = index === -1 ? undefined : this.events[index];
        const matching =
          existing !== undefined && sameLogGeneration(existing) ? existing : undefined;
        if (matching === undefined) {
          const entry = { ...eventView(), replayed: true };
          this.events = (
            index === -1
              ? [...this.events, entry]
              : this.events.map((item, at) => (at === index ? entry : item))
          ).slice(-EVENT_LIMIT);
          if (eventId !== undefined && !delivered) {
            this.rememberUnchipped(stableId, eventId, item);
          }
          stateChanged = true;
        } else if (eventId !== undefined && !delivered && matching.replayed === true) {
          // Keep the original item: its timestamp and cursor are the ones the
          // eventual chip must carry.
          this.rememberUnchipped(stableId, eventId, item);
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
      const matching = existing !== undefined && sameLogGeneration(existing) ? existing : undefined;
      if (matching !== undefined && matching.replayed !== true) {
        const tracked =
          subscriptionId === undefined ? undefined : this.viewForAdapter(subscriptionId);
        if (tracked !== undefined) this.persist(tracked);
        continue;
      }
      if (matching !== undefined) {
        this.events = this.events.map((entry, at) =>
          at === index ? { ...entry, replayed: undefined } : entry,
        );
      } else if (index === -1) {
        this.events = [...this.events, eventView()].slice(-EVENT_LIMIT);
      } else {
        // Same id, different generation: replace the old epoch's row instead
        // of treating the renumbered event as its duplicate.
        const entry = eventView();
        this.events = this.events.map((item, at) => (at === index ? entry : item));
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
    this.noteTraffic(current);
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
    this.noteTraffic(current);
    const alive = current.state !== "active" || current.status === "failed";
    const next: McpSubscriptionView = {
      ...current,
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
      let incoming = subscriptionFrom(item);
      let durableOnly = false;
      if (incoming === null) {
        // Some status payloads name only the durable id. Resolve it to the
        // current generation so a real outage can still update the row.
        const views: StatusView[] = [];
        collectStatusViews(item, views);
        const named = views.find(
          (view) =>
            view.status !== undefined &&
            (view.stableId !== undefined || view.id !== undefined || view.server !== undefined),
        );
        const stableId = named === undefined ? undefined : this.statusStableId(named);
        const current = stableId === undefined ? undefined : this.findByStableId(stableId);
        if (current === undefined || named?.status === undefined) continue;
        const cursor =
          isRecord(item) && typeof item.cursor === "string" && hasPosition(item.cursor)
            ? item.cursor
            : current.cursor;
        incoming = {
          ...current,
          status: named.status,
          state: deriveSubscriptionState(named.status),
          cursor,
        };
        durableOnly = true;
      }
      // A status can only describe a subscription this feed already tracks.
      // An id from before a restart is a different stream; attaching its row
      // would turn a dead generation into visible state and chat news.
      if (!this.subscriptions.has(incoming.id)) continue;
      // A queued reconnect/active notice must not revive a cancelled entry.
      if (this.cancellationId(incoming.stableId) !== undefined) continue;
      const deliveredIds = eventIdsFrom(item);
      if (deliveredIds.length > 0) {
        // The adapter only knows which frames it pushed. That is not proof that
        // pi-ui submitted a chip, so these ids may not enter the delivered set.
        this.seedSeen(incoming.stableId, deliveredIds);
      }
      this.seedFromRegistry(incoming.stableId);
      const current = this.viewForAdapter(incoming.id) ?? this.findByStableId(incoming.stableId);
      // Once an adapter id owns this stable id, a status for a different id is
      // stale: it must not move the visible row back, even when the incoming
      // status happens to look live. The owning row stays authoritative until
      // a subscribe result names a real successor.
      if (current !== undefined && current.id !== incoming.id) continue;
      // A stream object ending is not a delivery outage while the last event or
      // heartbeat is still inside the extension's heartbeat window. The next
      // generation reports its own active status; the row never flashes down.
      const freshDurableDeath =
        durableOnly &&
        current !== undefined &&
        incoming.status !== "active" &&
        incoming.status !== "opening" &&
        isLiveSubscription(current) &&
        deliveryIsFresh(current);
      if (
        current !== undefined &&
        (freshDurableDeath || this.isGenerationDeathWhileDelivering(current, incoming.status))
      ) {
        console.debug(
          `[mcp] kept ${current.stableId} healthy: its stream ended but delivery is still fresh`,
        );
        continue;
      }
      const saved = this.savedRecord(incoming.stableId);
      const stableId = current?.stableId ?? incoming.stableId;
      this.noteGeneration(stableId, current?.generation ?? saved?.generation, incoming.generation);
      const reconnects =
        incoming.status === "active"
          ? 0
          : (current?.reconnects ?? saved?.reconnects ?? incoming.reconnects);
      const incomingState = deriveSubscriptionState(incoming.status, incoming.state);
      const subscription: McpSubscriptionView =
        current === undefined
          ? {
              ...incoming,
              generation: incoming.generation ?? saved?.generation,
              cursor:
                incoming.generation !== undefined && incoming.generation !== saved?.generation
                  ? incoming.cursor
                  : positionOf(incoming.cursor, saved?.cursor),
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
              generation: incoming.generation ?? current.generation ?? saved?.generation,
              cursor:
                incoming.generation !== undefined && incoming.generation !== current.generation
                  ? incoming.cursor
                  : positionOf(current.cursor, incoming.cursor, saved?.cursor),
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
        current.generation === subscription.generation &&
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
          this.seedSeen(incoming.stableId, delivered);
        }
        this.seedFromRegistry(incoming.stableId);
        const current =
          previousViews.find((view) => view.id === incoming.id) ??
          previousViews.find((view) => view.stableId === incoming.stableId);
        const saved = this.savedRecord(incoming.stableId);
        const stableId = current?.stableId ?? incoming.stableId;
        this.noteGeneration(
          stableId,
          current?.generation ?? saved?.generation,
          incoming.generation,
        );
        const subscription: McpSubscriptionView = {
          ...incoming,
          stableId,
          generation: incoming.generation ?? current?.generation ?? saved?.generation,
          state: deriveSubscriptionState(incoming.status, incoming.state),
          cursor: positionOf(current?.cursor, incoming.cursor),
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
      // The server's answer is the position. A zero cursor is not a position:
      // never send it on, and never report it back from a fresh subscribe. An
      // explicit zero is a start-now request; an omitted cursor on a
      // re-subscribe falls back to the row that is already tracked.
      const requestedCursor = typeof args.cursor === "string" ? args.cursor : undefined;
      const explicitZero = requestedCursor !== undefined && !hasPosition(requestedCursor);
      const sentCursor =
        requestedCursor !== undefined && hasPosition(requestedCursor) ? requestedCursor : null;
      const savedCursor = this.savedRecord(incoming.stableId)?.cursor;
      const fallbackCursor = explicitZero
        ? null
        : hasPosition(current?.cursor)
          ? current.cursor
          : hasPosition(savedCursor)
            ? savedCursor
            : null;
      const answerCursor = hasPosition(incoming.cursor)
        ? incoming.cursor
        : (sentCursor ?? fallbackCursor);
      const delivered = eventIdsFrom(raw);
      if (delivered.length > 0) {
        this.restored.add(incoming.stableId);
        if (args.restored === true) {
          // The restore result is enriched with our own durable delivered set.
          this.seedDelivered(incoming.stableId, delivered, true, answerCursor ?? undefined);
        } else {
          this.seedSeen(incoming.stableId, delivered);
        }
      }
      if (args.restored === true) {
        this.restored.add(incoming.stableId);
        this.restoreBatchUntil.set(incoming.stableId, Date.now() + RESTORE_CAP_WINDOW_MS);
      }
      this.seedFromRegistry(incoming.stableId);
      const saved = this.savedRecord(incoming.stableId);
      const stableId = current?.stableId ?? incoming.stableId;
      this.noteGeneration(stableId, current?.generation ?? saved?.generation, incoming.generation);
      const subscription: McpSubscriptionView = {
        ...incoming,
        stableId,
        generation: incoming.generation ?? current?.generation ?? saved?.generation,
        state: deriveSubscriptionState(incoming.status, incoming.state),
        cursor: answerCursor,
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
      if (isLiveSubscription(subscription)) this.clearReportedOutage(subscription);
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
