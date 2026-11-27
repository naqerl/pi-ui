# Dashboard widgets: one source contract

Every dashboard widget reads JSON and draws it through its `mapping`. That is
true for `poll`, `static` and `builtin` sources alike: there is no second
rendering path for builtins and no code that branches on a source _name_ to
render. The page only knows the widget `kind` and its mapping.

## The source contract

Sources live in `src/shared/dashboard-sources.ts`:

```ts
interface SourceSpec {
  name: string;
  describe: string;
  kind?: "builtin" | "poll" | "static";
  sample: unknown;
  read(ctx: SourceContext): Promise<unknown>;
}
```

A source's `read()` returns plain JSON. A widget turns that JSON into a view
with `renderWidget(widget, data)`; path expressions such as `servers[].name`,
`items[0]` or `$` select fields, and a value starting with `=` is a literal.
The field list for each kind is the same one `dashboard_upsert` documents.

The registry is small and explicit:

- `registerSource(spec)` adds a source once; duplicate names are rejected.
- `listSources()` returns the registered specs in registration order.
- `readSource(name, ctx)` reads one source, or throws for an unknown name.

The builtin sources are registered in that file: `tokens`, `context`, `cache`,
`mcp`, `mcp_events`, `jobs`, `session`, `task_reopens`, `task_durations` and
`bots`. Their previous special-case data builders are gone; `read()` is the only
way to get their payload.

## Discovery

`GET /api/dashboard/sources` returns one entry per registered source:

```json
{
  "sources": [
    {
      "name": "tokens",
      "description": "Token usage for the current conversation: …",
      "sample": { "input": 0, "output": 0, "rows": [] }
    }
  ]
}
```

`sample` is a real, small payload produced by the source (or its registered
sample when live inputs are not available yet). Use it to write a mapping or a
replacement without reading the source tree.

## Replacing a builtin

A widget id is a stable place on the board, not a promise that its source stays
builtin. Pass `replace: true` to `dashboard_upsert` to take over an id that a
builtin uses, keep the id and its place, and change the source. For example:

```json
{
  "id": "tokens",
  "replace": true,
  "title": "Tokens by model",
  "kind": "table",
  "source": {
    "type": "poll",
    "script": "const r = await fetch('https://example.test/usage'); if (!r.ok) throw new Error(String(r.status)); return r.json();",
    "intervalSec": 60
  },
  "mapping": {
    "rows": "models",
    "columns": { "Model": "name", "Tokens": "tokens" }
  }
}
```

The poll result is rendered by the same `renderWidget` path as the builtin
would have been. On restart the stored widget is loaded as written; the builtin
does not come back. Re-adding an id explicitly (with or without `replace`)
clears any tombstone for it.

## Tombstones

Deleting a widget records its id in `dashboard.json`:

```json
{
  "version": 2,
  "tombstones": ["mcp-events"],
  "widgets": [],
  "layout": { "sections": [] }
}
```

Seeding skips tombstoned ids, so a deleted default stays deleted. Older files
without `tombstones` load with `[]`. `POST /api/dashboard/reset` clears the list
because it restores the default board on purpose.

## The committed default board

`src/shared/dashboard-default.ts` exports `DEFAULT_DASHBOARD`:

```ts
{
  version, sections, widgets;
}
```

`widgets` are the same objects `dashboard_upsert` writes and `sections` are the
same slots `dashboard_layout` writes. It is the board production uses:
`host-usage` on top; **Cache & prefix** with `prefix-moments` and `prefix-cost`;
**Session** with `context`, `tokens`, `mcp`, `mcp-events` and `task-reopens`;
and **Infrastructure** with `hetzner`, `hetzner-cost`, `go-usage` and
`bg-jobs`.

A fresh `DATA_DIR` with no `dashboard.json` is seeded from `DEFAULT_DASHBOARD`.
A current-version file gains any missing default widgets except tombstoned ones.
An older file is **not** overwritten: its `defaultVersion` is recorded and
returned by `GET /api/dashboard` so the page can offer "Reset to default".

`POST /api/dashboard/reset` replaces the board with `DEFAULT_DASHBOARD`, clears
tombstones and returns the new dashboard state.

## Full screen

Every card carries a maximize control in its header, between the error/stale
badge and the kebab menu. It is there for every widget kind and source and at
every width, phone included. Maximizing opens the widget as an overlay over the
whole viewport: one thin header with the card's title and a single minimize
control, and the card body below it.

There are three exits: minimize, Escape, and the browser's back button. The
overlay pushes one history entry marked `piWidgetFullscreen` and leaves the URL
alone, so Back closes the widget, the `?page=stats` pager state still wins on a
reload, and a following Back never reopens it.

A sparkline that is expanded fills the space under the header instead of using
`chart.height`; the same widget keeps its `chart.height` in the card. This is a
presentation rule of the expanded state only: card geometry, spans and saved
grid slots are untouched, and the board is exactly where it was when the
overlay closes.

## Guards

The unit tests in `e2e/dashboard.test.ts` (part of the existing e2e gate) check
that every registered source has a non-empty `description`, a `sample` that
renders through `renderWidget`, and that every builtin named by
`DEFAULT_DASHBOARD` is registered.
