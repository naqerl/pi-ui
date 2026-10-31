import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The registry lives next to the rest of pi-ui's durable state. */
export const MCP_SUBSCRIPTIONS_FILE = "mcp-subscriptions.json";
export const MCP_SUBSCRIPTIONS_VERSION = 1;
/** Delivered ids kept per subscription for replay detection after a restart. */
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
  /** Never changes for the same server, stream name and arguments document. */
  readonly stableId?: string;
  /** Adapter id. It changes when the process subscribes again. */
  readonly id?: string | null;
  readonly arguments: Record<string, unknown>;
  readonly cursor: string | null;
  readonly status: McpSubscriptionRecordStatus;
  /** False for a cancelled/stopped entry, so boot does not resubscribe it. */
  readonly enabled?: boolean;
  /** Most recent event ids delivered for this stable id, oldest first. */
  readonly deliveredEventIds?: readonly string[];
  readonly updatedAt: string;
}

interface RegistryDocument {
  readonly version: number;
  readonly subscriptions: McpSubscriptionRecord[];
}

export interface McpSubscriptionRegistryOptions {
  /** Minimum milliseconds between background writes. */
  readonly throttleMs?: number;
  /** Override the clock in tests. */
  readonly now?: () => number;
  /** One line is logged for a corrupt or unknown registry; never per event. */
  readonly log?: (line: string) => void;
  /** Override the file name (used by tests); it still lives under the data dir. */
  readonly fileName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeArguments(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Recursively sort object keys so argument order cannot change the identity. */
function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortValue(value[key])]),
  );
}

/** Canonical JSON used only to derive a stable id. */
export function sortKeyArguments(args: Record<string, unknown> | undefined): string {
  try {
    return JSON.stringify(sortValue(args ?? {}));
  } catch {
    return "{}";
  }
}

/**
 * A subscription's identity in pi-ui. It survives restarts and argument order,
 * while the adapter id (`mcp-extension-<uuid>-<n>`) does not. The common
 * no-arguments form is human readable, e.g. `zeroshot/hub`.
 */
export function deriveStableId(
  server: string,
  name: string,
  args: Record<string, unknown> | undefined,
): string {
  const base = `${encodeURIComponent(server)}/${encodeURIComponent(name)}`;
  const canonical = sortKeyArguments(args);
  if (canonical === "{}") return base;
  const digest = createHash("sha256").update(canonical).digest("base64url").slice(0, 16);
  return `${base}#${digest}`;
}

/** Alternate names kept for callers that describe the value rather than derive it. */
export const stableIdFor = deriveStableId;
export const subscriptionStableId = deriveStableId;

const INACTIVE_STATUS = new Set(["stopped", "ended", "failed", "cancelled"]);

/** A status only counts as enabled when boot may restore it. */
export function subscriptionEnabled(status: string): boolean {
  return !INACTIVE_STATUS.has(status);
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

function mergedEventIds(
  first: readonly string[] | undefined,
  second: readonly string[] | undefined,
): string[] {
  return normalizeEventIds([...(first ?? []), ...(second ?? [])]);
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
    stableId,
    id: typeof value.id === "string" && value.id.length > 0 ? value.id : null,
    arguments: args,
    cursor: typeof value.cursor === "string" ? value.cursor : null,
    status,
    enabled: typeof value.enabled === "boolean" ? value.enabled : subscriptionEnabled(status),
    deliveredEventIds: normalizeEventIds(value.deliveredEventIds),
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

/** One entry per server, stream name and canonical arguments document. */
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

/** The stable id of a record, deriving it when an older file omitted it. */
export function recordStableId(record: McpSubscriptionRecord): string {
  return record.stableId ?? deriveStableId(record.server, record.name, record.arguments);
}

/** Alternate name kept for callers that describe the record rather than the value. */
export const stableIdForRecord = recordStableId;

function cursorHighWater(cursor: string | null): number | null {
  if (cursor === null) return null;
  const match = /^hub:(\d+)$/.exec(cursor);
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : null;
}

function newer(first: McpSubscriptionRecord, second: McpSubscriptionRecord): boolean {
  return Date.parse(second.updatedAt) >= Date.parse(first.updatedAt);
}

/** Merge two observations of the same subscription. The newest status wins; a numeric cursor never moves back. */
function mergeRecord(
  existing: McpSubscriptionRecord,
  incoming: McpSubscriptionRecord,
): McpSubscriptionRecord {
  const latest = newer(existing, incoming) ? incoming : existing;
  let cursor = incoming.cursor ?? existing.cursor;
  const existingMark = cursorHighWater(existing.cursor);
  const incomingMark = cursorHighWater(incoming.cursor);
  if (existingMark !== null && incomingMark !== null && existingMark > incomingMark) {
    cursor = existing.cursor;
  }
  let status = latest.status;
  let enabled = latest.enabled ?? subscriptionEnabled(status);
  // A late reconnecting/active notice for the adapter id that was cancelled
  // must not turn the durable entry back on. A genuinely new subscribe gets a
  // new adapter id, so that observation is allowed to replace the cancellation.
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
  return {
    ...latest,
    stableId: latest.stableId ?? existing.stableId ?? incoming.stableId,
    // A rewrite of an old file has no id yet; do not lose one already known.
    id: latest.id ?? existing.id ?? incoming.id ?? null,
    status,
    enabled,
    deliveredEventIds:
      latest === incoming
        ? mergedEventIds(existing.deliveredEventIds, incoming.deliveredEventIds)
        : mergedEventIds(incoming.deliveredEventIds, existing.deliveredEventIds),
    cursor,
  };
}

/**
 * Durable `DATA_DIR/mcp-subscriptions.json` registry. Reads never throw: a
 * missing, corrupt or future-versioned file simply starts an empty registry.
 * Background writes are coalesced and throttled; `flush()`/`close()` force the
 * final write so a shutdown keeps the last cursor.
 *
 * A file written before stable ids existed is upgraded in place on load: the
 * missing stable id, adapter id, enabled flag and delivered-id list are
 * derived, then the file is rewritten once.
 */
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

  /** Persisted entries, deduplicated by `(server, name, arguments)`. */
  async read(): Promise<McpSubscriptionRecord[]> {
    await this.load();
    return [...this.records.values()];
  }

  /** Same data in memory after `read()`; useful for synchronous callers. */
  list(): McpSubscriptionRecord[] {
    return [...this.records.values()];
  }

  entries(): McpSubscriptionRecord[] {
    return this.list();
  }

  readAll(): Promise<McpSubscriptionRecord[]> {
    return this.read();
  }

  /** The entry with this stable id, or undefined. */
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

  /** Remember the newest observation and schedule one throttled write. */
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

  /**
   * Mark every entry with this stable id cancelled. The live adapter id is no
   * longer persisted as enabled, so the next boot does not subscribe again.
   * Repeating it is harmless and returns the same cancelled record.
   */
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

  /** Alternate name for `cancel`, kept for callers that think in identity. */
  cancelByStableId(stableId: string): Promise<McpSubscriptionRecord | null> {
    return this.cancel(stableId);
  }

  /** Force the dirty registry to disk now, bypassing the throttle. */
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
      // Merge what is already on disk before the first write from a fresh
      // instance, so a caller that records before reading still keeps old rows.
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

  /** Final flush on shutdown. The registry is not used for writes afterwards. */
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
    for (const value of document.subscriptions) {
      const record = normalizeRecord(value);
      if (record === null) continue;
      if (needsRewrite(value)) migrated = true;
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

/** Alternate name for the same store, kept for callers that think in stores. */
export { McpSubscriptionRegistry as McpSubscriptionStore };
