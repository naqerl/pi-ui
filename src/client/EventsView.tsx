import type { McpEventsState, McpSubscriptionView } from "../shared/types";
import { PiMenu } from "./PiMenu";

const LIVE_STATUS = new Set(["opening", "active", "reconnecting"]);

function formatTime(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return timestamp;
  return new Date(parsed).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function SubscriptionRow({ subscription }: { subscription: McpSubscriptionView }) {
  const live = LIVE_STATUS.has(subscription.status);
  return (
    <div className="flex items-baseline gap-3 border-b border-border py-3 font-mono text-xs">
      <span className={live ? "text-foreground" : "text-muted-foreground"}>
        {subscription.server}
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{subscription.name}</span>
      {subscription.cursor !== null && (
        <span
          className="max-w-[16ch] shrink-0 truncate text-muted-foreground"
          title={`cursor ${subscription.cursor}`}
          data-testid="subscription-cursor"
        >
          {subscription.cursor}
        </span>
      )}
      <span className="shrink-0 text-muted-foreground">{subscription.status}</span>
    </div>
  );
}

export function EventsView({ events, ready }: { events: McpEventsState; ready: boolean }) {
  const live = events.subscriptions.filter((subscription) => LIVE_STATUS.has(subscription.status));

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
              ? "No live subscriptions."
              : `${live.length} live. Updates below are the same on every open client.`}
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
