import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { McpSubscriptionState } from "../shared/types.js";

export const MCP_SUBSCRIPTIONS_FILE = "mcp-subscriptions.json";
export const MCP_SUBSCRIPTIONS_VERSION = 1;

export const MAX_DELIVERED_EVENT_IDS = 1_000;

export type McpSubscriptionRecordStatus =
  | "opening"
  | "active"
  | "reconnecting"
  | "stopped"
  | "ended"
  | "failed"
  | "cancelled"
  | (string & {});

export interface McpSubscriptionRecord {
  readonly server: string;
  readonly name: string;

  readonly title?: string;

  readonly stableId?: string;

  readonly generation?: string | number;

  readonly id?: string | null;
  readonly arguments: Record<string, unknown>;
  readonly cursor: string | null;
  readonly status: McpSubscriptionRecordStatus;

  readonly state?: McpSubscriptionState;

  readonly enabled?: boolean;

  readonly deliveredEventIds?: readonly string[];

  readonly lastEventAt?: string;

  readonly lastHeartbeatAt?: string;

  readonly lastPollAt?: string;

  readonly lastError?: string;

  readonly lastErrorAt?: string;

  readonly recoveryFailures?: number;

  readonly recoveryPending?: boolean;

  readonly recoveryStartedAt?: string;

  readonly reconnects?: number;

  readonly lastReconnectReason?: string;

  readonly endReason?: string;
  readonly updatedAt: string;
}

interface RegistryDocument {
  readonly version: number;
  readonly subscriptions: McpSubscriptionRecord[];
}

export interface McpSubscriptionRegistryOptions {
  readonly throttleMs?: number;

  readonly now?: () => number;

  readonly log?: (line: string) => void;

  readonly fileName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeArguments(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortValue(value[key])]),
  );
}

export function sortKeyArguments(args: Record<string, unknown> | undefined): string {
  try {
    return JSON.stringify(sortValue(args ?? {}));
  } catch {
    return "{}";
  }
}

function encodeStableComponent(value: string): string {
  try {
    return encodeURIComponent(value);
  } catch {
    return encodeURIComponent(
      value.replace(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
        "\uFFFD",
      ),
    );
  }
}

export function deriveStableId(
  server: string,
  name: string,
  args: Record<string, unknown> | undefined,
): string {
  const base = `${encodeStableComponent(server)}/${encodeStableComponent(name)}`;
  const canonical = sortKeyArguments(args);
  if (canonical === "{}") return base;
  const digest = createHash("sha256").update(canonical).digest("base64url").slice(0, 16);
  return `${base}#${digest}`;
}

export const stableIdFor = deriveStableId;
export const subscriptionStableId = deriveStableId;

const INACTIVE_STATUS = new Set(["stopped", "ended", "failed", "cancelled"]);

export function subscriptionEnabled(status: string): boolean {
  return !INACTIVE_STATUS.has(status);
}

const SUBSCRIPTION_STATES = new Set<McpSubscriptionState>([
  "active",
  "stalled",
  "recovering",
  "dead",
  "cancelled",
]);

export function normalizeSubscriptionState(value: unknown): McpSubscriptionState | undefined {
  return typeof value === "string" && SUBSCRIPTION_STATES.has(value as McpSubscriptionState)
    ? (value as McpSubscriptionState)
    : undefined;
}

export function deriveSubscriptionState(
  status: string,
  state?: McpSubscriptionState,
): McpSubscriptionState {
  if (state !== undefined) return state;
  if (status === "cancelled" || status === "stopped" || status === "ended") return "cancelled";

  if (status === "failed") return "stalled";
  if (status === "opening" || status === "reconnecting") return "recovering";
  return "active";
}

function normalizeEventIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result.slice(-MAX_DELIVERED_EVENT_IDS);
}

