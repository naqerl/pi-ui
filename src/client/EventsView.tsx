import { subscriptionHealth, subscriptionLabel } from "../shared/dashboard";
import { formatTime } from "../shared/time";
import type { McpEventsState, McpSubscriptionView } from "../shared/types";
import { PiMenu } from "./PiMenu";

function SubscriptionRow({ subscription }: { subscription: McpSubscriptionView }) {
  const health = subscriptionHealth(subscription);
  const live = health === "active";
  const warning = health === "stalled" || health === "recovering" || health === "dead";
  const reason =
    subscription.lastError ?? subscription.lastReconnectReason ?? subscription.endReason;
  // The stable id is the cancellable identity. A title is only a friendlier
  // label; without one the id itself must be visible here.
  const label = subscriptionLabel(subscription);
  return (
    <div
      className="flex flex-wrap items-baseline gap-3 border-b border-border py-3 font-mono text-xs"
      data-state={health}
    >
      <span
        className={warning ? "text-amber-600" : live ? "text-foreground" : "text-muted-foreground"}
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
        className={warning ? "shrink-0 text-amber-600" : "shrink-0 text-muted-foreground"}
        data-testid="subscription-state"
      >
        {health}
      </span>
      {warning && reason !== undefined && (
        <span className="min-w-0 text-amber-600" data-testid="subscription-reason" title={reason}>
          {reason}
        </span>
      )}
    </div>
  );
}

export function EventsView({ events, ready }: { events: McpEventsState; ready: boolean }) {
  const health = events.subscriptions.map((subscription) => subscriptionHealth(subscription));
  const live = events.subscriptions.filter((_subscription, index) => health[index] === "active");
  const attention = events.subscriptions.filter((_subscription, index) => {
    const state = health[index];
    return state === "stalled" || state === "recovering" || state === "dead";
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="float-page mx-auto">
        <header className="w-fit max-w-full theme-radius border border-border bg-surface">
          <div className="flex items-center gap-3 px-3 py-1.5">
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
        <div className="mx-auto w-full max-w-[72ch] px-4 py-6">
          <h1 className="mb-2 text-sm font-medium">MCP subscriptions</h1>
          <p className="mb-4 text-xs text-muted-foreground">
            {live.length === 0
              ? attention.length === 0
                ? "No live subscriptions."
                : `${attention.length} subscription${attention.length === 1 ? "" : "s"} need attention.`
              : `${live.length} live.${attention.length === 0 ? "" : ` ${attention.length} need attention.`} Updates below are the same on every open client.`}
          </p>

          {!ready && <p className="font-mono text-xs text-muted-foreground">Loading…</p>}

          <div>
            {events.subscriptions.map((subscription) => (
              <SubscriptionRow key={subscription.id} subscription={subscription} />
            ))}
          </div>

          <h2 className="mt-8 mb-2 text-sm font-medium">Updates</h2>
          {events.notice && (
            <p className="mb-3 font-mono text-xs text-foreground" data-testid="mcp-event-notice">
              {events.notice}
            </p>
          )}
          {ready && events.events.length === 0 && (
            <p className="font-mono text-xs text-muted-foreground">No events yet.</p>
          )}
          <div className="space-y-3">
            {[...events.events].reverse().map((event) => (
              <article key={event.id} className="theme-radius border border-border px-3 py-2">
                <div className="font-mono text-[11px] text-muted-foreground">
                  {formatTime(event.timestamp)} · new event from {event.server}
                </div>
                <div className="mt-1 font-mono text-xs">{event.name}</div>
                {event.summary.length > 0 && (
                  <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted-foreground">
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
