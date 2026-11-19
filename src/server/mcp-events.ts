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
  readonly startedAt?: number | string | Date;
}

function startedAtOf(value: number | string | Date | undefined): number {
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
export const RESTORE_GRACE_MS = 15 * 60_000;
const RESTORE_CAP_WINDOW_MS = RESTORE_GRACE_MS;

function isLiveSubscription(view: McpSubscriptionView): boolean {
  if (view.state === "cancelled" || view.state === "dead" || view.state === "stalled") return false;
  return view.status === "active" || view.status === "reconnecting" || view.status === "opening";
}

export const MCP_STREAM_HEARTBEAT_TIMEOUT_MS = 65_000;

function parsedTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function lastDeliveryAt(view: McpSubscriptionView): number | undefined {
  const eventAt = parsedTime(view.lastEventAt);
  const heartbeatAt = parsedTime(view.lastHeartbeatAt);
  if (eventAt === undefined) return heartbeatAt;
  if (heartbeatAt === undefined) return eventAt;
  return Math.max(eventAt, heartbeatAt);
}

function deliveryIsFresh(view: McpSubscriptionView, now = Date.now()): boolean {
  const at = lastDeliveryAt(view);
  return at !== undefined && now - at <= MCP_STREAM_HEARTBEAT_TIMEOUT_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

export function eventCursor(event: Record<string, unknown>): string | null {
  if (isRecord(event.data) && typeof event.data.cursor === "string") return event.data.cursor;
  return typeof event.cursor === "string" ? event.cursor : null;
}

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

function serverCursor(current: string | null, incoming: string | null): string | null {
  if (hasPosition(incoming)) return incoming;
  if (hasPosition(current)) return current;
  return null;
}

function positionOf(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (hasPosition(value)) return value;
  }
  return null;
}

function sameArguments(first: Record<string, unknown>, second: Record<string, unknown>): boolean {
  return JSON.stringify(first) === JSON.stringify(second);
}

function idSequence(value: string): number | undefined {
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

function statusViews(text: string, details: unknown): StatusView[] {
  const views: StatusView[] = [];
  collectStatusViews(details, views);
  const payloadStart = text.indexOf("{");
  if (payloadStart >= 0) {
    try {
      collectStatusViews(JSON.parse(text.slice(payloadStart)), views);
    } catch {}
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

function statusNoticeIds(text: string, details: unknown): string[] {
  const ids = new Set<string>();
  for (const view of statusViews(text, details)) {
    if (view.id !== undefined && view.id.length > 0) ids.add(view.id);
    if (view.stableId !== undefined && view.stableId.length > 0) ids.add(view.stableId);
  }
  return [...ids];
}

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

function isTruncationWarning(text: string): boolean {
  const line = statusProseLine(text);
  return line !== null && /^[^:\n]+:\s+replay is truncated for\b/i.test(line);
}

function isAdapterFailureProse(text: string): boolean {
  const line = statusProseLine(text);
  if (line === null) return false;
  return /^[^:\n]+:\s+(?:Reconnect attempts exhausted\b|Event stream heartbeat timed out\b|Event stream (?:interrupted|ended)\b|Event subscription terminated\b|Upstream event error\b|MCP connection or session ended\b)/i.test(
    line,
  );
}

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

export class McpEventFeed {
  private readonly subscriptions = new Map<string, McpSubscriptionView>();
  private readonly delivered = new Map<string, Set<string>>();
  private readonly seen = new Map<string, Set<string>>();
  private readonly unchipped = new Map<string, { stableId: string; item: unknown }>();
  private readonly restored = new Set<string>();
  private readonly cancelled = new Set<string>();
  private readonly generationClears = new Set<string>();
  private readonly adapterAliases = new Map<string, string>();
  private events: McpEventView[] = [];
  private readonly reportedStatus = new Map<string, string>();
  private readonly outageReported = new Set<string>();
  private readonly recoveryPending = new Set<string>();
  private readonly terminalReported = new Set<string>();
  private notice: string | null = null;
  private gap:
    | { dropped: number; at: string; from?: string | null; missedSince?: string }
    | undefined;
  private readonly restoreBatchUntil = new Map<string, number>();
  private revision = 0;
  private readonly startedAt: number;

  constructor(
    private readonly registry?: McpSubscriptionRegistry,
    options: McpEventFeedOptions = {},
  ) {
    this.startedAt = startedAtOf(options.startedAt);
    this.seedRecords(registry?.list() ?? []);
  }

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

  findByStableId(stableId: string): McpSubscriptionView | undefined {
    for (const subscription of this.subscriptions.values()) {
      if (subscription.stableId === stableId) return subscription;
    }
    return undefined;
  }

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

  cancelByStableId(stableId: string): McpSubscriptionView | null {
    return this.cancel(stableId);
  }

  isSupersededStatus(details: unknown): boolean {
    return this.isSupersededStatusInput("", details);
  }

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
        if (item.id !== undefined && view.id === item.id) return false;
        if (item.stableId !== undefined) {
          if (view.stableId !== item.stableId) return false;
          if (item.id === undefined) return false;
          return isLiveSubscription(view) || view.stableId === item.stableId;
        }
        if (item.server === undefined || view.server !== item.server) return false;
        if (item.name !== undefined && view.name !== item.name) return false;
        return isLiveSubscription(view);
      }),
    );
  }

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

  private isHealthyStatusNotice(text: string, details: unknown): boolean {
    let sawTracked = false;
    let sawRecovery = false;
    let sawSuppressedOutage = false;
    for (const { view, status } of this.trackedStatusEntries(text, details)) {
      if (status !== "active" && status !== "opening") return false;
      if (this.hasReportedOutage(view)) {
        if (status === "active") {
          this.clearReportedOutage(view);
          sawRecovery = true;
        } else {
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

  private noteTraffic(view: McpSubscriptionView): void {
    if (!this.outageReported.has(view.stableId)) return;
    this.outageReported.delete(view.stableId);
    this.terminalReported.delete(view.stableId);
    this.recoveryPending.add(view.stableId);
  }

  isUntrackedStatus(textOrDetails: string | unknown, details?: unknown): boolean {
    const { text, source } = statusInput(textOrDetails, details);
    const ids = statusNoticeIds(text, source);
    if (ids.length === 0) return false;
    return ids.every((id) => !this.tracksStatusId(id));
  }

  private isUntrackedOrSuperseded(text: string, details: unknown): boolean {
    const ids = statusNoticeIds(text, details);
    if (ids.length > 0 && ids.every((id) => !this.tracksStatusId(id))) return true;
    return this.isSupersededStatusInput(text, details);
  }

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

  private viewForAdapter(adapterId: string): McpSubscriptionView | undefined {
    const direct = this.subscriptions.get(adapterId);
    if (direct !== undefined) return direct;
    const stableId = this.adapterAliases.get(adapterId);
    if (stableId === undefined) return undefined;
    return this.findByStableId(stableId);
  }

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
    if (previous !== undefined && !isLiveSubscription(previous) && isLiveSubscription(view)) {
      this.reportedStatus.delete(view.id);
    }
    return view;
  }

  private cancellationId(stableId: string): string | null | undefined {
    const view = this.findByStableId(stableId);
    if (view?.status === "cancelled") return view.id;
    if (this.cancelled.has(stableId)) return view?.id ?? null;
    const record = this.registry?.list().find((entry) => recordStableId(entry) === stableId);
    if (record?.status === "cancelled") return record.id ?? null;
    return undefined;
  }

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

  takeGenerationClears(): string[] {
    const cleared = [...this.generationClears];
    this.generationClears.clear();
    return cleared;
  }

  withEventGeneration(item: unknown): unknown {
    if (!isRecord(item) || !isRecord(item.event)) return item;
    const current =
      typeof item.subscription_id === "string"
        ? this.viewForAdapter(item.subscription_id)
        : undefined;
    if (current === undefined) return item;
    const generation = current.generation ?? this.savedRecord(current.stableId)?.generation;
    return generation === undefined ? item : { ...item, generation };
  }

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

  filterStaleEvents(items: readonly unknown[], log = true): FreshMcpEvents {
    return filterStaleMcpEvents(items, this.startedAt, log);
  }

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
    if (notice.customType === "mcp-events-generation") return this.ingestGeneration(notice.details);
    return false;
  }

  private ingestGeneration(details: unknown): boolean {
    if (!isRecord(details) || typeof details.server !== "string") return false;
    const generation = subscriptionGeneration(details);
    if (generation === undefined) return false;
    let changed = false;
    for (const view of [...this.subscriptions.values()]) {
      if (view.server !== details.server) continue;
      const previous = view.generation ?? this.savedRecord(view.stableId)?.generation;
      this.noteGeneration(view.stableId, previous, generation);
      if (sameGeneration(view.generation, generation)) continue;
      const next: McpSubscriptionView = { ...view, generation };
      this.storeView(next);
      this.persist(next);
      changed = true;
    }
    if (changed) this.touch();
    return changed;
  }

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
      this.restoreBatchUntil.set(stableId, Date.now() + RESTORE_CAP_WINDOW_MS);
      this.seedDelivered(
        stableId,
        record.deliveredEventIds ?? [],
        true,
        record.cursor ?? undefined,
      );
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
    const resumeFrom =
      cursor ??
      this.savedRecord(stableId)?.cursor ??
      this.findByStableId(stableId)?.cursor ??
      undefined;
    const cursorSequence = resumeFrom === undefined ? undefined : idSequence(resumeFrom);
    if (cursorSequence === undefined) {
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

  private seedFromRegistry(stableId: string): void {
    const record = this.savedRecord(stableId);
    if (record === undefined) return;
    this.restored.add(stableId);
    if (!this.restoreBatchUntil.has(stableId)) {
      this.restoreBatchUntil.set(stableId, Date.now() + RESTORE_CAP_WINDOW_MS);
    }
    this.seedDelivered(stableId, record.deliveredEventIds ?? [], true, record.cursor ?? undefined);
  }

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
      const delivered = this.isDelivered(stableId, eventId);
      const duplicate = eventId !== undefined && (delivered || this.isSeen(stableId, eventId));

      if (duplicate) {
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
      if (!this.subscriptions.has(incoming.id)) continue;
      if (this.cancellationId(incoming.stableId) !== undefined) continue;
      const deliveredIds = eventIdsFrom(item);
      if (deliveredIds.length > 0) {
        this.seedSeen(incoming.stableId, deliveredIds);
      }
      this.seedFromRegistry(incoming.stableId);
      const current = this.viewForAdapter(incoming.id) ?? this.findByStableId(incoming.stableId);
      if (current !== undefined && current.id !== incoming.id) continue;
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
        return false;
      }
      if (cancellationId !== undefined) this.cancelled.delete(incoming.stableId);
      const current = this.viewForAdapter(incoming.id) ?? this.findByStableId(incoming.stableId);
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
