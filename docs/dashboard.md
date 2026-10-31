# Dashboard

The page left of the chat (`?page=stats`) is a dashboard the agent can edit. It
starts with the old stats cards (context, tokens, MCP servers) plus an MCP events
list, and the agent adds, moves and removes widgets with five tools. The chat
header shows no MCP status; these two widgets replace it. Widgets only show data: the page never
renders HTML or JS from a widget and there are no action buttons.

## Files

- `DATA_DIR/dashboard.json`: widgets and layout. It holds scripts, never tokens.
  Missing or invalid JSON falls back to the default stats widgets. `seeded`
  records which set of default widgets the file has been given (currently `2`).
  A file from an older pi-ui gets the defaults added since then once, on load:
  seed 2 adds `mcp-events` after the `mcp` widget. A default removed after that
  stays removed, because `seeded` already covers it.
- `DATA_DIR/dashboard-state.json`: the last value, error and history of each
  poll and static widget, so the page shows something right after a restart.

`GET /api/dashboard` returns widgets (poll scripts stripped), layout, values,
the builtin `jobs` and `session` data, and `polling`. Changes go to every open
client as a `dashboard` event on the stream. `DELETE /api/dashboard/widgets/:id`
is what the card menu calls.

## Tools

| Tool               | Arguments                                      | Does                                                                                                                                                        |
| ------------------ | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dashboard_get`    | none                                           | Sections, widget configs, last values, errors and whether polling is on.                                                                                    |
| `dashboard_upsert` | `id`, `title`, `kind`, `source`, `mapping`     | Adds or replaces a widget, runs it once and returns `{view, error, sample, logs, notes, polling}` so the agent can fix the mapping or script and try again. |
| `dashboard_remove` | `id`                                           | Removes a widget and its slot.                                                                                                                              |
| `dashboard_push`   | `id`, `data`                                   | Sends data to a `static` widget and renders it.                                                                                                             |
| `dashboard_layout` | `sections: [{title?, widgets: [{id, span?}]}]` | Orders widgets into titled sections. `span` is `full`, `half` or `third` on wide screens; phones show one column. Widgets left out go to a final section.   |

There is no refresh tool: poll widgets refresh on their own while someone looks
at the page.

## Sources

- `{"type": "builtin", "name": …}`: live pi-ui data.
  - `context`: `tokens`, `window`, `percent`, `text`
  - `tokens`: `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, `cost`, `costText`, `rows[]` (`key`, `label`, `value`)
  - `cache`: `read`, `write`, `hitRate`, `hitPercent`, `text`
  - `mcp`: `count`, `unavailable`, `servers[]` (`key`, `name`, `available`, `authRejected`, `tools`, `subscriptions` (live subscription titles, or their stable ids when no title exists), `state`, `detail`). An available server's `detail` is its tool count (`no tools`, `1 tool`, `4 tools`); other rows are `auth rejected` or `unavailable · <reason>`. A live subscription is appended as ` · subscribed: <titles or stable ids>`.
  - `mcp_events`: `total`, `live` (servers with a live subscription), `latest`, `events[]` (the last 3, newest first: `key`, `id`, `server`, `name`, `timestamp`, `time`, `summary`, `label`, `value`, and `replayed: true` only when it is a replay), `subscriptions[]` (`key`, `id`, `stableId`, `server`, `name`, `title`, `status`, `label`, `state`, `detail`; the label is the title, or `stableId` when the title is absent)
  - `jobs`: `total`, `running`, `jobs[]` (`id`, `name`, `status`, `exitCode`, `label`, `state`, `detail`, …)
  - `session`: `conversationId`, `model`, `run`, `rows[]`
- `{"type": "poll", "script": "…", "intervalSec": 60, "timeoutSec": 10}`: the
  script is the body of an async function that gets `fetch`, `env`, `prev` (the
  last result) and `log(...)`, and returns JSON.
- `{"type": "static"}`: data the agent sends with `dashboard_push`.

### How polls run

- Each run is a fresh worker thread with only `fetch`, `env`, `prev` and
  `log`. It cannot reach the server's state, and a busy loop is cut off at the
  timeout without stalling the server.
- `intervalSec` is at least 30 (default 60). `timeoutSec` is 1 to 30 (default
  10). A result over 128 KB is an error, so return only what the widget shows.
  At most 10 poll widgets.
- Polls run only while some client has the page open and visible. The page
  reports itself every 20 s and when it is hidden or closed; a client that goes
  silent counts as gone after 45 s.
- A failed run keeps the last good value and shows a `stale` badge (`error`
  if there was never a good value). After 5 failures in a row the interval
  doubles each time, up to an hour, and the agent gets one queued message with
  the error. One success resets this.
