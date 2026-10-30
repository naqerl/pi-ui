import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DIAGRAM_FORMAT, DIAGRAM_ID_PATTERN } from "../shared/diagrams.js";
import type { DiagramRef } from "../shared/types.js";

/** A diagram may be at most this much source, in UTF-8 bytes. */
export const MAX_DIAGRAM_BYTES = 20 * 1024;
/** Longest format name accepted on disk; an unknown one is shown as raw source by the client. */
const MAX_FORMAT_LENGTH = 40;

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const ID_BYTES = 7;
const ID_LENGTH = 10;

/** The file kept at `DATA_DIR/diagrams/<id>.json`. */
export interface Diagram {
  id: string;
  format: string;
  source: string;
  createdAt: string;
  updatedAt: string;
  /** Starts at 1 and increases on every replace. */
  revision: number;
}

export class DiagramError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 413,
  ) {
    super(message);
    this.name = "DiagramError";
  }
}

/** Crockford base32 in lowercase, truncated to a stable 10 characters. */
export function encodeDiagramId(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let id = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      id += ID_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) id += ID_ALPHABET[(value << (5 - bits)) & 31];
  return id.slice(0, ID_LENGTH);
}

/** A fresh id from the platform random source. */
export function newDiagramId(): string {
  return encodeDiagramId(randomBytes(ID_BYTES));
}

export function isDiagramId(id: string): boolean {
  return DIAGRAM_ID_PATTERN.test(id);
}

/** Trims nothing: source is kept exactly, but empty and oversized text is refused. */
export function validateDiagramSource(source: unknown): string {
  if (typeof source !== "string") {
    throw new DiagramError("Diagram source must be text", 400);
  }
  if (source.trim().length === 0) {
    throw new DiagramError("Diagram source is empty", 400);
  }
  if (Buffer.byteLength(source, "utf8") > MAX_DIAGRAM_BYTES) {
    throw new DiagramError(
      `A diagram can be at most ${MAX_DIAGRAM_BYTES / 1024} kB of source`,
      413,
    );
  }
  return source;
}

function validateFormat(format: unknown): string {
  if (typeof format !== "string" || format.trim().length === 0) {
    throw new DiagramError("Diagram format must be text", 400);
  }
  const value = format.trim().toLowerCase();
  if (value.length > MAX_FORMAT_LENGTH) {
    throw new DiagramError("Diagram format name is too long", 400);
  }
  return value;
}

function asDiagram(value: unknown): Diagram | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !isDiagramId(record.id)) return undefined;
  if (typeof record.format !== "string" || record.format.length === 0) return undefined;
  if (typeof record.source !== "string") return undefined;
  if (typeof record.createdAt !== "string" || typeof record.updatedAt !== "string")
    return undefined;
  if (
    typeof record.revision !== "number" ||
    !Number.isSafeInteger(record.revision) ||
    record.revision < 1
  ) {
    return undefined;
  }
  return {
    id: record.id,
    format: record.format,
    source: record.source,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    revision: record.revision,
  };
}

function clone(diagram: Diagram): Diagram {
  return { ...diagram };
}

/**
 * Diagram files at `DATA_DIR/diagrams/<id>.json`. An in-memory copy serves reads; every write
 * goes through a temp file and a rename, and a replace bumps the revision.
 */
export class DiagramStore {
  private readonly diagrams = new Map<string, Diagram>();
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {}

  async load(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error ? error.code : "";
      if (code === "ENOENT") return;
      console.error("[pi] diagrams could not be listed; starting without them", error);
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        const diagram = asDiagram(JSON.parse(await readFile(join(this.dir, name), "utf8")));
        if (diagram !== undefined && !this.diagrams.has(diagram.id)) {
          this.diagrams.set(diagram.id, diagram);
        }
      } catch (error) {
        console.warn(`[pi] could not read diagram ${name}: ${String(error)}`);
      }
    }
  }

  get(id: string): Diagram | undefined {
    if (!isDiagramId(id)) return undefined;
    const diagram = this.diagrams.get(id);
    return diagram === undefined ? undefined : clone(diagram);
  }

  /** The current `{id, revision}` for a diagram, for a transcript part. */
  ref(id: string): DiagramRef | undefined {
    const diagram = this.get(id);
    return diagram === undefined ? undefined : { id: diagram.id, revision: diagram.revision };
  }

  async create(source: unknown, format: unknown = DIAGRAM_FORMAT): Promise<Diagram> {
    const text = validateDiagramSource(source);
    const value = validateFormat(format);
    return this.commit(() => {
      let id = newDiagramId();
      while (this.diagrams.has(id)) id = newDiagramId();
      const now = new Date().toISOString();
      return {
        id,
        format: value,
        source: text,
        createdAt: now,
        updatedAt: now,
        revision: 1,
      };
    });
  }

  async replace(id: string, source: unknown, format?: unknown): Promise<Diagram> {
    const text = validateDiagramSource(source);
    const value = format === undefined ? undefined : validateFormat(format);
    return this.commit(() => {
      const current = this.get(id);
      if (current === undefined) throw new DiagramError(`Unknown diagram: ${id}`, 404);
      return {
        ...current,
        source: text,
        ...(value === undefined ? {} : { format: value }),
        updatedAt: new Date().toISOString(),
        revision: current.revision + 1,
      };
    });
  }

  /** Serialises writes so two replaces cannot both read the same revision. */
  private commit(change: () => Diagram): Promise<Diagram> {
    const run = this.chain.then(async () => {
      const before = new Map(this.diagrams);
      const next = change();
      this.diagrams.set(next.id, next);
      try {
        await this.save(next);
      } catch (error) {
        this.diagrams.clear();
        for (const [key, value] of before) this.diagrams.set(key, value);
        throw error;
      }
      return clone(next);
    });
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async save(diagram: Diagram): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const path = join(this.dir, `${diagram.id}.json`);
    const temporary = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(diagram)}\n`, "utf8");
    await rename(temporary, path);
  }
}
