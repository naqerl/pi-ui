/**
 * Keeps every held item below `from`, then the snapshot's items from `from` up.
 * A held row above the snapshot's newest row arrived after the server read it
 * (an SSE message, a send response or an optimistic row), so it stays: replacing
 * the window would make it blink out until the next state push. Rows the
 * snapshot already has by id or `same` are not copied twice.
 */
export function mergeWindow<T extends { order: number; id: string }>(
  current: T[],
  from: number,
  fresh: T[],
  same?: (left: T, right: T) => boolean,
): T[] {
  let newest = Number.NEGATIVE_INFINITY;
  for (const item of fresh) if (item.order > newest) newest = item.order;
  const freshIds = new Set(fresh.map((item) => item.id));
  const added = current.filter((item) => {
    if (item.order < from || item.order <= newest) return false;
    if (freshIds.has(item.id)) return false;
    return same === undefined || !fresh.some((candidate) => same(item, candidate));
  });
  return [...current.filter((item) => item.order < from), ...fresh, ...added];
}
