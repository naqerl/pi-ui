import { existsSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { apply } from "@earendil-works/chord/delta";

/**
 * pi-durable 1.5 materialises a document by applying every delta after its newest base directly to the
 * parsed base value. A delta that was replayed onto a base which already contains it can therefore
 * corrupt the materialised view even though every stored revision row is valid JSON. The doctor reads
 * that same table, materialises idempotently, validates the document shape, and can append a clean base
 * revision that pins the repaired value. It deliberately works against the SQLite table instead of
 * editing the package in node_modules.
 */

export const DURABLE_DOCUMENT_KINDS = ["pi.live", "pi.agent", "pi.inbox"] as const;
export type DurableDocumentKind = (typeof DURABLE_DOCUMENT_KINDS)[number];

export interface DoctorRevision {
  readonly seq: number;
  readonly kind: "base" | "delta";
  readonly version: number;
  readonly content: string;
}

export interface MaterializedDurableDocument {
  readonly value: unknown;
  readonly baseRevision: number;
  readonly version: number;
  readonly torn: boolean;
  readonly reason?: string;
  readonly droppedDeltas: number;
  readonly skippedDeltas: number;
  readonly residueDropped: readonly string[];
}

export interface DurableDocumentReport {
  readonly kind: DurableDocumentKind;
  readonly documentId: number;
  readonly conversationId?: number;
  readonly status: "ok" | "torn";
  readonly baseRevision: number;
  readonly droppedDeltas: number;
  readonly skippedDeltas: number;
  readonly residueDropped: readonly string[];
  readonly repaired: boolean;
  readonly revisionWritten?: number;
  readonly reason?: string;
}

export interface DurableDoctorReport {
  readonly databasePath: string;
  readonly documentCount: number;
  readonly documents: readonly DurableDocumentReport[];
  readonly torn: boolean;
  readonly repaired: boolean;
  readonly backupPath?: string;
  readonly lines: readonly string[];
}

export interface DurableDoctorOptions {
  /** Explicit database file. Otherwise `<DATA_DIR>/pi.sqlite3`, or `<cwd>/data/pi.sqlite3`. */
  readonly databasePath?: string;
  /** Repair torn documents (after taking a backup). Defaults to false, i.e. a dry run. */
  readonly repair?: boolean;
  /** Only inspect these document kinds. */
  readonly kinds?: readonly DurableDocumentKind[];
  /** Only inspect one document id (the current conversation's document, for example). */
  readonly documentId?: number;
}

interface RevisionRow {
  seq: number;
  kind: string;
  version: number;
  content: string;
}

interface DocumentRow {
  id: number;
  kind: string;
  owner_id: number;
  record: string;
}

interface MaterializeOutcome extends MaterializedDurableDocument {
  readonly repairedValue: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length && left.every((item, index) => jsonEqual(item, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.hasOwn(right, key) && jsonEqual(left[key], right[key]))
    );
  }
  return false;
}

function cloneJson<T>(value: T): T {
  return structuredClone(value);
}

function safePath(path: unknown): path is readonly (string | number)[] {
  return (
    Array.isArray(path) &&
    path.every(
      (segment) =>
        (typeof segment === "string" &&
          segment !== "__proto__" &&
          segment !== "constructor" &&
          segment !== "prototype") ||
        (Number.isInteger(segment) && (segment as number) >= 0),
    )
  );
}

function readAt(root: unknown, path: readonly (string | number)[]): unknown {
  let node = root;
  for (const segment of path) {
    if (Array.isArray(node)) {
      if (typeof segment !== "number" || !Number.isInteger(segment)) return undefined;
    } else if (!isRecord(node)) {
      return undefined;
    }
    if (!Object.hasOwn(node as object, segment)) return undefined;
    node = (node as Record<string | number, unknown>)[segment];
  }
  return node;
}

