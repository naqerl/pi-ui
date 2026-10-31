import { generateKeyPairSync, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import webpush from "web-push";

/** The VAPID key pair lives next to the rest of pi-ui's durable state. */
export const PUSH_VAPID_FILE = "push-vapid.json";
export const PUSH_SUBSCRIPTIONS_FILE = "push-subscriptions.json";
export const PUSH_SUBSCRIPTIONS_VERSION = 1;
/** Web push requires a contact address in the VAPID subject. */
export const PUSH_VAPID_SUBJECT = "mailto:pi@localhost";

const MAX_TITLE_CHARS = 60;
export const MAX_BODY_CHARS = 140;

export interface PushSubscriptionKeys {
  readonly p256dh: string;
  readonly auth: string;
}

export interface PushSubscriptionRecord {
  readonly endpoint: string;
  readonly keys: PushSubscriptionKeys;
  readonly createdAt: string;
  readonly lastOkAt: string | null;
}

export interface PushVapidKeys {
  readonly publicKey: string;
  readonly privateKey: string;
}

export interface PushNotification {
  readonly title: string;
  readonly body?: string;
  readonly url?: string;
  readonly tag?: string;
}

export interface PushSubscriptionStoreOptions {
  /** Minimum milliseconds between background writes. */
  readonly throttleMs?: number;
  /** Override the clock in tests. */
  readonly now?: () => number;
  /** One line is logged for a corrupt or unknown registry; never per event. */
  readonly log?: (line: string) => void;
  /** Override the file name (used by tests); it still lives under the data dir. */
  readonly fileName?: string;
}

export interface VapidKeyOptions {
  readonly log?: (line: string) => void;
}

export interface PushTarget {
  readonly endpoint: string;
  readonly keys: PushSubscriptionKeys;
}

export type PushSender = (
  subscription: PushTarget,
  payload: string,
  options: {
    readonly TTL: number;
    readonly vapidDetails: {
      readonly subject: string;
      readonly publicKey: string;
      readonly privateKey: string;
    };
  },
) => Promise<unknown>;

export interface PushServiceOptions {
  readonly dataDir: string;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  readonly send?: PushSender;
  readonly vapidSubject?: string;
  readonly throttleMs?: number;
  /** Reuse a store, mostly for tests that want to inspect the same records. */
  readonly store?: PushSubscriptionStore;
}

interface SubscriptionDocument {
  readonly version: number;
  readonly subscriptions: PushSubscriptionRecord[];
}

interface VapidDocument {
  readonly publicKey: string;
  readonly privateKey: string;
}

interface PendingWrite {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

const pendingKeyLoads = new Map<string, Promise<PushVapidKeys>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statePath(pathOrDataDir: string, fileName: string): string {
  return pathOrDataDir.endsWith(".json") ? pathOrDataDir : join(pathOrDataDir, fileName);
}

function normalizeKeys(value: unknown): PushSubscriptionKeys | null {
  if (!isRecord(value)) return null;
  if (typeof value.p256dh !== "string" || value.p256dh.length === 0) return null;
  if (typeof value.auth !== "string" || value.auth.length === 0) return null;
  return { p256dh: value.p256dh, auth: value.auth };
}

function normalizeSubscription(value: unknown, now: string): PushSubscriptionRecord | null {
  if (!isRecord(value)) return null;
  const endpoint = typeof value.endpoint === "string" ? value.endpoint.trim() : "";
  const keys = normalizeKeys(value.keys);
  if (endpoint.length === 0 || keys === null) return null;
  return {
    endpoint,
    keys,
    createdAt:
      typeof value.createdAt === "string" && value.createdAt.length > 0 ? value.createdAt : now,
    lastOkAt: typeof value.lastOkAt === "string" ? value.lastOkAt : null,
  };
}

function subscriptionFrom(
  value: unknown,
  now = new Date().toISOString(),
): PushSubscriptionRecord | null {
  return normalizeSubscription(value, now);
}

/**
 * Durable `DATA_DIR/push-subscriptions.json`. Reads never throw: a missing,
 * corrupt or unknown file simply starts empty. Writes are coalesced and
 * throttled, and use a temporary file plus rename so a crash cannot leave a
 * half-written registry behind.
 */
export class PushSubscriptionStore {
  readonly path: string;
  private readonly throttleMs: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly records = new Map<string, PushSubscriptionRecord>();
  private loaded = false;
  private loading: Promise<void> | undefined;
  private dirty = false;
  private lastWriteAt = 0;
  private timer: NodeJS.Timeout | undefined;
  private pending: PendingWrite | undefined;
  private writing: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(pathOrDataDir: string, options: PushSubscriptionStoreOptions = {}) {
    this.path = statePath(pathOrDataDir, options.fileName ?? PUSH_SUBSCRIPTIONS_FILE);
    this.throttleMs = options.throttleMs ?? 1_000;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.warn(line));
  }

  async read(): Promise<PushSubscriptionRecord[]> {
    await this.load();
    return [...this.records.values()];
  }

  list(): PushSubscriptionRecord[] {
    return [...this.records.values()];
  }

  entries(): PushSubscriptionRecord[] {
    return this.list();
  }

  readAll(): Promise<PushSubscriptionRecord[]> {
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

  /** Adds a subscription. The same endpoint replaces the earlier record. */
  async subscribe(value: unknown): Promise<PushSubscriptionRecord | null> {
    if (this.closed) return null;
    await this.load();
    const record = subscriptionFrom(value, new Date(this.now()).toISOString());
    if (record === null) return null;
    this.records.set(record.endpoint, record);
    this.dirty = true;
    await this.scheduleWrite();
    return record;
  }

  add(value: unknown): Promise<PushSubscriptionRecord | null> {
    return this.subscribe(value);
  }

  upsert(value: unknown): Promise<PushSubscriptionRecord | null> {
    return this.subscribe(value);
  }

  /** Removes an endpoint, returning whether it was present. Safe to repeat. */
  async remove(endpoint: string): Promise<boolean> {
    await this.load();
    const key = endpoint.trim();
    const existed = this.records.delete(key);
    if (!existed) return false;
    this.dirty = true;
    await this.scheduleWrite();
    return true;
  }

  /** Notes a successful delivery without making the sender wait for the write. */
  markOk(endpoint: string): void {
    const current = this.records.get(endpoint);
    if (current === undefined) return;
    this.records.set(endpoint, { ...current, lastOkAt: new Date(this.now()).toISOString() });
    this.dirty = true;
    void this.scheduleWrite().catch((error: unknown) => {
      this.log(`push: could not save delivery time: ${String(error)}`);
    });
  }

  async flush(): Promise<void> {
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
    if (pending !== undefined) run.then(pending.resolve, pending.reject);
    return run;
  }

  save(): Promise<void> {
    return this.flush();
  }

  write(): Promise<void> {
    return this.flush();
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

  private async readFile(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.log(`push: could not read ${this.path}: ${String(error)}`);
      }
      return;
    }
    let document: unknown;
    try {
      document = JSON.parse(text);
    } catch {
      this.log(`push: ignoring corrupt subscription registry ${this.path}`);
      return;
    }
    if (Array.isArray(document)) {
      this.mergeRecords(document);
      return;
    }
    if (!isRecord(document)) {
      this.log(`push: ignoring corrupt subscription registry ${this.path}`);
      return;
    }
    if (
      "version" in document &&
      document.version !== undefined &&
      document.version !== PUSH_SUBSCRIPTIONS_VERSION
    ) {
      this.log(`push: ignoring unknown subscription registry version in ${this.path}`);
      return;
    }
    if (!Array.isArray(document.subscriptions)) {
      this.log(`push: ignoring corrupt subscription registry ${this.path}`);
      return;
    }
    this.mergeRecords(document.subscriptions);
  }

  private mergeRecords(values: readonly unknown[]): void {
    for (const value of values) {
      const record = normalizeSubscription(value, new Date(this.now()).toISOString());
      if (record === null) continue;
      this.records.set(record.endpoint, record);
    }
  }

  private async writeNow(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    this.lastWriteAt = this.now();
    const document: SubscriptionDocument = {
      version: PUSH_SUBSCRIPTIONS_VERSION,
      subscriptions: [...this.records.values()],
    };
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
      await rename(temporary, this.path);
    } catch (error) {
      this.dirty = true;
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }
}

/** Alternate name for callers that think in stores rather than registries. */
export { PushSubscriptionStore as PushSubscriptionRegistry };

function createVapidKeys(): PushVapidKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const publicJwk = publicKey.export({ format: "jwk" });
  const privateJwk = privateKey.export({ format: "jwk" });
  if (typeof publicJwk.x !== "string" || typeof publicJwk.y !== "string") {
    throw new Error("could not export the VAPID public key");
  }
  if (typeof privateJwk.d !== "string") {
    throw new Error("could not export the VAPID private key");
  }
  // `pushManager.subscribe()` wants the uncompressed point: 0x04 || x || y.
  const point = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(publicJwk.x, "base64url"),
    Buffer.from(publicJwk.y, "base64url"),
  ]);
  return {
    publicKey: point.toString("base64url"),
    privateKey: Buffer.from(privateJwk.d, "base64url").toString("base64url"),
  };
}

