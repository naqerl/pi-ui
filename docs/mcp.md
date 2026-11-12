# MCP events

`@realmikekelly/pi-mcp-events` keeps its subscription list in memory. pi-ui
mirrors that list in `McpEventFeed`, which backs `mcpEvents` in `GET /api/state`
and the MCP widgets on the stats page. The feed reads the real cursor from
`event.data.cursor` first and falls back to `event.cursor`, because the hub sends
`"cursor": null` on the envelope and puts the position in the payload.

## Restart behaviour

`DATA_DIR/mcp-subscriptions.json` is the durable registry. It is one JSON
document with `version: 1` and one entry per `(server, name, sortKey(arguments))`.
An entry holds the adapter `id`, the durable `stableId`, the server
`generation`, `cursor`, `status`, `enabled`, the last 1,000
`deliveredEventIds`, and `updatedAt`. The `stableId` is derived from the
server, stream name and sorted arguments, so it survives a restart and does
not depend on argument order: the common no-arguments form is `zeroshot/hub`,
and arguments add a short canonical digest. The adapter `id` still changes
when the process subscribes again.

The hub cursor is a per-daemon counter, so a hub restart starts at `hub:1`
again. A subscribe therefore captures a `generation`: the hub's
`GET /v1/hub/daemon` `startedAt` and `pid` when it states one, otherwise the
adapter's session identity. Event keys and outbox dedupe keys include that
generation, so `hub:1000` from the new daemon is not the `hub:1000` already
delivered by the old one. The runtime refreshes the generation whenever the
adapter opens a replacement protocol connection, before that connection can
emit a renumbered event, as well as on subscribe/list/restore. A changed
generation drops that `stableId`'s seen ids and waiting outbox entries before
the new stream is accepted; other subscriptions keep theirs. Delivery items
carry the generation too, so an outbox merge cannot fold a new epoch into an
old pending text with the same cursor. Servers that state no generation, and
rows written before this field existed, keep the original two-part key.

A 1.6.7 registry has none of the new fields. Loading it derives the stable id,
sets the adapter id to null, derives `enabled` from the status, and writes the
upgraded document once. Writes go to a temporary file in the same directory and
are renamed into place, at most once per second; shutdown forces a final flush.
A missing file, a corrupt file or an unknown version is logged once and
treated as an empty registry, never as a boot failure.

Once the MCP adapter is ready, and before the first turn, every entry whose
status is `active` or `reconnecting` is subscribed again through the
extension's own subscribe path with its stored cursor. Before opening a stream,
pi-ui asks the server whether that cursor still belongs to a live subscription
with an `events/poll` probe; a server that does not implement the probe is
checked through `events/list`. A `NotFound` (`-32023`) or unknown stream marks
the row `cancelled`, persists it, logs `mcp: dropped restored subscription …`,
and never retries it in this process. If the cursor probe would replay a
backlog whose first event predates this process by more than a 15-minute grace
window, the restore subscribes with `cursor: null` and records one gap
(`from`, `missedSince` from `lastEventAt`, and `at`) instead of replaying it.
The gap reaches chat as a single “N events were missed while pi was not
running” status chip. A recent backlog — the ordinary “pi restarted a moment
ago” case — still replays from its stored cursor. The paged-catalog fallback
also keeps its recovered cursor, because that is a position rather than a
backlog.

The same grace is applied per event to every batch that arrives on a stream,
not only to what the cursor probe predicts. An adapter that reconnects can hand
over its own buffered backlog; an event older than the grace is counted as
dropped, kept out of the queue and never delivered, while a fresh sibling in
the same batch is delivered normally. The “N older events dropped from this
batch” line and the debug log keep the drop visible. An event without a usable
timestamp cannot be judged, so it is delivered as before and logged.

Each successful restore logs one line,
`mcp: restored subscription <server>/<name> at <cursor>`. If a server is
unavailable, its entry stays in the registry and is retried when that server
answers again.

