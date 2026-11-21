# Push notifications

pi-ui sends one notification per event. The menu's **Notifications** switch is
the only thing that subscribes this browser, and a registry row remembers which
device class and display mode asked for the channel.

## One subscription per device class

A browser profile has one push subscription and one service-worker registration
per origin. An installed PWA on that profile shares both with the ordinary tab,
so switching notifications off in the Brave tab switches them off in the
installed app immediately. There is no separate tab channel and app channel to
toggle. Enabling notifications in the tab therefore takes the phone's channel
until the installed app is enabled again; the newest explicit subscribe wins.
pi-ui does not emulate a per-context switch with a server-side mute map. That
would be a second source of truth for a channel the browser only has one of, and
the simple rule below is enough. No mute file, no localStorage id and no extra
endpoint are involved.

`DATA_DIR/push-subscriptions.json` stays version 1. A record may carry a
`client` block:

```json
{ "device": "mobile", "mode": "app" }
```

- `device` is derived on the server from the request `User-Agent`: `mobile` for
  `Mobile`, `Android`, `iPhone` or `iPad`, otherwise `desktop`.
- `mode` is reported by the page: `app` when it matches
  `(display-mode: standalone)` or iOS reports `navigator.standalone`, otherwise
  `browser`.

On a subscribe that carries a valid `client`, the store evicts every other
record of the same `device` before inserting the new one and returns how many
records it replaced. Desktop and mobile never evict each other, so a phone and a
laptop both ring. Two phones of the same class collapse to the newest subscribe;
that is accepted. The same eviction drops records that carry no `client` block,
because an unattributed record cannot be routed to a device class. This makes
the upgrade self-healing: an old Brave/PWA pair, or a stale endpoint left by a
rotation, collapses on the first toggle after deploy. An unattributed desktop
record is dropped too and returns the next time that browser enables
notifications.

A body without a `client` block behaves as it always did and fans out to every
stored endpoint, which keeps the test fixtures and older clients working. A
malformed `client` block is ignored rather than dropping the record.

Only the explicit toggle posts a subscription. Opening the tab does not re-post
the existing subscription, so passively opening the Brave tab can never take the
channel from the installed app. Turning notifications off unsubscribes the
browser's shared registration and deletes that endpoint; that removal is global
to the registration and is expected.

`GET /api/push/status` lists each record's `device` and `mode`, never the
endpoint or keys, so a curl shows whether the phone holds one record or two.
`notify()` still fans out to the survivors, drops an endpoint on `404` or `410`,
logs and swallows any other delivery failure, and keeps the test-mode guard.

## Clearing an old registry

The first subscribe after upgrading performs the cleanup. To do it by hand,
toggle notifications **off** and **on** once in the installed app. The registry
then holds one mobile record, and the next event shows one banner.
