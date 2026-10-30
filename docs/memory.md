# Memory

`pi-memory` injects at most 4 KB of `MEMORY.md` per turn, middle-truncated. Once that file
describes everything, a large `MEMORY.md` hides most of itself and recall depends on remembering a
path. pi-ui therefore keeps memory in three layers — **index → bodies → retrieval** — plus a
consolidation pass.

The tree lives in the pi-ui data directory:

```text
data/memory/
  MEMORY.md                 index only: preamble, standing rules, generated map
  topics/
    INDEX.md                one line per scope
    <scope>/INDEX.md        one line per topic in that scope
    <scope>/<slug>.md       front matter (topic, scope, updated) + body
  daily/YYYY-MM-DD.md       journal, one <!-- <ts> [<sid>] --> block per entry
  archive/YYYY-MM/          daily logs consumed by a consolidation pass
  SCRATCHPAD.md             "- [ ] item" / "- [x] item"
  .dream-state.json         {version, lastRunAt, lastRunDate, consumed[], lastBlocks}
  .usage.json               {hits: {"<scope>/<file>": {count, lastAt, lastQuery}}}
```

## Modules (`src/server/memory/`)

| module         | responsibility                                                                                                                                                                                                                                      |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `store.ts`     | Path resolution, front-matter read/write, atomic **tmp + rename** writes, and a serialising queue so two tool calls cannot interleave a read-modify-write. This is the only topic writer.                                                           |
| `scopes.ts`    | Ordered `[name, regex]` rules; the first match wins, unmatched sections go to `misc`.                                                                                                                                                               |
| `migrate.ts`   | Splits a monolithic `MEMORY.md` into the layout. Bodies over 8000 chars are carved on `#`/`##`/`###` headings first, then on blank-line paragraphs. Dry-run by default; `--apply` writes.                                                           |
| `index-map.ts` | Regenerates only the bytes between `<!-- MAP:BEGIN -->` and `<!-- MAP:END -->`, byte-identically on a second run; warns above 4000 chars. Never moves a body into `MEMORY.md`.                                                                      |
| `find.ts`      | TF-IDF over `topics/` (excluding `INDEX.md`), exact-term weight 2.2, prefix matching both ways, title/filename bonus, recency and recall multipliers; records the top three in `.usage.json`.                                                       |
| `dream.ts`     | Consolidation pass: attaches whole journalled blocks above 1.1, reports new-topic candidates, near-duplicates (4-shingle Jaccard ≥ 0.70), oversized topics, index drift and open scratchpad items. `--emit` writes work items; `--commit` archives. |
| `snapshot.ts`  | Assembles the injected block (index ≤ 1800, today's tail ≤ 1200, open scratchpad ≤ 600, hard total 4000) and caches it between checkpoints.                                                                                                         |
| `tools.ts`     | Registers `memory_write`, `memory_read`, `memory_find`, `memory_dream`, `memory_status` in the same registry as `task-tools.ts`, so `/api/state` lists them.                                                                                        |

### Writing a topic

Every topic write goes through one function: keep the front matter, restamp `updated` to the ISO
date, take the title from the body's first `# ` heading, update that scope's `INDEX.md` line, and
write via a temp file plus rename. A topic is never half-written.

`memory_write` with `target: "long_term"` bumps the store revision and invalidates the snapshot.
`target: "daily"` and `target: "scratchpad"` do **not** invalidate it.

### Scoring

`find` uses `idf = log(1 + N / (1 + df))`. An exact term contributes
`(1 + log(tf)) × idf × 2.2`; a prefix-only match contributes at the lower 0.6 weight and matches
both directions, so `verif` finds `verifier`. Title hits add 3.5 and filename hits add 2.0. The
result is multiplied by `1 + 0.25·e^(−ageDays/45)` for recency and `1 + 0.15·min(4, recallCount)`
for recall. `INDEX.md` is never indexed. A result is
`{rel, title, updated, score, snippet}` with a snippet of at most three lines.

## Invariants

- `MEMORY.md` never carries a topic body. It carries the preamble, the standing rules, and the
  generated MAP block only.
- Every topic appears in exactly one scope `INDEX.md`, and every scope appears in `topics/INDEX.md`.
- `topic` is the title, `scope` is the owning scope, and `updated` is an ISO date (`YYYY-MM-DD`).
- One writer per file: all writes go through `MemoryStore`'s serial queue and tmp + rename.
- Daily blocks use exactly the grammar `pi-memory` writes — `<!-- <ISO timestamp> [<session id>] -->`
  followed by a heading and body — so an existing journal migrates unchanged.
- The snapshot is **byte-stable between checkpoints**. It is rebuilt only on the first turn, a day
  rollover, a long-term `memory_write`, and before compaction. A stable prefix is what keeps prompt
  caching alive.

## The loop

```sh
# 1. one-shot migration (dry-run first)
npx tsx src/server/memory/migrate.ts --memory=data/memory
npx tsx src/server/memory/migrate.ts --memory=data/memory --apply

# 2. retrieve a body when the index is not enough
npx tsx src/server/memory/find.ts --memory=data/memory "whichever terms you half-remember"

# 3. consolidation: one merge work item per target
npx tsx src/server/memory/dream.ts --memory=data/memory --emit .dream/merge
#    fold each item back through memory_write (one topic per call)

# 4. close the pass: archive consumed daily logs and rebuild the map
npx tsx src/server/memory/dream.ts --memory=data/memory --commit
```

The same steps are available to the agent as `memory_write`, `memory_read`, `memory_find`,
`memory_dream` and `memory_status`. Writes to `daily/` and `SCRATCHPAD.md` are cheap; merging is
deliberate. `--commit` archives every daily log except today's into `archive/YYYY-MM/`, records the
archived names in `.dream-state.json`'s `consumed` array, and re-runs the index build.

The injected block is assembled as the index (middle-truncated), today's journal tail, and open
scratchpad items, with a one-line caveat naming the snapshot reason. `SnapshotController` refreshes
it before every turn and on a compaction event; it reconfigures the live conversation only when the
composed instructions changed. A day rollover is detected from the cached day and a long-term write
from the store revision, so the server does not keep serving the boot-time prefix. Compaction is
disabled in this build, but the snapshot module still exposes the `compaction` checkpoint so a manual
pass can use it.