function writeAt(root: unknown, path: readonly (string | number)[], value: unknown): boolean {
  const parent = readAt(root, path.slice(0, -1));
  const key = path.at(-1);
  if (key === undefined) return false;
  if (Array.isArray(parent)) {
    if (typeof key !== "number" || !Number.isInteger(key)) return false;
    if (key > parent.length) return false;
    parent[key] = value;
    return true;
  }
  if (!isRecord(parent)) return false;
  if (typeof key !== "string") return false;
  Object.defineProperty(parent, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return true;
}

function deleteAt(root: unknown, path: readonly (string | number)[]): boolean {
  const parent = readAt(root, path.slice(0, -1));
  const key = path.at(-1);
  if (key === undefined) return false;
  if (Array.isArray(parent)) {
    if (typeof key !== "number" || !Number.isInteger(key) || key >= parent.length) return false;
    parent.splice(key, 1);
    return true;
  }
  if (!isRecord(parent) || typeof key !== "string" || !Object.hasOwn(parent, key)) return false;
  delete parent[key];
  return true;
}

function itemIdentity(item: unknown): string | undefined {
  if (!isRecord(item)) return undefined;
  for (const key of ["callId", "id", "key"] as const) {
    const value = item[key];
    if (typeof value === "string" && value.length > 0) return `${key}:${value}`;
    if (typeof value === "number" && Number.isFinite(value)) return `${key}:${value}`;
  }
  return undefined;
}

/**
 * Insert at a splice position, updating an existing element with the same identity instead of
 * duplicating it. Chord's tracker writes an append as `["p", path, 0, 0, [item]]`, so the
 * position alone cannot distinguish an append from a prepend.
 */
function mergeAppend(target: unknown[], index: number, items: readonly unknown[]): void {
  const existing = new Map<string, number>();
  target.forEach((item, at) => {
    const id = itemIdentity(item);
    if (id !== undefined && !existing.has(id)) existing.set(id, at);
  });
  const inserted: unknown[] = [];
  const insertedIds = new Map<string, number>();
  for (const item of items) {
    const id = itemIdentity(item);
    const at = id === undefined ? undefined : existing.get(id);
    if (at !== undefined) {
      if (!jsonEqual(target[at], item)) target[at] = cloneJson(item);
      continue;
    }
    const pending = id === undefined ? undefined : insertedIds.get(id);
    if (pending !== undefined) {
      if (!jsonEqual(inserted[pending], item)) inserted[pending] = cloneJson(item);
      continue;
    }
    inserted.push(cloneJson(item));
    if (id !== undefined) insertedIds.set(id, inserted.length - 1);
  }
  if (inserted.length > 0) target.splice(Math.min(index, target.length), 0, ...inserted);
}

/**
 * Apply one decoded delta batch, treating value replacement and duplicate appends as no-ops.
 * This is the small, self-contained subset of Chord's op grammar that durable stores.
 */
function applyOpsIdempotent(root: unknown, ops: readonly unknown[]): unknown {
  let value = root;
  for (const raw of ops) {
    if (!Array.isArray(raw) || raw.length === 0) throw new TypeError("invalid delta op");
    const [verb, path, arg] = raw;
    if (verb === "r") {
      if (raw.length !== 2) throw new TypeError("invalid replace op");
      if (!jsonEqual(value, path)) value = cloneJson(path);
      continue;
    }
    if (!safePath(path)) throw new TypeError("invalid delta path");
    if (verb === "p") {
      if (raw.length !== 5 || typeof path === "undefined") throw new TypeError("invalid splice op");
      const index = raw[2];
      const remove = raw[3];
      const items = raw[4];
      if (!Number.isInteger(index) || !Number.isInteger(remove) || !Array.isArray(items)) {
        throw new TypeError("invalid splice op");
      }
      const target = path.length === 0 ? value : readAt(value, path);
      if (!Array.isArray(target)) {
        if (remove === 0 && items.length === 0) continue;
        throw new TypeError("splice target is not an array");
      }
      if (remove === 0 && items.length > 0) {
        if (jsonEqual(target.slice(index, index + items.length), items)) continue;
        mergeAppend(target, index, items);
        continue;
      }
      target.splice(index, remove, ...items.map((item) => cloneJson(item)));
      continue;
    }
    if (verb === "m") {
      if (raw.length !== 3 || !Array.isArray(arg)) throw new TypeError("invalid move op");
      const target = path.length === 0 ? value : readAt(value, path);
      if (!Array.isArray(target) || target.length !== arg.length) {
        throw new TypeError("move target does not match the permutation");
      }
      if (arg.every((entry, index) => entry === index)) continue;
      const previous = [...target];
      arg.forEach((source, index) => {
        if (typeof source !== "number" || !Number.isInteger(source)) {
          throw new TypeError("invalid move permutation");
        }
        target[index] = previous[source];
      });
      continue;
    }
    if (verb === "s") {
      if (raw.length !== 3) throw new TypeError("invalid set op");
      const current = readAt(value, path);
      if (jsonEqual(current, arg)) continue;
      if (!writeAt(value, path, cloneJson(arg))) throw new TypeError("unresolvable set path");
      continue;
    }
    if (verb === "d") {
      if (raw.length !== 2) throw new TypeError("invalid delete op");
      deleteAt(value, path);
      continue;
    }
    if (verb === "a") {
      if (raw.length !== 3 || typeof arg !== "string") throw new TypeError("invalid append op");
      const current = readAt(value, path);
      if (typeof current !== "string") throw new TypeError("append target is not text");
      if (!writeAt(value, path, `${current}${arg}`))
        throw new TypeError("unresolvable append path");
      continue;
    }
    if (verb === "t") {
      if (raw.length !== 3 || typeof arg !== "number" || !Number.isInteger(arg) || arg < 0) {
        throw new TypeError("invalid truncate op");
      }
      const current = readAt(value, path);
      if (typeof current !== "string") throw new TypeError("truncate target is not text");
      if (!writeAt(value, path, current.slice(arg)))
        throw new TypeError("unresolvable truncate path");
      continue;
    }
    throw new TypeError(`unknown delta op ${String(verb)}`);
  }
  return value;
}

function deltaOps(content: unknown): readonly unknown[] | undefined {
  if (Array.isArray(content)) return content;
  if (!isRecord(content)) return undefined;
  if (Array.isArray(content.ops)) return content.ops;
  return undefined;
}

function deltaSnapshot(content: unknown): { value: unknown; seq?: number } | undefined {
  if (!isRecord(content)) return undefined;
  const seq =
    typeof content.seq === "number" && Number.isSafeInteger(content.seq)
      ? content.seq
      : typeof content.revision === "number" && Number.isSafeInteger(content.revision)
        ? content.revision
        : typeof content.revisionId === "number" && Number.isSafeInteger(content.revisionId)
          ? content.revisionId
          : undefined;
  if (Object.hasOwn(content, "value"))
    return { value: content.value, ...(seq === undefined ? {} : { seq }) };
  if (content.kind === "base" && Object.hasOwn(content, "content")) {
    return { value: content.content, ...(seq === undefined ? {} : { seq }) };
  }
  return undefined;
}

function slotKey(slot: Record<string, unknown>, index: number): string {
  const id = slot.callId ?? slot.id;
  return typeof id === "string" || typeof id === "number" ? String(id) : `#${index}`;
}

/**
 * The authored shape rule says a terminal slot needs a result id. pi-durable's ToolSlot contract
 * documents `entry` as absent when a tool task faulted or was orphaned, so rejecting `done`
 * without an entry would reject a valid base and discard newer deltas. That is the deliberate
 * exception here. Pending/running slots without a result are residue; a repaired base marks them
 * interrupted instead of deleting the call.
 */
function validateLive(value: unknown): string | undefined {
  if (!isRecord(value)) return "document is not an object";
  const checkSlots = (name: "tools" | "nestedTools"): string | undefined => {
    const slots = value[name];
    if (slots === undefined) return undefined;
    if (!Array.isArray(slots)) return `${name} is not an array`;
    const seen = new Set<string>();
    for (let index = 0; index < slots.length; index++) {
      const slot = slots[index];
      if (!isRecord(slot)) return `${name}[${index}] is not an object`;
      if (typeof slot.callId !== "string" || slot.callId.length === 0) {
        return `${name}[${index}] has no callId`;
      }
      const key = `${name}:${slot.callId}`;
      if (seen.has(key)) return `duplicate ${name} callId ${slot.callId}`;
      seen.add(key);
      if (slot.status !== undefined && typeof slot.status !== "string") {
        return `${name}[${index}] has an invalid status`;
      }
      // pi-durable intentionally leaves `entry` absent when a tool task faulted or was
      // orphaned, and `summary` absent for the same nested outcomes. Those are valid.
    }
    return undefined;
  };
  return checkSlots("tools") ?? checkSlots("nestedTools");
}

function validateAgent(value: unknown): string | undefined {
  if (!isRecord(value)) return "document is not an object";
  for (const name of ["tools", "modelTools"] as const) {
    const list = value[name];
    if (list === undefined || Array.isArray(list)) continue;
    if (isRecord(list) && (Array.isArray(list.add) || Array.isArray(list.remove))) continue;
    return `${name} has an invalid shape`;
  }
  const maxTurns = value.maxTurns;
  if (
    maxTurns !== undefined &&
    (typeof maxTurns !== "number" || !Number.isInteger(maxTurns) || maxTurns < 1)
  ) {
    return "maxTurns is not a positive integer";
  }
  return undefined;
}

function validateInbox(value: unknown): string | undefined {
  if (!isRecord(value)) return "document is not an object";
  const items = value.items;
  if (!Array.isArray(items)) return "items is not an array";
  const seen = new Set<string>();
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (!isRecord(item)) return `items[${index}] is not an object`;
    if (item.id === undefined) continue;
    const key = String(item.id);
    if (seen.has(key)) return `duplicate inbox item id ${key}`;
    seen.add(key);
  }
  return undefined;
}