A restart therefore starts from the last cursor instead of `null` ("start from
now" for a fresh subscription). If the hub still re-delivers part of its
retained window, the feed first checks the persisted event ids for the stable
id. An id already delivered before this process started is stored with
`replayed: true`, does not change the chat notice, and is not submitted to the
model. The feed also records the process boot time once and treats any event
whose timestamp predates it as replay even when the adapter reports
`replayed: false`, which covers a cursor the server no longer honours.

For an upgraded or cursor-only entry the feed also treats an event at or
below the restored subscription's `hub:<n>` high-water mark as a replay.
`hub:snapshot:a:b` and other cursors are opaque: they are stored, never
compared. A duplicate of an event first delivered live is dropped after that
one live delivery. A replay-only flush is not an extension message, so no turn
is started. A mixed flush keeps the new events and reports
`replayed N event(s) from <server>, skipped`.

`GET /api/state` carries both identities in `mcpEvents.subscriptions[]`: `id`
(the current adapter id) and `stableId`. The feed keeps one visible row per
stable id, but remembers every adapter id that ever represented it. The events
page and the MCP widgets use a title when one exists; a stream with arguments
falls back to its stable id, while a no-argument stream shows its name.
`DELETE /api/mcp/subscriptions/<stableId>` stops every live adapter
stream for that identity, marks the durable entry `cancelled` with
`enabled: false`, and is idempotent. A late status notice for the cancelled
adapter id cannot turn the entry back on; a genuinely new subscribe gets a new
adapter id and replaces it. A cancelled entry is not subscribed again on the
next boot.

## Stream health

Cursors are opaque. Every ingest path stores the cursor the server returned,
even when it moves backwards, when `truncated` is true, or when the result has
no events; event ids, not cursor numbers, decide whether a frame was already
delivered. Each row also carries `lastEventAt` (the last pushed event),
`lastHeartbeatAt` (the keepalive that proves the push stream itself is alive),
`lastPollAt`, `lastError` and `lastErrorAt`. A poll only proves the cursor and
never counts as stream traffic or overwrites `lastEventAt`.

The watchdog checks every 15 seconds. A push stream that delivers no event and
no heartbeat for 60 seconds (three heartbeat intervals) is marked `stalled`
and reopened from its persisted cursor. The row reads `recovering` while that
unsubscribe + subscribe runs. A successful re-open stays `active`, but its
recovery is not confirmed until the first heartbeat or pushed event; without
one the next silence window counts as a failed recovery. Two failed recoveries
mark it `dead`, stop timer retries for that row and leave the reason visible.
`state` is one of `active`, `stalled`, `recovering`, `dead` or `cancelled` on
every subscription. The MCP status card and the events page paint `stalled`
and `dead` rows in the warning colour and show `lastError` or
`lastReconnectReason`, so a quiet stream cannot look healthy.

For a test or a small deployment the defaults can be shortened with
`PI_MCP_WATCHDOG_INTERVAL_MS`, `PI_MCP_HEARTBEAT_INTERVAL_MS` (the stall limit
becomes three of these unless overridden) and `PI_MCP_STALL_MS`. A successful
protocol connection also clears every stale boot failure for that server, so
availability is recomputed from the latest observation rather than a
write-once list.

### Reliable event delivery

Event IDs, not `replayed` provenance, determine novelty. Age is a separate
gate: an event older than the restore grace is not news, however unfamiliar its
id. The durable delivered set means one thing only: a notice for that id was
submitted and its chip was committed. Merely seeing an id — a duplicate push, adapter
status metadata or a replay entry — never enters that set. `replayed: true` is a
display fact, not a delivery decision, so a replayed entry that never produced a
chip is offered again on the next drain with its original timestamp and cursor.

Before a push batch advances its stored cursor, its exact novel subset is
atomically saved in `DATA_DIR/mcp-outbox.json`. Pending batches retry FIFO and
survive restart. Each delivery uses the same durable `requestId` on every
attempt, including a crash after submission but before removing the pending
record. A failed submission therefore leaves the id novel and the chip pending;
the successful retry commits it exactly once. The outbox keeps the newest 500
accepted event identities per `stableId` (trimmed and persisted on every
write); the subscription registry also retains its per-stream delivered-ID
window. Providers must supply stable event IDs. Retention is bounded, not an
infinite replay ledger.

Startup recovery resumes from the stored push cursor when that backlog is
recent; an old backlog starts from now and reports one gap instead. Poll
probes, heartbeats, and status frames do not acknowledge events. A provider
that can no longer replay a cursor reports `truncated` through the installed
event adapter; its “replay is truncated … some events are unavailable” warning
now reaches a persistent chat status chip instead of a no-op UI notification.
A restored stream stays capped for its first 15 minutes: a replayed burst
produces at most one merged event chip per batch, plus one gap chip for events
beyond `MAX_PENDING_MCP_EVENTS`, so a continuous replay cannot outrun the
outbox merger. Unknown streams remain failures; no undocumented cursor reset is
guessed.

Live delivery uses bounded idle batches and per-event busy deliveries with the existing queued-burst merger,
not the old in-memory ten-minute coalescer. This keeps retry/restart identity
stable without persisting mutable coalescer state. Filesystem persistence errors
retry FIFO and prevent later batches from overtaking the unacknowledged push cursor. Keep the data directory on
persistent storage along with the conversation database.
