import { subscriptionHealth, subscriptionLabel } from "../shared/dashboard";
import { formatTime } from "../shared/time";
import type { McpEventsState, McpStatus, McpSubscriptionView } from "../shared/types";
import { PiMenu } from "./PiMenu";

function SubscriptionRow({ subscription }: { subscription: McpSubscriptionView }) {
  const health = subscriptionHealth(subscription);
  const live = health === "active";
  const warning = health === "stalled" || health === "recovering" || health === "dead";
  const reason =
    subscription.lastError ?? subscription.lastReconnectReason ?? subscription.endReason;

  const label = subscriptionLabel(subscription);
  return (
    <div
      className="flex flex-wrap items-baseline gap-xl border-b border-border py-xl font-mono text-xs"
      data-state={health}
      data-subscription-id={subscription.id}
      {...(subscription.id.startsWith("config:") ? { "data-testid": "subscription-declared" } : {})}
    >
      <span
        className={
          warning ? "text-status-warn" : live ? "text-foreground" : "text-muted-foreground"
        }
      >
        {subscription.server}
      </span>
      <span
        className="min-w-0 flex-1 truncate text-muted-foreground"
        data-testid="subscription-title"
        title={subscription.title === undefined ? subscription.name : undefined}
      >
        {label}
      </span>
      {subscription.cursor !== null && (
        <span
          className="max-w-[16ch] shrink-0 truncate text-muted-foreground"
          title={`cursor ${subscription.cursor}`}
          data-testid="subscription-cursor"
        >
          {subscription.cursor}
        </span>
      )}
      <span
        className={warning ? "shrink-0 text-status-warn" : "shrink-0 text-muted-foreground"}
        data-testid="subscription-state"
      >
        {health}
      </span>
      {warning && reason !== undefined && (
        <span className="min-w-0 text-status-warn" data-testid="subscription-reason" title={reason}>
          {reason}
        </span>
      )}
    </div>
  );
}

export function EventsView({
  events,
  ready,
  status,
}: {
  events: McpEventsState;
  ready: boolean;
  status?: McpStatus;
}) {
  const health = events.subscriptions.map((subscription) => subscriptionHealth(subscription));
  const live = events.subscriptions.filter((_subscription, index) => health[index] === "active");
  const attention = events.subscriptions.filter((_subscription, index) => {
    const state = health[index];
    return state === "stalled" || state === "recovering" || state === "dead";
  });
  const config = status?.subscriptionConfig;
  const declared = config?.entries ?? [];
  const declaredLive = declared.filter((entry) => entry.state === "live").length;
  const declaredWaiting = declared.length - declaredLive;

  const feedStableIds = new Set(events.subscriptions.map((subscription) => subscription.stableId));
  const synthetic: McpSubscriptionView[] = declared
    .filter((entry) => entry.state !== "live" && !feedStableIds.has(entry.stableId))
    .map((entry) => ({
      id: `config:${entry.stableId}`,
      stableId: entry.stableId,
      server: entry.server,
      name: entry.name,
      ...(entry.title === undefined ? {} : { title: entry.title }),
      status: "pending",
      state: "recovering",
      arguments: entry.arguments,
      cursor: null,
      lastError: entry.state === "missing-server" ? "server not configured" : "waiting to open",
    }));
  const rows = [...events.subscriptions, ...synthetic];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="float-page mx-auto">
        <header className="w-fit max-w-full theme-radius border border-border bg-surface">
          <div className="flex items-center gap-xl px-xl py-md">
            <PiMenu />
            <a
              href="/"
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              Back to chat
            </a>
          </div>
        </header>
      </div>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[72ch] px-2xl py-2xl">
          <h1 className="mb-lg text-sm font-medium">MCP subscriptions</h1>
          <p className="mb-2xl text-xs text-muted-foreground">
            {live.length === 0
              ? attention.length === 0
                ? "No live subscriptions."
                : `${attention.length} subscription${attention.length === 1 ? "" : "s"} need attention.`
              : `${live.length} live.${attention.length === 0 ? "" : ` ${attention.length} need attention.`} Updates below are the same on every open client.`}
          </p>

          {!ready && <p className="font-mono text-xs text-muted-foreground">Loading…</p>}

          {config !== undefined && (
            <div
              className="theme-radius mb-2xl border border-border bg-surface px-xl py-lg font-mono text-xs"
              data-testid="subscription-config"
            >
              {config.error !== undefined ? (
                <span className="text-status-warn">{config.error}</span>
              ) : (
                <span className="text-muted-foreground">
                  {config.present
                    ? `Declared in subscriptions.json: ${declared.length} (${declaredLive} live, ${declaredWaiting} waiting)`
                    : "No subscriptions.json; no event streams declared."}
                </span>
              )}
              {config.writeError !== undefined && (
                <span className="ml-lg text-status-warn">{config.writeError}</span>
              )}
            </div>
          )}

          <div>
            {rows.map((subscription) => (
              <SubscriptionRow key={subscription.id} subscription={subscription} />
            ))}
          </div>
          <p className="theme-radius mt-lg border border-border bg-surface px-xl py-lg text-xs text-muted-foreground">
            Deleting a stream removes its line from subscriptions.json; it does not come back after
            a restart.
          </p>

          <h2 className="mt-2xl mb-lg text-sm font-medium">Updates</h2>
          {events.notice && (
            <p className="mb-xl font-mono text-xs text-foreground" data-testid="mcp-event-notice">
              {events.notice}
            </p>
          )}
          {ready && events.events.length === 0 && (
            <p className="font-mono text-xs text-muted-foreground">No events yet.</p>
          )}
          <div className="space-y-xl">
            {[...events.events].reverse().map((event) => (
              <article key={event.id} className="theme-radius border border-border px-xl py-lg">
                <div className="font-mono text-[11px] text-muted-foreground">
                  {formatTime(event.timestamp)} · new event from {event.server}
                </div>
                <div className="mt-sm font-mono text-xs">{event.name}</div>
                {event.summary.length > 0 && (
                  <pre className="mt-lg whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted-foreground">
                    {event.summary}
                  </pre>
                )}
              </article>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