function validateDocument(kind: DurableDocumentKind, value: unknown): string | undefined {
  switch (kind) {
    case "pi.live":
      return validateLive(value);
    case "pi.agent":
      return validateAgent(value);
    case "pi.inbox":
      return validateInbox(value);
  }
}

function markResidueInterrupted(value: unknown): { value: unknown; dropped: string[] } {
  const repaired = cloneJson(value);
  if (!isRecord(repaired)) return { value: repaired, dropped: [] };
  const dropped: string[] = [];
  for (const name of ["tools", "nestedTools"] as const) {
    const slots = repaired[name];
    if (!Array.isArray(slots)) continue;
    for (let index = 0; index < slots.length; index++) {
      const slot = slots[index];
      if (!isRecord(slot)) continue;
      if (slot.status !== "pending" && slot.status !== "running") continue;
      const hasResult = name === "tools" ? slot.entry !== undefined : slot.summary !== undefined;
      if (hasResult) continue;
      slot.status = "interrupted";
      slot.interrupted = true;
      dropped.push(typeof slot.callId === "string" ? slot.callId : slotKey(slot, index));
    }
  }
  return { value: repaired, dropped };
}

function parseRevisionContent(content: string): unknown {
  return JSON.parse(content) as unknown;
}

/**
 * Materialise one document from its stored revisions. The newest base is preferred; if applying its
 * trailing deltas fails (or the result fails shape validation), the newest base that validates is used
 * and every trailing delta is dropped. A delta whose exact content already appeared after the base is
 * skipped, so replaying the same revision is a no-op.
 */
