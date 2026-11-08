import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface McpDelivery {
  id: string;
  text: string;
  at: string;
  /** Stable event keys this delivery carries, for pending-deduplication. */
  keys?: string[];
}

/** Persist before acknowledging the provider cursor. Delivery uses a durable request id,
 * so a crash after submission but before removal is harmless. One FIFO retry loop. */
export class McpOutbox {
  private pending: McpDelivery[] = [];
  private seen: string[] = [];
  private writes: Promise<unknown> = Promise.resolve();
  private draining: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    private readonly path: string,
    private readonly deliver: (item: McpDelivery) => Promise<void>,
    private readonly retryMs = 1_000,
  ) {}

  async load(): Promise<void> {
    try {
      const data = JSON.parse(await readFile(this.path, "utf8"));
      if (
        data.version !== 1 ||
        !Array.isArray(data.pending) ||
        data.pending.some(
          (item: McpDelivery) =>
            typeof item.id !== "string" ||
            typeof item.text !== "string" ||
            typeof item.at !== "string",
        )
      )
        throw new Error("Invalid MCP outbox");
      this.pending = data.pending;
      this.seen = Array.isArray(data.seen) ? data.seen : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private update(
    change: (items: McpDelivery[]) => McpDelivery[],
    keys: string[] = [],
  ): Promise<void> {
    const run = this.writes.then(async () => {
      const next = change(this.pending);
      const seen = [...new Set([...this.seen, ...keys])].slice(-10_000);
      await mkdir(dirname(this.path), { recursive: true });
      const temp = `${this.path}.tmp`;
      await writeFile(temp, `${JSON.stringify({ version: 1, pending: next, seen })}\n`, {
        mode: 0o600,
      });
      await rename(temp, this.path);
      this.pending = next;
      this.seen = seen;
    });
    this.writes = run.catch(() => {});
    return run;
  }

  has(key: string): boolean {
    return this.seen.includes(key);
  }

  /** True while a delivery carrying this key is still waiting to be submitted. */
  hasPending(key: string): boolean {
    return this.pending.some((item) => item.keys?.includes(key) === true);
  }

  async enqueue(text: string, keys: string[] = []): Promise<void> {
    await this.enqueueMany([text], keys);
  }

  async enqueueMany(texts: string[], keys: string[] = []): Promise<void> {
    if (this.closed) throw new Error("MCP outbox closed");
    const added = texts.map((text) => ({
      id: randomUUID(),
      text,
      at: new Date().toISOString(),
      ...(keys.length === 0 ? {} : { keys: [...keys] }),
    }));
    await this.update((items) => [...items, ...added], keys);
  }

  /** Start after chat recovery, and after newly accepted batches have advanced the feed. */
  start(): void {
    if (this.closed || this.draining !== undefined) return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
      if (!this.closed && this.timer === undefined && this.pending.length > 0) this.start();
    });
  }

  private async drain(): Promise<void> {
    try {
      while (!this.closed) {
        await this.writes;
        const batch = this.pending.slice(0, 50);
        if (batch.length === 0) return;
        // A partial failure may replay already-submitted IDs. Durable request
        // deduplication makes that safe and avoids one whole-file write per event.
        for (const item of batch) await this.deliver(item);
        const ids = new Set(batch.map((item) => item.id));
        await this.update((items) => items.filter((entry) => !ids.has(entry.id)));
      }
    } catch (error) {
      console.error("[mcp] durable delivery pending; will retry", error);
      if (!this.closed) {
        this.timer = setTimeout(() => this.start(), this.retryMs);
        this.timer.unref?.();
      }
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    await this.draining;
    await this.writes;
  }
}

/** Do not let a later cursor overtake a batch whose disk write failed. Shutdown
 * leaves the cursor unacknowledged so the provider can replay it next time. */
export class McpIntake {
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  constructor(private readonly retryMs = 1_000) {}
  enqueue(accept: () => Promise<void>): void {
    this.tail = this.tail.then(async () => {
      while (!this.closed) {
        try {
          await accept();
          return;
        } catch (error) {
          console.error("[mcp] intake pending; cursor not acknowledged", error);
          await new Promise((resolve) => setTimeout(resolve, this.retryMs));
        }
      }
    });
  }
  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
  }
}
