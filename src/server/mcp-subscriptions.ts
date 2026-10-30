import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** The registry lives next to the rest of pi-ui's durable state. */
export const MCP_SUBSCRIPTIONS_FILE = "mcp-subscriptions.json";
export const MCP_SUBSCRIPTIONS_VERSION = 1;

export type McpSubscriptionRecordStatus =
  | "opening"
  | "active"
  | "reconnecting"
  | "stopped"
  | "ended"
  | "failed"
  | (string & {});

export interface McpSubscriptionRecord {
  readonly server: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly cursor: string | null;
  readonly status: McpSubscriptionRecordStatus;
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

function normalizeRecord(value: unknown): McpSubscriptionRecord | null {
  if (!isRecord(value)) return null;
  if (typeof value.server !== "string" || typeof value.name !== "string") return null;
  const status =
    typeof value.status === "string" && value.status.length > 0 ? value.status : "active";
  return {
    server: value.server,
    name: value.name,
    arguments: normalizeArguments(value.arguments),
    cursor: typeof value.cursor === "string" ? value.cursor : null,
    status,
    updatedAt:
      typeof value.updatedAt === "string" && value.updatedAt.length > 0
        ? value.updatedAt
        : new Date(0).toISOString(),
  };
}

/** One entry per server, stream name and exact arguments document. */
export function subscriptionKey(
  server: string,
  name: string,
  args: Record<string, unknown> | undefined,
): string {
  return `${server}\u0000${name}\u0000${JSON.stringify(args ?? {})}`;
}

export function recordKey(record: McpSubscriptionRecord): string {
  return subscriptionKey(record.server, record.name, record.arguments);
}

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
  return {
    ...latest,
    cursor,
  };
}

/**
 * Durable `DATA_DIR/mcp-subscriptions.json` registry. Reads never throw: a
 * missing, corrupt or future-versioned file simply starts an empty registry.
 * Background writes are coalesced and throttled; `flush()`/`close()` force the
 * final write so a shutdown keeps the last cursor.
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

  async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loading !== undefined) return this.loading;
    this.loading = this.readFile();
    try {
      await this.loading;
      this.loaded = true;
    } finally {
      this.loading = undefined;
    }
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

  private async readFile(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.log(`mcp: could not read ${this.path}: ${String(error)}`);
      }
      return;
    }
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      this.log(`mcp: ignoring corrupt subscription registry ${this.path}`);
      return;
    }
    if (!isRecord(document) || document.version !== MCP_SUBSCRIPTIONS_VERSION) {
      this.log(`mcp: ignoring unknown subscription registry version in ${this.path}`);
      return;
    }
    if (!Array.isArray(document.subscriptions)) {
      this.log(`mcp: ignoring corrupt subscription registry ${this.path}`);
      return;
    }
    for (const value of document.subscriptions) {
      const record = normalizeRecord(value);
      if (record === null) continue;
      const key = recordKey(record);
      const existing = this.records.get(key);
      this.records.set(key, existing === undefined ? record : mergeRecord(existing, record));
    }
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