export function materializeStoredDocument(
  kind: DurableDocumentKind,
  revisions: readonly DoctorRevision[],
): MaterializeOutcome {
  const ordered = [...revisions].sort((left, right) => left.seq - right.seq);
  const bases = ordered.filter((revision) => revision.kind === "base");
  if (bases.length === 0) {
    return {
      value: undefined,
      repairedValue: undefined,
      baseRevision: 0,
      version: 0,
      torn: true,
      reason: "no base revision",
      droppedDeltas: ordered.length,
      skippedDeltas: 0,
      residueDropped: [],
    };
  }

  let fallbackReason: string | undefined;
  for (let baseIndex = bases.length - 1; baseIndex >= 0; baseIndex--) {
    const base = bases[baseIndex];
    if (base === undefined) continue;
    let parsedBase: unknown;
    try {
      parsedBase = parseRevisionContent(base.content);
    } catch (error) {
      fallbackReason = `base revision ${base.seq} is not JSON: ${errorMessage(error)}`;
      continue;
    }
    const baseProblem = validateDocument(kind, parsedBase);
    if (baseProblem !== undefined) {
      fallbackReason = `base revision ${base.seq} is ${baseProblem}`;
      continue;
    }

    const isNewestBase = baseIndex === bases.length - 1;
    const tail = ordered.filter((revision) => revision.seq > base.seq && revision.kind === "delta");
    if (!isNewestBase) {
      const residue = markResidueInterrupted(parsedBase);
      return {
        value: residue.value,
        repairedValue: residue.value,
        baseRevision: base.seq,
        version: base.version,
        torn: true,
        reason: fallbackReason ?? "fell back to an older base revision",
        droppedDeltas: ordered.filter((revision) => revision.seq > base.seq).length,
        skippedDeltas: 0,
        residueDropped: residue.dropped,
      };
    }

    let value = cloneJson(parsedBase);
    // The package view is what the next resume would read. Track it with the package's strict
    // applier, so a deduplication that changes the value is detected instead of hidden.
    let packageValue = cloneJson(parsedBase);
    const seenDestructive = new Set<string>();
    let destructiveReplay = false;
    let skippedDeltas = 0;
    let droppedDeltas = 0;
    let failure: string | undefined;
    for (let index = 0; index < tail.length; index++) {
      const revision = tail[index];
      if (revision === undefined) continue;
      if (revision.version !== base.version) {
        failure = `revision ${revision.seq} crosses a version boundary without a base`;
        droppedDeltas = tail.length;
        break;
      }
      let content: unknown;
      try {
        content = parseRevisionContent(revision.content);
      } catch (error) {
        failure = `revision ${revision.seq} is not JSON: ${errorMessage(error)}`;
        droppedDeltas = tail.length;
        break;
      }
      const snapshot = deltaSnapshot(content);
      if (snapshot?.seq !== undefined && snapshot.seq <= base.seq) {
        skippedDeltas++;
        continue;
      }
      const before = cloneJson(value);
      try {
        if (snapshot !== undefined) {
          value = cloneJson(snapshot.value);
          packageValue = cloneJson(snapshot.value);
        } else {
          const ops = deltaOps(content);
          if (ops === undefined) throw new TypeError("delta content is neither ops nor a value");
          const destructive = ops.some(
            (op) =>
              Array.isArray(op) &&
              (op[0] === "d" || (op[0] === "p" && Number.isInteger(op[3]) && Number(op[3]) > 0)),
          );
          const fingerprint = destructive ? JSON.stringify(content) : undefined;
          if (fingerprint !== undefined && seenDestructive.has(fingerprint)) {
            // A splice removal replayed twice would remove another item (or throw). Keep both
            // replays at the first application and force a clean base below.
            destructiveReplay = true;
            skippedDeltas++;
          } else {
            if (fingerprint !== undefined) seenDestructive.add(fingerprint);
            packageValue = apply(packageValue, ops as never) as unknown;
            value = applyOpsIdempotent(value, ops);
          }
        }
      } catch (error) {
        failure = `revision ${revision.seq} could not be applied: ${errorMessage(error)}`;
        droppedDeltas = tail.length;
        break;
      }
      // A replayed state-setting delta (the observed pending -> running duplicate) is a no-op.
      // Text appends that genuinely repeat a chunk still change the value and are applied.
      if (jsonEqual(before, value)) skippedDeltas++;
    }
    if (failure === undefined) {
      const doctorProblem = validateDocument(kind, value);
      if (doctorProblem !== undefined) {
        failure = `the deduplicated document is ${doctorProblem}`;
        droppedDeltas = tail.length;
      } else {
        const packageProblem = validateDocument(kind, packageValue);
        const diverged = !jsonEqual(packageValue, value);
        if (packageProblem !== undefined || diverged || destructiveReplay) {
          const reason = destructiveReplay
            ? "a destructive delta was replayed"
            : packageProblem === undefined
              ? "deduplication changed the package's materialised value"
              : `duplicate replay produced ${packageProblem} in the package view`;
          const residue = markResidueInterrupted(value);
          return {
            value: residue.value,
            repairedValue: residue.value,
            baseRevision: base.seq,
            version: base.version,
            torn: true,
            reason,
            droppedDeltas: 0,
            skippedDeltas,
            residueDropped: residue.dropped,
          };
        }
        return {
          value,
          repairedValue: value,
          baseRevision: base.seq,
          version: base.version,
          torn: false,
          droppedDeltas: 0,
          skippedDeltas,
          residueDropped: [],
        };
      }
    }

    // The newest base itself validates: use it exactly as stored, dropping the trailing deltas.
    const residue = markResidueInterrupted(parsedBase);
    return {
      value: residue.value,
      repairedValue: residue.value,
      baseRevision: base.seq,
      version: base.version,
      torn: true,
      reason: failure,
      droppedDeltas,
      skippedDeltas,
      residueDropped: residue.dropped,
    };
  }

  return {
    value: undefined,
    repairedValue: undefined,
    baseRevision: 0,
    version: 0,
    torn: true,
    reason: fallbackReason ?? "no base revision validates",
    droppedDeltas: ordered.length,
    skippedDeltas: 0,
    residueDropped: [],
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultDatabasePath(): string {
  const dataDir = process.env.DATA_DIR?.trim() || "data";
  return resolve(process.cwd(), dataDir, "pi.sqlite3");
}

function conversationIdOf(row: DocumentRow): number | undefined {
  try {
    const record = JSON.parse(row.record) as unknown;
    if (isRecord(record) && isRecord(record.scope)) {
      const id = record.scope.conversationId;
      if (typeof id === "number" && Number.isSafeInteger(id)) return id;
    }
  } catch {
    // Keep the owner column as the fallback.
  }
  return Number.isSafeInteger(row.owner_id) ? row.owner_id : undefined;
}

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?")
    .get(table) as { name?: string } | undefined;
  return row?.name !== undefined;
}

/** pi-durable stores indexed strings JSON-encoded; older test rows may use the plain form. */
function decodeIndexedString(value: string): string {
  if (!value.startsWith('"')) return value;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "string" ? parsed : value;
  } catch {
    return value;
  }
}

