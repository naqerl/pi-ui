import type { StreamTextDelta } from "../shared/types";

/** Ordered updates, painted at most once per frame. Clear at authoritative boundaries
 * (snapshot/done/tool transition), so a scheduled frame cannot resurrect an old draft. */
export function frameBatch<T>(
  apply: (items: T[]) => void,
  schedule: (run: () => void) => number,
  cancel: (id: number) => void,
) {
  let items: T[] = [];
  let frame: number | undefined;
  const flush = () => {
    if (frame !== undefined) cancel(frame);
    frame = undefined;
    const next = items;
    items = [];
    if (next.length > 0) apply(next);
  };
  return {
    push(item: T) {
      items.push(item);
      frame ??= schedule(flush);
    },
    flush,
    clear() {
      if (frame !== undefined) cancel(frame);
      frame = undefined;
      items = [];
    },
  };
}

export function reduceDraft(current: string, updates: StreamTextDelta[]): string {
  for (const update of updates)
    current = typeof update.full === "string" ? update.full : current + update.text;
  return current;
}

/** Burst refreshes share one request; requests during a fetch get one trailing pass.
 * Unlike dropping in-flight calls, this cannot miss a completion after the read began. */
export function refreshBatch(work: () => Promise<void>, delayMs = 32) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let closed = false;
  let waiters: Array<() => void> = [];
  const start = () => {
    if (closed || running || timer !== undefined || waiters.length === 0) return;
    timer = setTimeout(async () => {
      timer = undefined;
      running = true;
      const current = waiters;
      waiters = [];
      try {
        await work();
      } finally {
        running = false;
        for (const resolve of current) resolve();
        start();
      }
    }, delayMs);
  };
  return {
    open() {
      closed = false;
    },
    request: () =>
      closed
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.push(resolve);
            start();
          }),
    close() {
      closed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      for (const resolve of waiters) resolve();
      waiters = [];
    },
  };
}