function normalizeRecord(value: unknown): McpSubscriptionRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.server !== "string" || typeof value.name !== "string") return null;
  const status =
    typeof value.status === "string" && value.status.length > 0 ? value.status : "active";
  const args = normalizeArguments(value.arguments);
  const stableId =
    typeof value.stableId === "string" && value.stableId.length > 0
      ? value.stableId
      : deriveStableId(value.server, value.name, args);
  return {
    server: value.server,
    name: value.name,
    ...(typeof value.title === "string" && value.title.trim().length > 0
      ? { title: value.title }
      : {}),
    stableId,
    ...(typeof value.generation === "string" && value.generation.length > 0
      ? { generation: value.generation }
      : typeof value.generation === "number" && Number.isFinite(value.generation)
        ? { generation: value.generation }
        : {}),
    id: typeof value.id === "string" && value.id.length > 0 ? value.id : null,
    arguments: args,
    cursor: typeof value.cursor === "string" ? value.cursor : null,
    status,
    enabled: typeof value.enabled === "boolean" ? value.enabled : subscriptionEnabled(status),
    deliveredEventIds: normalizeEventIds(value.deliveredEventIds),
    ...(normalizeSubscriptionState(value.state) === undefined
      ? {}
      : { state: normalizeSubscriptionState(value.state) }),
    ...(typeof value.lastEventAt === "string" && value.lastEventAt.length > 0
      ? { lastEventAt: value.lastEventAt }
      : {}),
    ...(typeof value.lastHeartbeatAt === "string" && value.lastHeartbeatAt.length > 0
      ? { lastHeartbeatAt: value.lastHeartbeatAt }
      : {}),
    ...(typeof value.lastPollAt === "string" && value.lastPollAt.length > 0
      ? { lastPollAt: value.lastPollAt }
      : {}),
    ...(typeof value.lastError === "string" && value.lastError.length > 0
      ? { lastError: value.lastError }
      : {}),
    ...(typeof value.lastErrorAt === "string" && value.lastErrorAt.length > 0
      ? { lastErrorAt: value.lastErrorAt }
      : {}),
    ...(typeof value.recoveryFailures === "number" &&
    Number.isSafeInteger(value.recoveryFailures) &&
    value.recoveryFailures >= 0
      ? { recoveryFailures: value.recoveryFailures }
      : {}),
    ...(typeof value.recoveryPending === "boolean"
      ? { recoveryPending: value.recoveryPending }
      : {}),
    ...(typeof value.recoveryStartedAt === "string" && value.recoveryStartedAt.length > 0
      ? { recoveryStartedAt: value.recoveryStartedAt }
      : {}),
    ...(typeof value.reconnects === "number" &&
    Number.isSafeInteger(value.reconnects) &&
    value.reconnects >= 0
      ? { reconnects: value.reconnects }
      : {}),
    ...(typeof value.lastReconnectReason === "string" && value.lastReconnectReason.length > 0
      ? { lastReconnectReason: value.lastReconnectReason }
      : {}),
    ...(typeof value.endReason === "string" && value.endReason.length > 0
      ? { endReason: value.endReason }
      : {}),
    updatedAt:
      typeof value.updatedAt === "string" && value.updatedAt.length > 0
        ? value.updatedAt
        : new Date(0).toISOString(),
  };
}

function needsRewrite(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.stableId !== "string" ||
    value.stableId.length === 0 ||
    !("id" in value) ||
    typeof value.enabled !== "boolean" ||
    !Array.isArray(value.deliveredEventIds)
  );
}

export function subscriptionKey(
  server: string,
  name: string,
  args: Record<string, unknown> | undefined,
): string {
  return `${server}\u0000${name}\u0000${sortKeyArguments(args)}`;
}

export function recordKey(record: McpSubscriptionRecord): string {
  return subscriptionKey(record.server, record.name, record.arguments);
}

export function recordStableId(record: McpSubscriptionRecord): string {
  return record.stableId ?? deriveStableId(record.server, record.name, record.arguments);
}

export const stableIdForRecord = recordStableId;

function newer(first: McpSubscriptionRecord, second: McpSubscriptionRecord): boolean {
  return Date.parse(second.updatedAt) >= Date.parse(first.updatedAt);
}

