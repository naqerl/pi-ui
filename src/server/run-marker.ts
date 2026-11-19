import { randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MessageMode, QueuedMessage } from "../shared/types.js";

export interface RunMarker {
  readonly version: 1;

  readonly userMessage: string;
  readonly startedAt: string;
  readonly mode: MessageMode;

  readonly stopRequested: boolean;

  readonly idempotencyKey: string;
  readonly queue: readonly QueuedMessage[];

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
    } catch {}
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
