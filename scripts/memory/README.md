# Memory tooling (prototype)

Standalone scripts for a two-level agent memory: a small always-injected index plus topic bodies
that are searched on demand and merged on a schedule. They operate directly on a memory directory
(`PI_MEMORY_DIR`, or `--memory=<dir>`, default `~/.pi/agent/memory`).

This is the reference implementation for the server-side port (`src/server/memory/`). Algorithms
and constants here are the ones that were validated on real data — 210 KB of `MEMORY.md` (83
sections) split into 97 topic files, and 384 journalled blocks attached to topics across 47 merge
targets. Port the behaviour; do not redesign the scoring.

## Layout this expects

```
MEMORY.md            preamble + standing rules + <!-- MAP:BEGIN --> … <!-- MAP:END -->
SCRATCHPAD.md        "- [ ] item" / "- [x] item", stamped with <!-- ts [sid] -->
daily/YYYY-MM-DD.md  append-only journal, entries delimited by <!-- ts [sid] -->
topics/<scope>/*.md  one topic per file, front matter topic / scope / updated
topics/<scope>/INDEX.md, topics/INDEX.md
archive/YYYY-MM/     daily logs consumed by a consolidation pass
.dream-state.json    { version, lastRunAt, lastRunDate, consumed[], lastBlocks }
scopes.json          optional [[scope, "regex"], …], ordered, first match wins
```

## Tools

| file                                  | what it does                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `split.mjs [--apply]`                 | one-shot migration: split `## ` sections of `MEMORY.md` into `topics/<scope>/<file>.md`, carving bodies over 8000 chars on headings then paragraphs; writes the scope indexes. Keeps `## Standing rules` inline.                                                                                                                                                      |
| `build-index.mjs [--apply]`           | regenerates only the bytes between the MAP markers — one line per scope with its topic count and index path. Idempotent: two runs are byte-identical. Warns when the result exceeds 4000 chars.                                                                                                                                                                       |
| `find.mjs "<terms>" [--json]`         | TF-IDF over topic title+body (`idf = log(1 + N/(1+df))`), exact-term weight 2.2, prefix match on the last term, title/filename bonuses, `× (1 + 0.25·e^(−ageDays/45))` recency and `× (1 + 0.15·min(4, recallCount))` recall. Prints path, title and a 3-line snippet; logs the top three hits to `.usage.json`.                                                      |
| `dream.mjs [--emit <dir>] [--commit]` | consolidation pass. Classifies whole journalled blocks (never lines), attaches each to the best topic above 1.1, and reports near-duplicates (4-shingle Jaccard ≥ 0.70), topics over 6000 chars, index drift and open scratchpad items. `--emit` writes one work item per target; `--commit` archives all daily logs but today's, updates state and rebuilds the map. |
| `mwrite.mjs <topic path>`             | the only write path for a topic: stdin → body, keeps front matter, restamps `updated`, takes the title from the first `# ` heading, syncs the scope index line, writes temp+rename.                                                                                                                                                                                   |

## Loop

```sh
node dream.mjs --emit /tmp/merge      # one work item per topic to fold
#   … fold each item with mwrite.mjs …
node dream.mjs --commit               # archive the consumed journal, rebuild the map
node find.mjs "what you half-remember"
```

## Why the shape

The injected index is capped at 4000 chars and middle-truncated, so both the standing rules at the
top and the newest entries survive. Everything else lives in bodies that are searched, not injected.
Consolidation must only happen at snapshot checkpoints (session start, day rollover, a long-term
write, before compaction) because a byte-stable prefix is what keeps prompt caching alive — daily
and scratchpad writes must not invalidate it.

Writes are `writeFileSync`/rename without locking, which assumes a single writer. A multi-client
server needs a serialising queue around `mwrite`.
