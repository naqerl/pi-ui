import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MessageMode, QueuedMessage } from "../shared/types.js";

/**
 * Durable record of the turn that is currently in flight. It lives next to
 * `pi.sqlite3` and `current.json`, so a process that dies mid-run leaves enough
 * information behind to mark the transcript partial and resume the turn once.
 */
export interface RunMarker {
  readonly version: 1;
  /** The user message that started the run. */
  readonly userMessage: string;
  readonly startedAt: string;
  readonly mode: MessageMode;
  /** Set before an explicit stop so a restart never continues a stopped run. */
  readonly stopRequested: boolean;
  /** Stable key for restored queue request ids and the interrupted-run note. */
  readonly idempotencyKey: string;
  readonly queue: readonly QueuedMessage[];
  /** Last assistant entry when the marker was recovered, so the UI can label it partial. */
  readonly partialEntryId: number | null;
  readonly updatedAt: string;
}

export class RunMarkerStore {
  readonly path: string;

  constructor(dataDir: string, fileName = "run.json") {
    this.path = join(dataDir, fileName);
  }

  async read(): Promise<RunMarker | undefined> {
    let contents: string;
    try {
      contents = await readFile(this.path, "utf8");
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return undefined;
      throw error;
    }

    try {
      const value: unknown = JSON.parse(contents);
      if (isRunMarker(value)) return value;
    } catch {
      // Fall through and ignore the malformed marker.
    }
    console.warn(`[pi] ignoring malformed run marker ${this.path}`);
    return undefined;
  }

  async write(marker: RunMarker): Promise<void> {
    const temporary = `${this.path}.tmp-${process.pid}-${randomUUID()}`;
    await writeFile(temporary, `${JSON.stringify(marker)}\n`, "utf8");
    await rename(temporary, this.path);
  }

  async clear(): Promise<void> {
    try {
      await unlink(this.path);
    } catch (error) {
      if (isRecord(error) && error.code === "ENOENT") return;
      throw error;
    }
  }
}

function isRunMarker(value: unknown): value is RunMarker {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.userMessage === "string" &&
    typeof value.startedAt === "string" &&
    (value.mode === "queue" || value.mode === "steer") &&
    typeof value.stopRequested === "boolean" &&
    typeof value.idempotencyKey === "string" &&
    Array.isArray(value.queue) &&
    value.queue.every(isQueuedMessage) &&
    (value.partialEntryId === null ||
      (typeof value.partialEntryId === "number" && Number.isSafeInteger(value.partialEntryId))) &&
    typeof value.updatedAt === "string"
  );
}

function isQueuedMessage(value: unknown): value is QueuedMessage {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.text === "string" &&
    typeof value.createdAt === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
