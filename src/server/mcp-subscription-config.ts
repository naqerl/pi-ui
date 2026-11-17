import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { deriveStableId } from "./mcp-subscriptions.js";

/** Declared event streams live with mcp.json in the mounted agent dir. */
export const MCP_SUBSCRIPTION_CONFIG_FILE = "subscriptions.json";
export const MCP_SUBSCRIPTION_CONFIG_VERSION = 1;

export interface DeclaredSubscription {
  readonly server: string;
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly title?: string;
}

export interface SubscriptionConfig {
  readonly path: string;
  readonly present: boolean;
  readonly entries: readonly DeclaredSubscription[];
  readonly error?: string;
}

interface MutableDocument {
  version: number;
  subscriptions: DeclaredSubscription[];
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The same agent dir `readServers()` uses for mcp.json. */
export function resolveSubscriptionAgentDir(agentDir?: string): string {
  return resolve(
    agentDir?.trim() || process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent"),
  );
}

export function subscriptionConfigPath(agentDir?: string): string {
  return resolve(resolveSubscriptionAgentDir(agentDir), MCP_SUBSCRIPTION_CONFIG_FILE);
}

/** `encodeURIComponent` is the stable-id boundary; a lone surrogate fails it. */
function isStableIdComponent(value: string): boolean {
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

function normalizeEntry(value: unknown): DeclaredSubscription | null {
  if (!isRecord(value)) return null;
  if (typeof value.server !== "string" || value.server.trim().length === 0) return null;
  if (typeof value.name !== "string" || value.name.trim().length === 0) return null;
  if (!isStableIdComponent(value.server) || !isStableIdComponent(value.name)) return null;
  const args = value.arguments === undefined ? {} : value.arguments;
  if (!isRecord(args)) return null;
  if (
    value.title !== undefined &&
    (typeof value.title !== "string" || value.title.trim().length === 0)
  ) {
    return null;
  }
  return {
    server: value.server,
    name: value.name,
    arguments: { ...args },
    ...(value.title === undefined ? {} : { title: value.title }),
  };
}

/** Membership only: no cursor, status, health or enabled flag ever leaves here. */
function serializeEntry(entry: DeclaredSubscription): DeclaredSubscription {
  return {
    server: entry.server,
    name: entry.name,
    arguments: entry.arguments,
    ...(entry.title === undefined ? {} : { title: entry.title }),
  };
}

function normalizeEntries(
  values: readonly unknown[],
  log: (line: string) => void = (line) => console.warn(line),
): DeclaredSubscription[] {
  const entries: DeclaredSubscription[] = [];
  const seen = new Set<string>();
  values.forEach((value, index) => {
    const entry = normalizeEntry(value);
    if (entry === null) {
      log(`mcp: subscriptions.json entry ${index} is invalid; skipped`);
      return;
    }
    let stableId: string;
    try {
      stableId = deriveStableId(entry.server, entry.name, entry.arguments);
    } catch {
      log(`mcp: subscriptions.json entry ${index} is invalid; skipped`);
      return;
    }
    if (seen.has(stableId)) {
      log(`mcp: subscriptions.json duplicate declaration ${stableId}; first wins`);
      return;
    }
    seen.add(stableId);
    entries.push(serializeEntry(entry));
  });
  return entries;
}

interface ParsedDocument {
  readonly document: MutableDocument;
  readonly entries: DeclaredSubscription[];
}

type ParseResult = { ok: true; value: ParsedDocument } | { ok: false; error: string };

function parseDocument(text: string, path: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, error: `${path} could not be parsed` };
  }
  if (!isRecord(parsed)) return { ok: false, error: `${path} must contain an object` };
  if (parsed.version !== MCP_SUBSCRIPTION_CONFIG_VERSION) {
    return {
      ok: false,
      error: `${path} has unsupported version ${String(parsed.version)}`,
    };
  }
  if (!Array.isArray(parsed.subscriptions)) {
    return { ok: false, error: `${path} subscriptions must be an array` };
  }
  return {
    ok: true,
    value: {
      document: { ...parsed, version: MCP_SUBSCRIPTION_CONFIG_VERSION } as MutableDocument,
      entries: normalizeEntries(parsed.subscriptions),
    },
  };
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Read the declarations. Never throws: a missing file is simply no streams,
 * while an unreadable or malformed file reports its error and no entries.
 */
export async function readSubscriptionConfig(agentDir?: string): Promise<SubscriptionConfig> {
  const path = subscriptionConfigPath(agentDir);
  let text: string | null;
  try {
    text = await readText(path);
  } catch (error) {
    return {
      path,
      present: true,
      entries: [],
      error: `${path} could not be read: ${String(error)}`,
    };
  }
  if (text === null) {
    clearParseWriteError(path);
    return { path, present: false, entries: [] };
  }
  const parsed = parseDocument(text, path);
  if (!parsed.ok) return { path, present: true, entries: [], error: parsed.error };
  clearParseWriteError(path);
  return { path, present: true, entries: parsed.value.entries };
}

/** A write refused because the file on disk did not parse. */
class ConfigParseError extends Error {}

interface WriteError {
  readonly message: string;
  /** A parse failure is stale as soon as a later read parses the file. */
  readonly parse: boolean;
}

/** One serialized intent queue, so two writes cannot interleave. */
let writeQueue: Promise<unknown> = Promise.resolve();
const lastWriteErrors = new Map<string, WriteError>();

function enqueueWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = writeQueue.then(task, task);
  writeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** The last failure for this config path, cleared by a successful write. */
export function subscriptionConfigWriteError(path: string): string | undefined {
  return lastWriteErrors.get(resolve(path))?.message;
}

/** A later read that parses the file retires only a stale parse refusal. */
function clearParseWriteError(path: string): void {
  if (lastWriteErrors.get(path)?.parse === true) lastWriteErrors.delete(path);
}

async function writeDocument(path: string, document: MutableDocument): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Re-read from disk, mutate only `subscriptions`, and skip a no-op write. */
async function mutateConfig(
  agentDir: string | undefined,
  mutate: (entries: DeclaredSubscription[], document: MutableDocument) => DeclaredSubscription[],
): Promise<boolean> {
  const path = subscriptionConfigPath(agentDir);
  return enqueueWrite(async () => {
    try {
      const text = await readText(path);
      let document: MutableDocument;
      if (text === null) {
        document = { version: MCP_SUBSCRIPTION_CONFIG_VERSION, subscriptions: [] };
      } else {
        const parsed = parseDocument(text, path);
        if (!parsed.ok) {
          // Never overwrite a file that does not parse: the operator may be
          // mid-edit, and losing a hand-written line is worse than a failed write.
          throw new ConfigParseError(parsed.error);
        }
        document = parsed.value.document;
      }
      const current = Array.isArray(document.subscriptions)
        ? normalizeEntries(document.subscriptions)
        : [];
      const next = normalizeEntries(mutate(current, document));
      const before = `${JSON.stringify({ ...document, subscriptions: current }, null, 2)}`;
      const afterDocument = { ...document, subscriptions: next };
      const after = `${JSON.stringify(afterDocument, null, 2)}`;
      if (before === after) {
        lastWriteErrors.delete(path);
        return false;
      }
      await writeDocument(path, afterDocument);
      lastWriteErrors.delete(path);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (lastWriteErrors.get(path)?.message !== message) {
        console.warn(`mcp: could not write ${path}: ${message}`);
      }
      lastWriteErrors.set(path, { message, parse: error instanceof ConfigParseError });
      return false;
    }
  });
}

/** Replace the whole membership list, preserving the rest of the document. */
export async function writeSubscriptionConfig(
  agentDir: string,
  entries: readonly DeclaredSubscription[],
): Promise<void> {
  await mutateConfig(agentDir, () => [...entries]);
}

/** Add or update one declaration by stable id. A no-op write is skipped. */
export async function upsertSubscriptionConfigEntry(
  agentDir: string | undefined,
  entry: DeclaredSubscription,
): Promise<boolean> {
  const stableId = deriveStableId(entry.server, entry.name, entry.arguments);
  return mutateConfig(agentDir, (entries) => {
    const next = [...entries];
    const index = next.findIndex(
      (item) => deriveStableId(item.server, item.name, item.arguments) === stableId,
    );
    const serialized = serializeEntry(entry);
    if (index === -1) {
      next.push(serialized);
    } else {
      // A re-subscribe from the adapter carries no title. The operator's
      // existing title is configuration, not runtime state: keep it.
      const existing = next[index];
      next[index] =
        serialized.title === undefined && existing?.title !== undefined
          ? { ...serialized, title: existing.title }
          : serialized;
    }
    return next;
  });
}

/** Remove one declaration by stable id. A no-op write is skipped. */
export async function removeSubscriptionConfigEntry(
  agentDir: string | undefined,
  stableId: string,
): Promise<boolean> {
  return mutateConfig(agentDir, (entries) =>
    entries.filter(
      (entry) => deriveStableId(entry.server, entry.name, entry.arguments) !== stableId,
    ),
  );
}

/** Remove by the declaration's own identity, for callers that hold the entry. */
export async function removeDeclaredSubscription(
  agentDir: string | undefined,
  entry: Pick<DeclaredSubscription, "server" | "name" | "arguments">,
): Promise<boolean> {
  return removeSubscriptionConfigEntry(
    agentDir,
    deriveStableId(entry.server, entry.name, entry.arguments),
  );
}