async function readOrCreateVapidKeys(
  path: string,
  options: VapidKeyOptions,
): Promise<PushVapidKeys> {
  const log = options.log ?? ((line) => console.warn(line));
  let text: string | undefined;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log(`push: could not read ${path}: ${String(error)}`);
    }
  }
  if (text !== undefined) {
    try {
      const document: unknown = JSON.parse(text);
      if (
        isRecord(document) &&
        typeof document.publicKey === "string" &&
        document.publicKey.length > 0 &&
        typeof document.privateKey === "string" &&
        document.privateKey.length > 0
      ) {
        return { publicKey: document.publicKey, privateKey: document.privateKey };
      }
      log(`push: ignoring corrupt VAPID key file ${path}`);
    } catch {
      log(`push: ignoring corrupt VAPID key file ${path}`);
    }
  }

  const keys = createVapidKeys();
  const document: VapidDocument = { publicKey: keys.publicKey, privateKey: keys.privateKey };
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return keys;
}

/**
 * Reads `DATA_DIR/push-vapid.json`, generating the pair on first use. The file
 * keeps the private key at mode 0600 and survives later starts unchanged.
 */
export function loadOrCreateVapidKeys(
  pathOrDataDir: string,
  options: VapidKeyOptions = {},
): Promise<PushVapidKeys> {
  const path = statePath(pathOrDataDir, PUSH_VAPID_FILE);
  const pending = pendingKeyLoads.get(path);
  if (pending !== undefined) return pending;
  const run = readOrCreateVapidKeys(path, options);
  pendingKeyLoads.set(path, run);
  return run.finally(() => {
    pendingKeyLoads.delete(path);
  });
}

