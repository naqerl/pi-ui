# `hetzner-cost` full screen: version stop

Status: **stopped at the version gate**. The deployment this task targets is
1.14.1, whose `dist/client` bundle carries no maximize control (`Maximize` and
`Minimize` do not occur in it), so a widget cannot be opened full screen there.
No `dashboard_upsert` was issued and the board is untouched.

This is requirement 1's stop report. The change itself is the chart object
below, applied with one call once a 1.15.0+ deployment with `pt3f` is up.

## The gate

| Probe | Result |
| --- | --- |
| recorded deployment | 1.14.1, CHANGELOG stops at 1.14.1, no maximize control |
| `curl http://127.0.0.1:8787/api/health` | exit 7, connection refused |
| `https://magpie-lab.tail6dedc8.ts.net/api/health` | 401, "the key is the k= in the link magpie printed" |
| `…/api/dashboard`, `…/api/state` | 401, same key gate |
| `DATA_DIR` / `dashboard.json` | absent from the environment and the host |

The version and the missing control are the ones recorded for this task; the
worker could not re-read them, because the only reachable host is key-gated and
nothing answers on localhost, and `MAGPIE_WEB_KEY` is not in the environment.
Nothing was emulated with CSS or a taller `chart.height`.

The repository side is ready: `HEAD` is `499974e` (`origin/main`, package
1.15.0), and both gates are ancestors of it, `o8d7` (#136, the maximize overlay
that supplies the panel height) and `pt3f` (`e2ce7a9`, `namedSeries` keeps null
slots). A deployed 1.15.0+ instance is what is missing.

## The change: `chart.y.ticks` 4 → 6

One `dashboard_upsert` replaces the widget wholesale
(`src/server/dashboard.ts:925`), so the payload re-sends every field unchanged
and tunes only `chart.y.ticks`. The chart object below is complete and parses:

```json
{
  "type": "line",
  "height": 200,
  "yDomain": "auto",
  "legend": true,
  "showTooltip": true,
  "y": { "format": "currency", "ticks": 6, "currency": "$" },
  "series": [
    { "key": "actual", "label": "Actual", "color": "var(--chart-1)", "type": "line" },
    {
      "key": "projection",
      "label": "Projection",
      "color": "var(--chart-3)",
      "type": "line",
      "dashed": true
    }
  ]
}
```

The call around it keeps the widget's index and board slot, because the layout
is keyed by `id` and is not part of the payload:

```json
{
  "id": "hetzner-cost",
  "title": "Hetzner spend this month",
  "kind": "sparkline",
  "source": {
    "type": "poll",
    "script": "<from dashboard_get>",
    "intervalSec": 180,
    "timeoutSec": 20
  },
  "mapping": "<from dashboard_get>",
  "chart": { "...": "the object above" }
}
```

`source.script` and `mapping` are the live widget's and are the only fields this
record does not write down: inventing a poll script would change the cost model,
which requirement 9 rules out, and `upsert` would swap it in silently. Replay
therefore reads the widget with `dashboard_get`, changes `chart.y.ticks` from 4
to 6, and sends the result back whole.

At full-screen height the invariant is the one to check, not the number: at
least five labelled y values, none clipped by the 34 px gutter. Six is a target
count (six labels over five intervals where four asked for four), and
`formatChartValue` rounds currency, so labels read `$24`, not `$24.07`.
`yDomain` stays `"auto"`, since `[0, max]` would press the accrued ramp into the
bottom third of a tall panel. `chart.height` stays 200; the overlay supplies the
panel height.

## Judged, not configurably fixable

A payload cannot change these; they are a renderer follow-up (`parseChartSeries`
and the `XAxis`):

- stroke width is `strokeWidth={1.5}` (`src/client/StatsView.tsx:822`);
- dots are `dot={false}` (`:823`);
- the x axis is `fontSize={10}` with no `interval` (`:678`), so decimating ticks
  on a phone is renderer work;
- `chart.x.labels` is inert, because the view's own labels win
  (`view.labels ?? chart?.x?.labels`, `:607`).

## Projection alignment

`pt3f` is in the tree, so a named series is padded with `null` to the label
count instead of dropping slots, and both series stay 30 points. A board still
on the old bundle draws the projection from the wrong day; a check made on that
board is not a pass, and nothing here hides the misalignment.

## Evidence

No screenshots: a 1.14.1 client has no maximize control to open, and this
environment cannot raise a 1.15.0 one, because `node_modules` is absent and the
registry is unreachable (`npm ci --include=dev` exits 1 with `E500`).

The chart and the call were instead checked against the real parser and the real
upsert path, from source with Node type stripping, in a throwaway `DATA_DIR` and
without touching repo files:

- `parseChart` accepts the object above and rejects `strokeWidth`, `dot` and
  `x.interval` (`"strokeWidth" is not a chart field; …`), so no key is invented;
- `DashboardManager.upsert` with `chart.y.ticks: 6` keeps the widget's index and
  the layout, polls a fixture, and renders `actual` and `projection` at 30/30
  points with 30 labels;
- the saved `dashboard.json` keeps `ticks: 6`, `intervalSec: 180` and
  `timeoutSec: 20`, and the frame strips the script.

That proves the payload shape only. The fixture script, board and values are
synthetic, so it does not stand in for the live full-screen check.

## Gate commands

| Command | Exit | Reason |
| --- | --- | --- |
| `npm ci --include=dev` | 1 | `E500` from the registry through the egress proxy |
| `npx --no-install tsc --noEmit` | 124 | `tsc` absent, `npx` blocks on the registry |
| `npx --no-install @biomejs/biome@2 check .` | 124 | `biome` absent for the same reason |
| `node scripts/run-tests.mjs` | 1 | `ERR_MODULE_NOT_FOUND` for `tsx` |
