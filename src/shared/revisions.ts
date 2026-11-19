export interface StreamRevisions {
  draft: number;
  tools: number;
}

export function resetStreamRevisions(): StreamRevisions {
  return { draft: 0, tools: 0 };
}

export function adoptSnapshotRevision(current: number, snapshot: number): number {
  void current;
  return snapshot;
}

export function acceptDeltaRevision(current: number, revision: number | undefined): number | null {
  if (revision === undefined) return current;
  return revision < current ? null : revision;
}
