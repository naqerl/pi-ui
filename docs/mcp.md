# MCP events

`@realmikekelly/pi-mcp-events` keeps its subscription list in memory. pi-ui
mirrors that list in `McpEventFeed`, which backs `mcpEvents` in `GET /api/state`
and the MCP widgets on the stats page. The feed reads the real cursor from
`event.data.cursor` first and falls back to `event.cursor`, because the hub sends
`"cursor": null` on the envelope and puts the position in the payload.

## Restart behaviour

`DATA_DIR/mcp-subscriptions.json` is the durable registry. It is one JSON
document with `version: 1` and one entry per `(server, name, JSON.stringify(arguments))`
holding `cursor`, `status` and `updatedAt`. Writes go to a temporary file in the
same directory and are renamed into place, at most once per second; shutdown
forces a final flush. A missing file, a corrupt file or an unknown version is
logged once and treated as an empty registry, never as a boot failure.

Once the MCP adapter is ready, and before the first turn, every entry whose
status is `active` or `reconnecting` is subscribed again through the
extension's own subscribe path with its stored cursor. Each success logs one
line, `mcp: restored subscription <server>/<name> at <cursor>`. If a server is
unavailable, its entry stays in the registry and is retried when that server
answers again.

A restart therefore starts from the last cursor instead of `null` ("start from
now" for a fresh subscription). If the hub still re-delivers part of its
retained window, the feed compares each `hub:<n>` cursor with the subscription's
numeric high-water mark and drops events at or below it. `hub:snapshot:a:b` and
other cursors are opaque: they are stored, never compared. A flush that contains
only replayed events changes neither `notice` nor `revision`, and its extension
message is not submitted, so no turn is started. A mixed flush keeps the new
events and reports `replayed N event(s) from <server>, skipped`.
