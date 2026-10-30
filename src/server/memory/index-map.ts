import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describeScope } from "./scopes.js";
import { isCli, isMissing, MemoryStore, rootFromArgs } from "./store.js";

export const MAP_BEGIN = "<!-- MAP:BEGIN -->";
export const MAP_END = "<!-- MAP:END -->";
export const MAP_BUDGET = 4000;

export interface MapScope {
  readonly scope: string;
  readonly count: number;
  readonly description: string;
}

export async function collectMapScopes(store: MemoryStore): Promise<MapScope[]> {
  let names: string[];
  try {
    names = await readdir(store.topicsDir);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  const scopes: MapScope[] = [];
  for (const scope of names.sort()) {
    try {
      if (!(await stat(join(store.topicsDir, scope))).isDirectory()) continue;
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    let lines: string[];
    try {
      lines = (await readFile(join(store.topicsDir, scope, "INDEX.md"), "utf8")).split(/\r?\n/);
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (lines.length === 0) continue;
    const count = lines.filter((line) => line.startsWith("- [")).length;
    const header = (lines[0] ?? "").replace(/^#\s*/, "");
    const withoutScope = header.replace(new RegExp(`^${escapeRegex(scope)}\\s*[—:-]\\s*`), "");
    const description = withoutScope.replace(/\s*\(\d+ topics?\)\s*$/, "").trim();
    scopes.push({ scope, count, description: description || describeScope(scope) });
  }
  return scopes;
}

export function renderMap(scopes: readonly MapScope[]): string {
  const lines = ["## Memory map", ""];
  if (scopes.length === 0) {
    lines.push("(no topics yet)");
  } else {
    for (const { scope, count, description } of scopes) {
      lines.push(`- **${scope}** (${count}) — ${description} → \`topics/${scope}/INDEX.md\``);
    }
  }
  return `${MAP_BEGIN}\n${lines.join("\n")}\n${MAP_END}`;
}

/** Replace only the bytes between the MAP markers; everything else is preserved verbatim. */
export function replaceMap(text: string, map: string): string {
  const begin = text.indexOf(MAP_BEGIN);
  const end = text.indexOf(MAP_END);
  if (begin >= 0 && end > begin) {
    return `${text.slice(0, begin)}${map}${text.slice(end + MAP_END.length)}`;
  }
  const separator = text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${separator}${map}\n`;
}

export interface IndexMapResult {
  readonly text: string;
  readonly size: number;
  readonly warning: string | undefined;
  readonly scopes: readonly MapScope[];
}

export async function buildIndexMap(store: MemoryStore): Promise<IndexMapResult> {
  return store.exclusive(async () => {
    const scopes = await collectMapScopes(store);
    const raw = await store.readMemory();
    const text = replaceMap(raw, renderMap(scopes));
    const size = text.length;
    await store.atomicWrite(store.memoryFile, text);
    return {
      text,
      size,
      warning:
        size > MAP_BUDGET
          ? `MEMORY.md is ${size} chars, over the ${MAP_BUDGET}-char injection budget`
          : undefined,
      scopes,
    };
  });
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (isCli(import.meta.url)) {
  const store = new MemoryStore(rootFromArgs(process.argv));
  const result = await buildIndexMap(store);
  console.log(
    `MEMORY.md → ${result.size} chars (${result.scopes.length} scopes, ${result.scopes.reduce(
      (sum, scope) => sum + scope.count,
      0,
    )} topics)`,
  );
  if (result.warning !== undefined) console.log(`WARNING: ${result.warning}`);
  console.log("written");
}