export function clampPushText(value: string, limit: number): string {
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length <= limit) return oneLine;
  return `${oneLine.slice(0, Math.max(0, limit - 1))}…`;
}

function normalizeNotification(input: PushNotification): PushNotification {
  const title = clampPushText(input.title, MAX_TITLE_CHARS) || "pi";
  const body = clampPushText(input.body ?? "", MAX_BODY_CHARS);
  const rawUrl = typeof input.url === "string" ? input.url.trim() : "";
  const url = rawUrl.startsWith("/") ? rawUrl : "/";
  const tag = clampPushText(input.tag ?? "", 80);
  return { title, body, url, ...(tag.length > 0 ? { tag } : {}) };
}

function errorStatus(error: unknown): number | null {
  if (!isRecord(error)) return null;
  const value = error.statusCode;
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Owns the VAPID keys and the subscription registry. Sending is best-effort:
 * one dead endpoint is dropped, any other failure is logged and skipped, and
 * `notify()` never throws into a turn or a route.
 */
export class PushService {
  readonly store: PushSubscriptionStore;
  private readonly dataDir: string;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly send: PushSender;
  private readonly subject: string;
  private keys: Promise<PushVapidKeys> | undefined;

  constructor(
    dataDirOrOptions: string | PushServiceOptions,
    options: PushServiceOptions | Omit<PushServiceOptions, "dataDir"> = {},
  ) {
    const resolved: PushServiceOptions =
      typeof dataDirOrOptions === "string"
        ? { ...(options as Omit<PushServiceOptions, "dataDir">), dataDir: dataDirOrOptions }
        : dataDirOrOptions;
    this.dataDir = resolved.dataDir;
    this.now = resolved.now ?? Date.now;
    this.log = resolved.log ?? ((line) => console.warn(line));
    this.subject = resolved.vapidSubject ?? PUSH_VAPID_SUBJECT;
    this.store =
      resolved.store ??
      new PushSubscriptionStore(resolved.dataDir, {
        ...(resolved.throttleMs === undefined ? {} : { throttleMs: resolved.throttleMs }),
        now: this.now,
        log: this.log,
      });
    this.send =
      resolved.send ??
      ((subscription, payload, sendOptions) =>
        webpush.sendNotification(subscription, payload, sendOptions));
  }

  private vapidKeys(): Promise<PushVapidKeys> {
    this.keys ??= loadOrCreateVapidKeys(this.dataDir, { log: this.log });
    return this.keys;
  }

  /** The base64url uncompressed point a browser passes as `applicationServerKey`. */
  async publicKey(): Promise<string> {
    return (await this.vapidKeys()).publicKey;
  }

  async subscribe(value: unknown): Promise<PushSubscriptionRecord | null> {
    return this.store.subscribe(value);
  }

  add(value: unknown): Promise<PushSubscriptionRecord | null> {
    return this.subscribe(value);
  }

  async unsubscribe(endpoint: string): Promise<void> {
    await this.store.remove(endpoint);
  }

  async status(): Promise<{ subscriptions: number; enabled: true }> {
    return { subscriptions: (await this.store.read()).length, enabled: true };
  }

  /** Sends one notification to every stored subscription. Never throws. */
  async notify(input: PushNotification): Promise<void> {
    try {
      const subscriptions = await this.store.read();
      if (subscriptions.length === 0) return;
      const keys = await this.vapidKeys();
      const payload = JSON.stringify(normalizeNotification(input));
      await Promise.all(
        subscriptions.map(async (subscription) => {
          try {
            await this.send({ endpoint: subscription.endpoint, keys: subscription.keys }, payload, {
              TTL: 60 * 60 * 24,
              vapidDetails: {
                subject: this.subject,
                publicKey: keys.publicKey,
                privateKey: keys.privateKey,
              },
            });
            this.store.markOk(subscription.endpoint);
          } catch (error) {
            const status = errorStatus(error);
            if (status === 404 || status === 410) {
              try {
                await this.store.remove(subscription.endpoint);
              } catch (removeError) {
                this.log(`push: could not drop ${subscription.endpoint}: ${String(removeError)}`);
              }
              return;
            }
            this.log(`push: could not notify ${subscription.endpoint}: ${errorMessage(error)}`);
          }
        }),
      );
    } catch (error) {
      this.log(`push: notification skipped: ${errorMessage(error)}`);
    }
  }

  async close(): Promise<void> {
    await this.store.close();
  }
}

export function createPushService(
  dataDirOrOptions: string | PushServiceOptions,
  options: PushServiceOptions | Omit<PushServiceOptions, "dataDir"> = {},
): PushService {
  return new PushService(dataDirOrOptions, options);
}

function defaultDataDir(): string {
  return resolve(process.cwd(), process.env.DATA_DIR?.trim() || "data");
}

let defaultService: PushService | undefined;

/** Points the module-level `notify()` used by the server at one data directory. */
export function configurePush(
  dataDirOrOptions: string | PushServiceOptions,
  options: PushServiceOptions | Omit<PushServiceOptions, "dataDir"> = {},
): PushService {
  defaultService = createPushService(dataDirOrOptions, options);
  return defaultService;
}

export function getPushService(): PushService {
  defaultService ??= createPushService(defaultDataDir());
  return defaultService;
}

export function resetPushServiceForTests(): void {
  defaultService = undefined;
}

export async function pushPublicKey(): Promise<string> {
  return getPushService().publicKey();
}

export function subscribePush(value: unknown): Promise<PushSubscriptionRecord | null> {
  return getPushService().subscribe(value);
}

export function unsubscribePush(endpoint: string): Promise<void> {
  return getPushService().unsubscribe(endpoint);
}

export function pushStatus(): Promise<{ subscriptions: number; enabled: true }> {
  return getPushService().status();
}

/** Best-effort notification used by the three server notice paths. */
export async function notify(input: PushNotification): Promise<void> {
  await getPushService().notify(input);
}

export async function closePush(): Promise<void> {
  const service = defaultService;
  defaultService = undefined;
  if (service !== undefined) await service.close();
}

export { subscriptionFrom };
