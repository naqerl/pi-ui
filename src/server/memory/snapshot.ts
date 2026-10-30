import { type MemoryStore, todayIso } from "./store.js";

export const INDEX_CAP = 1800;
export const TODAY_CAP = 1200;
export const SCRATCHPAD_CAP = 600;
export const SNAPSHOT_CAP = 4000;

export type SnapshotReason =
  | "first_turn"
  | "day_rollover"
  | "long_term_write"
  | "compaction"
  | (string & {});

const TRUNCATION_MARKER = "\n... (truncated) ...\n";

/** Keep both ends: the standing rules at the top and the newest map lines at the bottom. */
export function middleTruncate(text: string, cap: number): string {
  if (cap <= 0) return "";
  if (text.length <= cap) return text;
  if (cap <= TRUNCATION_MARKER.length) return text.slice(0, cap);
  const room = cap - TRUNCATION_MARKER.length;
  const head = Math.ceil(room * 0.55);
  const tail = room - head;
  return `${text.slice(0, head)}${TRUNCATION_MARKER}${text.slice(text.length - tail)}`;
}

/** Keep the newest bytes of a journal or scratchpad. */
export function tailTruncate(text: string, cap: number): string {
  if (cap <= 0) return "";
  if (text.length <= cap) return text;
  const marker = "... (truncated) ...\n";
  if (cap <= marker.length) return text.slice(text.length - cap);
  return `${marker}${text.slice(text.length - (cap - marker.length))}`;
}

function block(label: string, content: string): string {
  return content.trim().length === 0 ? "" : `## ${label}\n${content.trim()}`;
}

export async function buildSnapshot(store: MemoryStore, reason: SnapshotReason): Promise<string> {
  let memory = "";
  try {
    memory = await store.readMemory();
  } catch (error) {
    if (
      !(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
    ) {
      throw error;
    }
  }
  const today = await store.readDaily(todayIso());
  const scratchpad = (await store.openScratchpadItems()).map((item) => `- [ ] ${item}`).join("\n");

  const caveat = `Memory snapshot (${reason}) · v${store.checkpoint}; topic bodies are searchable with memory_find.`;
  const parts = [
    caveat,
    block("Standing rules and memory map", middleTruncate(memory, INDEX_CAP)),
    block("Today", tailTruncate(today, TODAY_CAP)),
    block("Open scratchpad", tailTruncate(scratchpad, SCRATCHPAD_CAP)),
  ].filter((part) => part.length > 0);

  let text = parts.join("\n\n");
  if (text.length > SNAPSHOT_CAP) {
    const over = text.length - SNAPSHOT_CAP;
    const trimmedIndex = middleTruncate(
      middleTruncate(memory, INDEX_CAP),
      Math.max(0, INDEX_CAP - over),
    );
    text = [
      caveat,
      block("Standing rules and memory map", trimmedIndex),
      block("Today", tailTruncate(today, TODAY_CAP)),
      block("Open scratchpad", tailTruncate(scratchpad, SCRATCHPAD_CAP)),
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");
  }
  if (text.length > SNAPSHOT_CAP) text = text.slice(0, SNAPSHOT_CAP);
  return text;
}

/**
 * The injected prefix is what a caching runtime keys on, so the snapshot is built
 * once per checkpoint. Daily and scratchpad writes do not invalidate it; a
 * long-term topic write bumps the store revision, which does.
 */
export class SnapshotCache {
  private text: string | undefined;
  private day: string | undefined;
  private checkpoint = -1;

  get built(): boolean {
    return this.text !== undefined;
  }

  async get(store: MemoryStore, reason: SnapshotReason = "first_turn"): Promise<string> {
    const day = todayIso();
    const forced = reason === "day_rollover" || reason === "compaction";
    const changed =
      this.text === undefined || day !== this.day || store.checkpoint !== this.checkpoint;
    if (!forced && !changed && this.text !== undefined) return this.text;
    const text = await buildSnapshot(store, reason);
    this.text = text;
    this.day = day;
    this.checkpoint = store.checkpoint;
    return text;
  }

  invalidate(): void {
    this.text = undefined;
  }
}

export function composeInstructions(base: string, block: string): string {
  return `${base.replace(/\s+$/, "")}\n\n${block}`;
}

/**
 * Rebuilds the injected block only at a checkpoint and reconfigures the live
 * conversation when the composed instructions actually changed. Called before a
 * turn (day rollover or long-term write is detected from state) and on a
 * compaction event. Daily and scratchpad writes leave the prefix untouched.
 */
export class SnapshotController {
  private lastInstructions: string | undefined;
  private lastDay: string;
  private lastRevision: number;

  constructor(
    private readonly store: MemoryStore,
    private readonly base: string,
    private readonly apply: (instructions: string) => Promise<void>,
    private readonly cache: SnapshotCache = new SnapshotCache(),
    initialInstructions?: string,
  ) {
    this.lastInstructions = initialInstructions;
    this.lastDay = todayIso();
    this.lastRevision = store.checkpoint;
  }

  async refresh(reason?: SnapshotReason): Promise<string> {
    const day = todayIso();
    const chosen =
      reason ??
      (day !== this.lastDay
        ? "day_rollover"
        : this.store.checkpoint !== this.lastRevision
          ? "long_term_write"
          : "first_turn");
    const block = await this.cache.get(this.store, chosen);
    const next = composeInstructions(this.base, block);
    if (next !== this.lastInstructions) {
      await this.apply(next);
      this.lastInstructions = next;
    }
    this.lastDay = day;
    this.lastRevision = this.store.checkpoint;
    return next;
  }
}
