/** Streaming counters the server restarts from 1 with a new process. */
export interface StreamRevisions {
  draft: number;
  tools: number;
}

/** Counters a fresh stream connection starts from. */
export function resetStreamRevisions(): StreamRevisions {
  return { draft: 0, tools: 0 };
}

/**
 * A snapshot is authoritative: adopt its counter even when a restarted server
 * sends a lower one than this page still holds.
 */
export function adoptSnapshotRevision(current: number, snapshot: number): number {
  void current;
  return snapshot;
}

/**
 * A delta must not move the draft backwards. Returns the counter to keep, or
 * null when the delta belongs to an older revision and must be ignored.
 */
export function acceptDeltaRevision(current: number, revision: number | undefined): number | null {
  if (revision === undefined) return current;
  return revision < current ? null : revision;
}