function readDocumentRows(
  db: DatabaseSync,
  kinds: readonly DurableDocumentKind[],
  documentId: number | undefined,
): DocumentRow[] {
  if (!tableExists(db, "documents") || !tableExists(db, "document_revisions")) return [];
  const storedKinds = kinds.flatMap((kind) => [kind, JSON.stringify(kind)]);
  const placeholders = storedKinds.map(() => "?").join(", ");
  const clauses = [`kind IN (${placeholders})`, "retired_at IS NULL"];
  const params: (string | number)[] = [...storedKinds];
  if (documentId !== undefined) {
    clauses.push("id = ?");
    params.push(documentId);
  }
  const rows = db
    .prepare(
      `SELECT id, kind, owner_id, record FROM documents WHERE ${clauses.join(" AND ")} ORDER BY id`,
    )
    .all(...params) as unknown as DocumentRow[];
  return rows.flatMap((row) => {
    const kind = decodeIndexedString(String(row.kind));
    return kinds.includes(kind as DurableDocumentKind) ? [{ ...row, kind }] : [];
  });
}

function readRevisions(db: DatabaseSync, documentId: number): DoctorRevision[] {
  const rows = db
    .prepare(
      "SELECT seq, kind, version, content FROM document_revisions WHERE document_id = ? ORDER BY seq",
    )
    .all(documentId) as unknown as RevisionRow[];
  return rows.map((row) => ({
    seq: Number(row.seq),
    kind: row.kind === "base" ? "base" : "delta",
    version: Number(row.version),
    content: String(row.content),
  }));
}

