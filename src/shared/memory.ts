export interface MemoryPathMatch {
  path: string;
  line: string;
}

export interface MemoryReadRange {
  path: string;
  from: number;
  to: number;
}

export interface MemoryToolDetails {
  kind: "memory";

  operation?: "find" | "read";

  hits?: number;

  topics?: number;

  paths: MemoryPathMatch[];

  chars?: number;

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
