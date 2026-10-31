# MCP events

`@realmikekelly/pi-mcp-events` keeps its subscription list in memory. pi-ui
mirrors that list in `McpEventFeed`, which backs `mcpEvents` in `GET /api/state`
and the MCP widgets on the stats page. The feed reads the real cursor from
`event.data.cursor` first and falls back to `event.cursor`, because the hub sends
`"cursor": null` on the envelope and puts the position in the payload.

## Restart behaviour

`DATA_DIR/mcp-subscriptions.json` is the durable registry. It is one JSON
document with `version: 1` and one entry per `(server, name, sortKey(arguments))`.
An entry holds the adapter `id`, the durable `stableId`, `cursor`, `status`,
`enabled`, the last 1,000 `deliveredEventIds`, and `updatedAt`. The `stableId`
is derived from the server, stream name and sorted arguments, so it survives a
restart and does not depend on argument order: the common no-arguments form is
`zeroshot/hub`, and arguments add a short canonical digest. The adapter `id`
still changes when the process subscribes again.

A 1.6.7 registry has none of the new fields. Loading it derives the stable id,
sets the adapter id to null, derives `enabled` from the status, and writes the
upgraded document once. Writes go to a temporary file in the same directory and
are renamed into place, at most once per second; shutdown forces a final flush.
A missing file, a corrupt file or an unknown version is logged once and
treated as an empty registry, never as a boot failure.

Once the MCP adapter is ready, and before the first turn, every entry whose
status is `active` or `reconnecting` is subscribed again through the
extension's own subscribe path with its stored cursor. Each success logs one
line, `mcp: restored subscription <server>/<name> at <cursor>`. If a server is
unavailable, its entry stays in the registry and is retried when that server
answers again.

A restart therefore starts from the last cursor instead of `null` ("start from
now" for a fresh subscription). If the hub still re-delivers part of its
retained window, the feed first checks the persisted event ids for the stable
id. An id already delivered before this process started is stored with
`replayed: true`, does not change the chat notice, and is not submitted to the
model. For an upgraded or cursor-only entry the feed also treats an event at or
below the restored subscription's `hub:<n>` high-water mark as a replay.
`hub:snapshot:a:b` and other cursors are opaque: they are stored, never
compared. A duplicate of an event first delivered live is dropped after that
one live delivery. A replay-only flush is not an extension message, so no turn
is started. A mixed flush keeps the new events and reports
`replayed N event(s) from <server>, skipped`.

`GET /api/state` carries both identities in `mcpEvents.subscriptions[]`: `id`
(the current adapter id) and `stableId`. The feed keeps one visible row per
stable id, but remembers every adapter id that ever represented it. The events
page and the MCP widgets use a title when one exists and otherwise show the
stable id. `DELETE /api/mcp/subscriptions/<stableId>` stops every live adapter
stream for that identity, marks the durable entry `cancelled` with
`enabled: false`, and is idempotent. A late status notice for the cancelled
adapter id cannot turn the entry back on; a genuinely new subscribe gets a new
adapter id and replaces it. A cancelled entry is not subscribed again on the
next boot.