function parseTime(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function hasPosition(cursor: string | null | undefined): cursor is string {
  if (typeof cursor !== "string" || cursor.trim().length === 0) return false;
  const match = /:(\d+)$/.exec(cursor) ?? /^(\d+)$/.exec(cursor);
  if (match === null) return true;
  return Number(match[1]) !== 0;
}

function hasUsableCursor(record: McpSubscriptionRecord): boolean {
  return hasPosition(record.cursor);
}

function isCancelledRecord(record: McpSubscriptionRecord): boolean {
  return record.status === "cancelled";
}

function observedAt(record: McpSubscriptionRecord): number {
  return (
    parseTime(record.lastEventAt) ??
    parseTime(record.lastHeartbeatAt) ??
    parseTime(record.lastPollAt) ??
    parseTime(record.updatedAt) ??
    0
  );
}

function preferRecord(
  first: McpSubscriptionRecord,
  second: McpSubscriptionRecord,
): McpSubscriptionRecord {
  if (recordStableId(first) === recordStableId(second)) {
    const firstCancelled = isCancelledRecord(first);
    const secondCancelled = isCancelledRecord(second);
    if (firstCancelled !== secondCancelled) return firstCancelled ? first : second;
  }
  const firstEventAt = parseTime(first.lastEventAt);
  const secondEventAt = parseTime(second.lastEventAt);
  if (firstEventAt !== undefined || secondEventAt !== undefined) {
    const firstAt = firstEventAt ?? Number.NEGATIVE_INFINITY;
    const secondAt = secondEventAt ?? Number.NEGATIVE_INFINITY;
    if (firstAt !== secondAt) return firstAt > secondAt ? first : second;
  }
  const firstCursor = hasUsableCursor(first);
  const secondCursor = hasUsableCursor(second);
  if (firstCursor !== secondCursor) return firstCursor ? first : second;
  const firstAt = observedAt(first);
  const secondAt = observedAt(second);
  return secondAt > firstAt ? second : first;
}

function dedupeByServerName(records: readonly McpSubscriptionRecord[]): {
  records: McpSubscriptionRecord[];
  dropped: Map<string, number>;
} {
  const byName = new Map<string, McpSubscriptionRecord>();
  const dropped = new Map<string, number>();
  for (const record of records) {
    const nameKey = `${record.server}\u0000${record.name}`;
    const existing = byName.get(nameKey);
    if (existing === undefined) {
      byName.set(nameKey, record);
      continue;
    }
    byName.set(nameKey, preferRecord(existing, record));
    const label = `${record.server}/${record.name}`;
    dropped.set(label, (dropped.get(label) ?? 0) + 1);
  }
  return { records: [...byName.values()], dropped };
}

function mergeRecord(
  existing: McpSubscriptionRecord,
  incoming: McpSubscriptionRecord,
): McpSubscriptionRecord {
  const latest = newer(existing, incoming) ? incoming : existing;

  const cursor = latest.cursor;
  let status = latest.status;
  let enabled = latest.enabled ?? subscriptionEnabled(status);

  const cancelled =
    existing.status === "cancelled"
      ? existing
      : incoming.status === "cancelled"
        ? incoming
        : undefined;
  if (
    cancelled !== undefined &&
    status !== "cancelled" &&
    (latest.id ?? null) === (cancelled.id ?? null)
  ) {
    status = "cancelled";
    enabled = false;
  }
  const state = latest.state ?? existing.state ?? incoming.state;
  return {
    ...latest,
    stableId: latest.stableId ?? existing.stableId ?? incoming.stableId,
    generation: latest.generation ?? existing.generation ?? incoming.generation,

    id: latest.id ?? existing.id ?? incoming.id ?? null,
    status,
    enabled,

    deliveredEventIds: normalizeEventIds(
      latest.deliveredEventIds ?? existing.deliveredEventIds ?? incoming.deliveredEventIds ?? [],
    ),
    ...(state === undefined ? {} : { state }),
    lastEventAt: latest.lastEventAt ?? existing.lastEventAt ?? incoming.lastEventAt,
    lastHeartbeatAt: latest.lastHeartbeatAt ?? existing.lastHeartbeatAt ?? incoming.lastHeartbeatAt,
    lastPollAt: latest.lastPollAt ?? existing.lastPollAt ?? incoming.lastPollAt,
    ...(latest.state === "active"
      ? {}
      : { lastError: latest.lastError ?? existing.lastError ?? incoming.lastError }),
    lastErrorAt: latest.lastErrorAt ?? existing.lastErrorAt ?? incoming.lastErrorAt,
    recoveryFailures:
      latest.recoveryFailures ?? existing.recoveryFailures ?? incoming.recoveryFailures,
    recoveryPending: latest.recoveryPending ?? existing.recoveryPending ?? incoming.recoveryPending,
    recoveryStartedAt:
      latest.recoveryStartedAt ?? existing.recoveryStartedAt ?? incoming.recoveryStartedAt,
    reconnects: latest.reconnects ?? existing.reconnects ?? incoming.reconnects,
    lastReconnectReason:
      latest.lastReconnectReason ?? existing.lastReconnectReason ?? incoming.lastReconnectReason,
    endReason:
      latest.status === "active"
        ? undefined
        : (latest.endReason ?? existing.endReason ?? incoming.endReason),
    cursor,
  };
}

export class McpSubscriptionRegistry {
  readonly path: string;
  private readonly throttleMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly records = new Map<string, McpSubscriptionRecord>();
  private loaded = false;
  private loading: Promise<void> | undefined;
  private dirty = false;
  private lastWriteAt = 0;
  private timer: NodeJS.Timeout | undefined;
  private pending:
    | {
        readonly promise: Promise<void>;
        readonly resolve: () => void;
        readonly reject: (error: unknown) => void;
      }
    | undefined;
  private writing: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(pathOrDataDir: string, options: McpSubscriptionRegistryOptions = {}) {
    this.path = pathOrDataDir.endsWith(".json")
      ? pathOrDataDir
      : join(pathOrDataDir, options.fileName ?? MCP_SUBSCRIPTIONS_FILE);
    this.throttleMs = options.throttleMs ?? 1_000;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.warn(line));
  }

  async read(): Promise<McpSubscriptionRecord[]> {
    await this.load();
    return [...this.records.values()];
  }

  list(): McpSubscriptionRecord[] {
    return [...this.records.values()];
  }

  entries(): McpSubscriptionRecord[] {
    return this.list();
  }

  readAll(): Promise<McpSubscriptionRecord[]> {
    return this.read();
  }

  findByStableId(stableId: string): McpSubscriptionRecord | undefined {
    for (const record of this.records.values()) {
      if (recordStableId(record) === stableId) return record;
    }
    return undefined;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loading !== undefined) return this.loading;
    this.loading = (async () => {
      try {
        const migrated = await this.readFile();
        this.loaded = true;
        if (migrated) {
          this.dirty = true;
          try {
            await this.writeNow();
          } catch (error) {
            this.log(`mcp: could not rewrite ${this.path}: ${String(error)}`);
          }
        }
      } finally {
        this.loading = undefined;
      }
    })();
    return this.loading;
  }

  record(entry: McpSubscriptionRecord): Promise<void> {
    if (this.closed) return Promise.resolve();
    const incoming = normalizeRecord(entry);
    if (incoming === null) return Promise.resolve();
    const key = recordKey(incoming);
    const existing = this.records.get(key);
    this.records.set(key, existing === undefined ? incoming : mergeRecord(existing, incoming));
    this.dirty = true;
    return this.scheduleWrite();
  }

  upsert(entry: McpSubscriptionRecord): Promise<void> {
    return this.record(entry);
  }

  save(): Promise<void> {
    return this.flush();
  }

  write(): Promise<void> {
    return this.flush();
  }

  async cancel(stableId: string): Promise<McpSubscriptionRecord | null> {
    await this.load();
    let found: McpSubscriptionRecord | undefined;
    for (const [key, record] of this.records) {
      if (recordStableId(record) !== stableId) continue;
      const cancelled: McpSubscriptionRecord =
        record.status === "cancelled" && record.enabled === false
          ? record
          : {
              ...record,
              stableId: recordStableId(record),
              enabled: false,
              status: "cancelled",
              updatedAt: new Date(this.now()).toISOString(),
            };
      if (cancelled !== record) {
        this.records.set(key, cancelled);
        this.dirty = true;
      }
      found = cancelled;
    }
    if (found !== undefined && this.dirty) await this.flush();
    return found ?? null;
  }

  cancelByStableId(stableId: string): Promise<McpSubscriptionRecord | null> {
    return this.cancel(stableId);
  }

  async prune(stableIds: ReadonlySet<string> | readonly string[]): Promise<number> {
    await this.load();
    const keep = stableIds instanceof Set ? stableIds : new Set(stableIds);
    let removed = 0;
    for (const [key, record] of this.records) {
      if (keep.has(recordStableId(record))) continue;
      this.records.delete(key);
      this.dirty = true;
      removed += 1;
    }
    if (removed > 0) await this.flush();
    return removed;
  }

  flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const pending = this.pending;
    this.pending = undefined;
    if (!this.dirty) {
      pending?.resolve();
      return this.writing;
    }
    const run = this.writing.then(async () => {
      await this.load();
      if (!this.dirty) return;
      await this.writeNow();
    });
    this.writing = run.then(
      () => undefined,
      () => undefined,
    );
    if (pending !== undefined) {
      run.then(pending.resolve, pending.reject);
    }
    return run;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.flush();
  }

  private scheduleWrite(): Promise<void> {
    if (this.pending !== undefined) return this.pending.promise;
    const wait = Math.max(0, this.lastWriteAt + this.throttleMs - this.now());
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.pending = { promise, resolve, reject };
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.pending = undefined;
      void this.flush().then(resolve, reject);
    }, wait);
    this.timer.unref?.();
    return promise;
  }

  private async readFile(): Promise<boolean> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.log(`mcp: could not read ${this.path}: ${String(error)}`);
      }
      return false;
    }
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      this.log(`mcp: ignoring corrupt subscription registry ${this.path}`);
      return false;
    }
    if (!isRecord(document) || document.version !== MCP_SUBSCRIPTIONS_VERSION) {
      this.log(`mcp: ignoring unknown subscription registry version in ${this.path}`);
      return false;
    }
    if (!Array.isArray(document.subscriptions)) {
      this.log(`mcp: ignoring corrupt subscription registry ${this.path}`);
      return false;
    }
    let migrated = false;
    const incoming: McpSubscriptionRecord[] = [];
    for (const value of document.subscriptions) {
      const record = normalizeRecord(value);
      if (record === null) continue;
      if (needsRewrite(value)) migrated = true;
      incoming.push(record);
    }
    const deduped = dedupeByServerName(incoming);
    if (deduped.dropped.size > 0) {
      migrated = true;
      const count = [...deduped.dropped.values()].reduce((sum, value) => sum + value, 0);
      const names = [...deduped.dropped.keys()].join(", ");
      this.log(
        `mcp: dropped ${count} duplicate subscription row${count === 1 ? "" : "s"} for ${names}`,
      );
    }
    for (const record of deduped.records) {
      const key = recordKey(record);
      const existing = this.records.get(key);
      this.records.set(key, existing === undefined ? record : mergeRecord(existing, record));
    }
    return migrated;
  }

  private async writeNow(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    this.lastWriteAt = this.now();
    const document: RegistryDocument = {
      version: MCP_SUBSCRIPTIONS_VERSION,
      subscriptions: [...this.records.values()],
    };
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, "utf8");
      await rename(temp, this.path);
    } catch (error) {
      this.dirty = true;
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }
}

export { McpSubscriptionRegistry as McpSubscriptionStore };
