/** The first matching line of a memory topic, used by the chat's search chip. */
export interface MemoryPathMatch {
  /** Memory-relative path, such as topics/projects/widget-cache.md. */
  path: string;
  line: string;
}

/** One file a memory_read tool call returned, with the range it covered. */
export interface MemoryReadRange {
  path: string;
  from: number;
  to: number;
}

/**
 * The typed part of a memory tool result. The model still gets the ordinary text output; this is
 * only what the chat needs to paint one honest chip instead of a generic tool card.
 */
export interface MemoryToolDetails {
  kind: "memory";
  /** Older payloads omit this; a read is inferred from its ranges and lack of matches. */
  operation?: "find" | "read";
  /** Matching term occurrences for a find; absent when the tool did not report a count. */
  hits?: number;
  /** Topic files a single find matched; absent when the tool did not report a count. */
  topics?: number;
  /** Matched topic paths, each with its first matching line. */
  paths: MemoryPathMatch[];
  /** Characters of matching snippets the tool returned; absent when unreported. */
  chars?: number;
  /** Files this call read, with their line ranges. */
  reads: MemoryReadRange[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function parsePathMatch(value: unknown): MemoryPathMatch | undefined {
  if (typeof value === "string") return { path: value, line: "" };
  if (!isRecord(value) || typeof value.path !== "string") return undefined;
  const line = typeof value.line === "string" ? value.line : "";
  const firstLine = typeof value.firstLine === "string" ? value.firstLine : line;
  return { path: value.path, line: firstLine };
}

function parseReadRange(value: unknown): MemoryReadRange | undefined {
  if (!isRecord(value) || typeof value.path !== "string") return undefined;
  const lines = typeof value.lines === "string" ? /^(\d+)\D+(\d+)$/.exec(value.lines) : null;
  const from = positiveInteger(value.from ?? value.start ?? value.startLine ?? lines?.[1]);
  const to = positiveInteger(value.to ?? value.end ?? value.endLine ?? lines?.[2]);
  if (from === undefined || to === undefined || to < from) return undefined;
  return { path: value.path, from, to };
}

/** Reads the typed memory payload from a tool result, rejecting anything that is not one. */
export function parseMemoryToolDetails(value: unknown): MemoryToolDetails | undefined {
  if (!isRecord(value) || value.kind !== "memory") return undefined;
  const hits = nonNegativeInteger(value.hits);
  const topics = nonNegativeInteger(value.topics);
  const chars = nonNegativeInteger(value.chars);
  const pathValues = Array.isArray(value.paths) ? value.paths : [];
  const readValues = Array.isArray(value.reads) ? value.reads : [];
  const paths = pathValues.map(parsePathMatch);
  const reads = readValues.map(parseReadRange);
  if (paths.some((item) => item === undefined) || reads.some((item) => item === undefined)) {
    return undefined;
  }
  const normalizedPaths = paths as MemoryPathMatch[];
  const normalizedReads = reads as MemoryReadRange[];
  // Older or test payloads may omit the operation; a read is the only call that has a range
  // without a matching path.
  const operation =
    value.operation === "find" || value.operation === "read"
      ? value.operation
      : normalizedReads.length > 0 && normalizedPaths.length === 0 && (hits ?? 0) === 0
        ? "read"
        : "find";
  return {
    kind: "memory",
    operation,
    ...(hits === undefined ? {} : { hits }),
    ...(topics === undefined ? {} : { topics }),
    paths: normalizedPaths,
    ...(chars === undefined ? {} : { chars }),
    reads: normalizedReads,
  };
}
