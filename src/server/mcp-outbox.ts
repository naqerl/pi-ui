import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface McpDelivery {
  id: string;
  text: string;
  at: string;
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

  async enqueue(text: string, keys: string[] = []): Promise<void> {
    await this.enqueueMany([text], keys);
  }

  async enqueueMany(texts: string[], keys: string[] = []): Promise<void> {
    if (this.closed) throw new Error("MCP outbox closed");
    const added = texts.map((text) => ({ id: randomUUID(), text, at: new Date().toISOString() }));
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
        const item = this.pending[0];
        if (item === undefined) return;
        await this.deliver(item);
        await this.update((items) => items.filter((entry) => entry.id !== item.id));
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