function nextSequence(db: DatabaseSync, fallback: number): number {
  if (!tableExists(db, "durable_metadata")) return fallback;
  const row = db.prepare("SELECT next_seq FROM durable_metadata WHERE singleton = 1").get() as
    | { next_seq?: number | string }
    | undefined;
  const value = Number(row?.next_seq);
  return Number.isSafeInteger(value) && value > 0 ? Math.max(value, fallback) : fallback;
}

function writeRepairs(
  db: DatabaseSync,
  repairs: readonly {
    documentId: number;
    kind: DurableDocumentKind;
    version: number;
    value: unknown;
    record: DocumentRow;
    scannedSeq: number;
  }[],
): Map<number, number> {
  const written = new Map<number, number>();
  if (!tableExists(db, "document_revisions")) return written;
  db.exec("BEGIN IMMEDIATE");
  try {
    const maxRow = db.prepare("SELECT MAX(seq) AS seq FROM document_revisions").get() as
      | { seq?: number | null }
      | undefined;
    let seq = nextSequence(db, Number(maxRow?.seq ?? 0) + 1);
    for (const repair of repairs) {
      // A live commit may land between the scan and this transaction. Never supersede it with a
      // base built from an older revision; the next rescue will see and repair the newer state.
      const current = db
        .prepare("SELECT MAX(seq) AS seq FROM document_revisions WHERE document_id = ?")
        .get(repair.documentId) as { seq?: number | null } | undefined;
      if (Number(current?.seq ?? 0) !== repair.scannedSeq) continue;
      const content = JSON.stringify(repair.value);
      db.prepare(
        "INSERT INTO document_revisions (document_id, seq, kind, version, content) VALUES (?, ?, 'base', ?, ?)",
      ).run(repair.documentId, seq, repair.version, content);
      written.set(repair.documentId, seq);
      seq++;
    }
    if (tableExists(db, "durable_metadata")) {
      db.prepare("UPDATE durable_metadata SET next_seq = ? WHERE singleton = 1").run(seq);
    }
    // Newer store records carry the document revision; keep it ahead of the base we appended.
    for (const repair of repairs) {
      let record: unknown;
      try {
        record = JSON.parse(repair.record.record);
      } catch {
        continue;
      }
      if (!isRecord(record) || typeof record.revision !== "number") continue;
      const revision = written.get(repair.documentId);
      if (revision === undefined) continue;
      record.revision = Math.max(record.revision, revision);
      if (typeof record.version === "number") record.version = repair.version;
      try {
        db.prepare("UPDATE documents SET record = ? WHERE id = ?").run(
          JSON.stringify(record),
          repair.documentId,
        );
      } catch {
        // A store that exposes `documents` as a view derives the record; the appended base is enough.
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original failure.
    }
    throw error;
  }
  return written;
}

function backupPathFor(databasePath: string): string {
  return `${databasePath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

async function backupDatabase(databasePath: string): Promise<string> {
  const backupPath = backupPathFor(databasePath);
  await copyFile(databasePath, backupPath);
  return backupPath;
}

function reportLine(report: DurableDocumentReport): string {
  const where =
    report.conversationId === undefined
      ? `${report.kind} (document ${report.documentId})`
      : `${report.kind} (conversation ${report.conversationId})`;
  if (report.status === "ok") return `${where}: ok (base revision ${report.baseRevision})`;
  const parts = [`${where}: torn`];
  parts.push(`base revision ${report.baseRevision}`);
  if (report.droppedDeltas > 0) {
    parts.push(`dropped ${report.droppedDeltas} delta${report.droppedDeltas === 1 ? "" : "s"}`);
  }
  if (report.skippedDeltas > 0) {
    parts.push(
      `skipped ${report.skippedDeltas} duplicate delta${report.skippedDeltas === 1 ? "" : "s"}`,
    );
  }
  if (report.residueDropped.length > 0) {
    parts.push(
      `${report.residueDropped.length} pending tool call${report.residueDropped.length === 1 ? "" : "s"} marked interrupted`,
    );
  }
  if (report.reason !== undefined) parts.push(report.reason);
  if (report.repaired) {
    parts.push(
      report.revisionWritten === undefined
        ? "repaired"
        : `repaired at revision ${report.revisionWritten}`,
    );
  }
  return parts.join(" — ");
}

/** The one-line description a caller can put in the chat for the first repaired document. */
export function durableRepairNotice(
  report: DurableDoctorReport,
  conversationId?: number,
): string | undefined {
  const repairedFor = (kind: DurableDocumentKind) =>
    report.documents.find(
      (document) =>
        document.repaired &&
        document.status === "torn" &&
        document.kind === kind &&
        (conversationId === undefined || document.conversationId === conversationId),
    );
  // The live document is what the chat reads first; prefer it when several documents were repaired.
  const repaired = repairedFor("pi.live") ?? repairedFor("pi.agent") ?? repairedFor("pi.inbox");
  if (repaired === undefined) return undefined;
  const label =
    repaired.kind === "pi.live"
      ? "live state"
      : repaired.kind === "pi.agent"
        ? "agent state"
        : "inbox state";
  const residue = repaired.residueDropped.length;
  const dropped =
    residue === 0 ? "" : ` — dropped ${residue} pending tool call${residue === 1 ? "" : "s"}`;
  return `repaired ${label} from revision ${repaired.baseRevision}${dropped}`;
}

/**
 * Inspect (and optionally repair) the durable documents in a pi-ui SQLite store. The report is safe to
 * print: it contains revision numbers and reasons, never the document values.
 */
export async function durableDoctor(
  options: DurableDoctorOptions = {},
): Promise<DurableDoctorReport> {
  const databasePath = resolve(options.databasePath ?? defaultDatabasePath());
  if (!existsSync(databasePath)) {
    return {
      databasePath,
      documentCount: 0,
      documents: [],
      torn: false,
      repaired: false,
      lines: [`${databasePath}: database not found`],
    };
  }
  const kinds = options.kinds ?? DURABLE_DOCUMENT_KINDS;
  let db = new DatabaseSync(databasePath, { timeout: 5_000 });
  let documents: DurableDocumentReport[] = [];
  const repairs: {
    documentId: number;
    kind: DurableDocumentKind;
    version: number;
    value: unknown;
    record: DocumentRow;
    scannedSeq: number;
  }[] = [];
  try {
    const rows = readDocumentRows(db, kinds, options.documentId);
    for (const row of rows) {
      const kind = row.kind as DurableDocumentKind;
      if (!DURABLE_DOCUMENT_KINDS.includes(kind)) continue;
      const revisions = readRevisions(db, Number(row.id));
      const materialized = materializeStoredDocument(kind, revisions);
      const base: DurableDocumentReport = {
        kind,
        documentId: Number(row.id),
        ...(conversationIdOf(row) === undefined ? {} : { conversationId: conversationIdOf(row) }),
        status: materialized.torn ? "torn" : "ok",
        baseRevision: materialized.baseRevision,
        droppedDeltas: materialized.droppedDeltas,
        skippedDeltas: materialized.skippedDeltas,
        residueDropped: materialized.residueDropped,
        repaired: false,
        ...(materialized.reason === undefined ? {} : { reason: materialized.reason }),
      };
      documents.push(base);
      if (materialized.torn && materialized.repairedValue !== undefined) {
        repairs.push({
          documentId: Number(row.id),
          kind,
          version: materialized.version,
          value: materialized.repairedValue,
          record: row,
          scannedSeq: revisions.at(-1)?.seq ?? 0,
        });
      }
    }
  } finally {
    // WAL content must be in the main file before it is copied as the backup.
    try {
      db.exec("PRAGMA wal_checkpoint(FULL)");
    } catch {
      // A reader may hold the file; the backup still names the main database.
    }
    db.close();
  }

  let backupPath: string | undefined;
  if (options.repair === true && repairs.length > 0) {
    backupPath = await backupDatabase(databasePath);
    db = new DatabaseSync(databasePath, { timeout: 5_000 });
    try {
      const written = writeRepairs(db, repairs);
      documents = documents.map((document) => {
        const revisionWritten = written.get(document.documentId);
        return revisionWritten === undefined
          ? document
          : { ...document, repaired: true, revisionWritten };
      });
    } finally {
      db.close();
    }
  }

  const lines = documents.map(reportLine);
  if (backupPath !== undefined) lines.push(`backup: ${backupPath}`);
  return {
    databasePath,
    documentCount: documents.length,
    documents,
    torn: documents.some((document) => document.status === "torn"),
    repaired: documents.some((document) => document.repaired),
    ...(backupPath === undefined ? {} : { backupPath }),
    lines,
  };
}

export function formatDoctorReport(report: DurableDoctorReport): string {
  return report.lines.join("\n");
}