- `env` is the server's environment. Put tokens there and read them from
  `env`; never write them into a script. Strings that look like tokens
  (`Bearer …` and other auth headers, `ghp_…`, `sk-…`, `xoxb-…` and similar
  prefixes, JWTs, long mixed-case runs, and the value of any env var whose name
  has `TOKEN`, `SECRET`, `PASSW`, `API_KEY`, `AUTH` and the like) are masked as
  `••••` before a value is stored or shown, including in `prev` and `log`
  lines. Plain hex such as hashes and ids is left alone.

## Kinds and mapping

Mapping values are paths into the source data: `a.b`, `servers[].name` (one
value per element), `items[0]`, `items[-1]`, `list.length`, `$` for the whole
value. A value starting with `=` is a literal: `"label": "=servers"`. A path
that matches nothing is an error, with a sample of the data, so a typo shows up
in `dashboard_upsert`.

| Kind        | Fields (* required)                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stat`      | `value`*, `label`, `delta` (number or `+3`, draws a trend arrow), `unit`, `progress` (0 to 100 meter)                                                         |
| `list`      | `items`* (array), `key`, `label`, `value` (relative to each item), `empty`                                                                                    |
| `table`     | `columns`* (`{"Header": "path"}`), `rows` (array; column paths are then relative to each row), `empty`                                                        |
| `sparkline` | `value` (a number; its history is drawn) or `series` (array of numbers), `label`                                                                              |
| `markdown`  | `text`* (raw HTML shows as text)                                                                                                                              |
| `status`    | `items` with `label`, `state`, `detail`, `key`; or one `state`* and `label`. `ok`/`running`/`up` are green, `warn`/`off`/`starting` amber, anything else red. |

## Example: live ExampleCloud servers

Give the container the token (in `docker-compose.yml` under `environment`):

```yaml
HCLOUD_TOKEN: "${HCLOUD_TOKEN}"
```

Then ask the agent for a "Live servers" table and the monthly cost. It calls:

```json
{
  "id": "example-cloud-servers",
  "title": "Live servers",
  "kind": "table",
  "source": {
    "type": "poll",
    "intervalSec": 60,
    "script": "const res = await fetch(\"https://api.example-cloud.cloud/v1/servers\", {\n  headers: { Authorization: `Bearer ${env.HCLOUD_TOKEN}` },\n});\nif (!res.ok) throw new Error(`ExampleCloud API ${res.status}`);\nconst { servers } = await res.json();\nreturn servers.map((s) => ({\n  name: s.name,\n  status: s.status,\n  type: s.server_type.name,\n  ip: s.public_net.ipv4.ip,\n}));"
  },
  "mapping": {
    "rows": "$",
    "columns": {
      "Name": "name",
      "Status": "status",
      "Type": "type",
      "IP": "ip"
    }
  }
}
```

```json
{
  "id": "example-cloud-cost",
  "title": "ExampleCloud monthly cost",
  "kind": "stat",
  "source": {
    "type": "poll",
    "intervalSec": 300,
    "script": "const res = await fetch(\"https://api.example-cloud.cloud/v1/servers\", {\n  headers: { Authorization: `Bearer ${env.HCLOUD_TOKEN}` },\n});\nif (!res.ok) throw new Error(`ExampleCloud API ${res.status}`);\nconst { servers } = await res.json();\nconst total = servers.reduce((sum, s) => {\n  const price = s.server_type.prices.find((p) => p.location === s.datacenter.location.name) ?? s.server_type.prices[0];\n  return sum + Number(price.price_monthly.gross);\n}, 0);\nreturn { total: `€${total.toFixed(2)}`, servers: `${servers.length} servers` };"
  },
  "mapping": { "value": "total", "label": "servers" }
}
```

and places them:

```json
{
  "sections": [
    {
      "title": "ExampleCloud",
      "widgets": [
        { "id": "example-cloud-cost", "span": "third" },
        { "id": "context", "span": "third" },
        { "id": "tokens", "span": "third" },
        { "id": "example-cloud-servers", "span": "full" }
      ]
    },
    { "title": "Agent", "widgets": [{ "id": "mcp", "span": "full" }] }
  ]
}
```

The cost is the sum of each server type's monthly gross price; it leaves out
traffic, volumes, backups and primary IPs.

`e2e/dashboard.e2e.ts` runs these widgets against a fake ExampleCloud endpoint in
`e2e/fake-model.mjs`, never the real API.

## Tests

- `e2e/dashboard.test.ts` (in `npm test`): paths, rendering of each kind,
  mapping errors, masking, the poll worker (fetch, env, prev, log, timeout,
  crash, size cap), visible-only polling, backoff and its single notice, tool
  validation and persistence.
- `e2e/dashboard.e2e.ts`: the fake model builds the ExampleCloud widgets and layout,
  which render at 1280 and 390 px; polling stops when the page is left and
  starts again on return; the card menu removes a widget.
- `PI_DASHBOARD_MIN_INTERVAL_MS` lowers the 30 s minimum. It is meant for tests.
