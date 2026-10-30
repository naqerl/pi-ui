import { isCli, MemoryStore, rootFromArgs, type TopicRecord, type UsageState } from "./store.js";

const STOP_WORDS = new Set(
  "the a an and or of to in on for with that this it is are was were be been by as at from not no do does did but if then than so we you i my your our their its there these those".split(
    " ",
  ),
);

export const EXACT_TERM_WEIGHT = 2.2;
export const PREFIX_TERM_WEIGHT = 0.6;

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[`*_#>[\](){}"'’]/g, " ")
    .split(/[^a-z0-9./:_-]+/)
    .map((word) => word.replace(/^[-./:]+|[-./:]+$/g, ""))
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

interface SearchDocument {
  readonly topic: TopicRecord;
  readonly tokens: ReadonlyMap<string, number>;
}

export interface FindResult {
  readonly rel: string;
  readonly title: string;
  readonly updated: string;
  readonly score: number;
  readonly snippet: string;
}

export interface FindOptions {
  readonly limit?: number;
  readonly record?: boolean;
  readonly now?: Date;
}

function termFrequency(text: string): Map<string, number> {
  const frequencies = new Map<string, number>();
  for (const word of tokenize(text)) {
    frequencies.set(word, (frequencies.get(word) ?? 0) + 1);
  }
  return frequencies;
}

function makeSnippet(lines: readonly string[], queryTerms: readonly string[]): string {
  let bestLine = 0;
  let bestScore = -1;
  lines.forEach((line, index) => {
    const words = tokenize(line);
    if (words.length === 0) return;
    let score = 0;
    for (const term of queryTerms) {
      if (words.some((word) => word.startsWith(term) || term.startsWith(word))) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLine = index;
    }
  });
  const start = Math.max(0, bestLine - 1);
  return lines
    .slice(start, start + 3)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n    ")
    .slice(0, 300);
}

export async function findMemory(
  store: MemoryStore,
  query: string,
  options: FindOptions = {},
): Promise<FindResult[]> {
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0) return [];
  const topics = await store.listTopics();
  if (topics.length === 0) return [];
  const documents: SearchDocument[] = topics.map((topic) => ({
    topic,
    tokens: termFrequency(`${topic.title}\n${topic.body}`),
  }));
  const total = documents.length;
  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const word of document.tokens.keys()) {
      documentFrequency.set(word, (documentFrequency.get(word) ?? 0) + 1);
    }
  }
  const idf = (word: string): number =>
    Math.log(1 + total / (1 + (documentFrequency.get(word) ?? 0)));
  let usage: UsageState = { version: 1, hits: {} };
  try {
    usage = await store.readUsage();
  } catch {
    // a broken usage file must not stop search
  }
  const now = options.now?.getTime() ?? Date.now();

  const ranked = documents
    .map((document) => {
      let score = 0;
      for (const term of queryTerms) {
        const exact = document.tokens.get(term) ?? 0;
        if (exact > 0) {
          score += (1 + Math.log(exact)) * idf(term) * EXACT_TERM_WEIGHT;
        } else {
          // Prefix matching both ways: `verif` finds `verifier`, and a long query
          // word still finds its shorter index term.
          for (const [word, count] of document.tokens) {
            if (word.startsWith(term) || term.startsWith(word)) {
              score += (1 + Math.log(count)) * idf(word) * PREFIX_TERM_WEIGHT;
            }
          }
        }
        if (document.topic.title.toLowerCase().includes(term)) score += 3.5;
        if (document.topic.file.toLowerCase().includes(term)) score += 2.0;
      }
      if (score <= 0) return undefined;
      const ageDays = document.topic.updated
        ? Math.max(0, (now - Date.parse(document.topic.updated)) / 86_400_000)
        : 90;
      score *= 1 + 0.25 * Math.exp(-ageDays / 45);
      const hits = usage.hits[document.topic.rel]?.count ?? 0;
      score *= 1 + 0.15 * Math.min(4, hits);
      const result: FindResult = {
        rel: document.topic.rel,
        title: document.topic.title,
        updated: document.topic.updated,
        score,
        snippet: makeSnippet(document.topic.body.split(/\r?\n/), queryTerms),
      };
      return result;
    })
    .filter((result): result is FindResult => result !== undefined)
    .sort((left, right) => right.score - left.score || left.rel.localeCompare(right.rel));

  const limited = ranked.slice(0, options.limit ?? 6);
  if (options.record !== false && limited.length > 0) {
    await store.recordUsage(limited.map((hit) => ({ rel: hit.rel, query })));
  }
  return limited;
}

if (isCli(import.meta.url)) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const terms = args
    .filter((arg) => !arg.startsWith("--"))
    .join(" ")
    .trim();
  if (terms.length === 0) {
    console.error('usage: tsx src/server/memory/find.ts "terms" [--json] [--memory=<dir>]');
    process.exit(2);
  }
  const store = new MemoryStore(rootFromArgs(args));
  const results = await findMemory(store, terms, { limit: json ? 20 : 6 });
  if (json) {
    console.log(
      JSON.stringify(
        results.map((result) => ({ ...result, score: Number(result.score.toFixed(3)) })),
        null,
        2,
      ),
    );
  } else if (results.length === 0) {
    console.log(`no match for: ${terms}`);
    process.exit(1);
  } else {
    for (const result of results) {
      console.log(`\n${result.score.toFixed(1).padStart(6)}  topics/${result.rel}`);
      console.log(`        ${result.title}${result.updated ? `  ·  ${result.updated}` : ""}`);
      console.log(`    ${result.snippet}`);
    }
    console.log(`\n${results.length} result(s). Read one with memory_read.`);
  }
}
