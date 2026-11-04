import { useMemo, useState } from "react";
import { subscriptionHealth, subscriptionLabel } from "../shared/dashboard";
import { formatTime } from "../shared/time";
import type { McpEventsState, McpEventView, McpSubscriptionView } from "../shared/types";
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

function subscriptionTopic(subscription: McpSubscriptionView | undefined): string | undefined {
  const topic = subscription?.arguments.topic;
  return typeof topic === "string" && topic.trim().length > 0 ? topic : undefined;
}

/** An event's own topic wins; an older event can still borrow its subscription's topic. */
function eventTopic(
  event: McpEventView,
  subscription: McpSubscriptionView | undefined,
): string | undefined {
  const own = event.topic;
  if (typeof own === "string" && own.trim().length > 0) return own;
  return subscriptionTopic(subscription);
}

interface EventPresentation {
  label: string;
  topic?: string;
  /** Events collected before topics existed keep the old "new event from" text. */
  legacy: boolean;
}

function presentEvent(
  event: McpEventView,
  subscriptions: ReadonlyMap<string, McpSubscriptionView>,
): EventPresentation {
  const subscription =
    event.subscriptionId === undefined ? undefined : subscriptions.get(event.subscriptionId);
  if (subscription !== undefined) {
    return {
      label: subscriptionLabel(subscription),
      topic: eventTopic(event, subscription),
      legacy: false,
    };
  }
  if (event.subscriptionId === undefined) {
    return {
      label: `new event from ${event.server}`,
      topic: eventTopic(event, undefined),
      legacy: true,
    };
  }
  // The subscription disappeared or predates this feed: the server is the honest fallback.
  return {
    label: event.server,
    topic: eventTopic(event, undefined),
    legacy: false,
  };
}

interface EventGroup extends EventPresentation {
  events: McpEventView[];
}

const chipClass = (active: boolean) =>
  `theme-radius inline-flex min-h-8 items-center gap-1.5 border px-2.5 py-1 font-mono text-[11px] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground/40 ${
    active
      ? "border-foreground/30 bg-foreground text-background"
      : "border-border bg-surface text-muted-foreground hover:bg-muted hover:text-foreground"
  }`;

export function EventsView({ events, ready }: { events: McpEventsState; ready: boolean }) {
  const [selected, setSelected] = useState<string | null>(null);
  const health = events.subscriptions.map((subscription) => subscriptionHealth(subscription));
  const live = events.subscriptions.filter((_subscription, index) => health[index] === "active");
  const attention = events.subscriptions.filter((_subscription, index) => {
    const state = health[index];
    return state === "stalled" || state === "recovering" || state === "dead";
  });

  const subscriptions = useMemo(
    () => new Map(events.subscriptions.map((subscription) => [subscription.id, subscription])),
    [events.subscriptions],
  );
  const counts = useMemo(() => {
    const bySubscription = new Map<string, number>();
    for (const event of events.events) {
      if (event.subscriptionId === undefined) continue;
      bySubscription.set(event.subscriptionId, (bySubscription.get(event.subscriptionId) ?? 0) + 1);
    }
    return bySubscription;
  }, [events.events]);

  const visible = events.events.filter(
    (event) => selected === null || event.subscriptionId === selected,
  );
  // The feed appends chronologically, so reversing it keeps every group newest first.
  const groups: EventGroup[] = [];
  const byLabel = new Map<string, EventGroup>();
  for (const event of [...visible].reverse()) {
    const presentation = presentEvent(event, subscriptions);
    const group = byLabel.get(presentation.label);
    if (group !== undefined) {
      group.events.push(event);
      continue;
    }
    const created = { ...presentation, events: [event] };
    byLabel.set(presentation.label, created);
    groups.push(created);
  }

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
          <div className="mb-3 flex flex-wrap gap-2" data-testid="mcp-topic-filters">
            <button
              type="button"
              className={chipClass(selected === null)}
              aria-pressed={selected === null}
              onClick={() => setSelected(null)}
              data-testid="mcp-topic-filter"
            >
              All <span className="opacity-70">{events.events.length}</span>
            </button>
            {events.subscriptions.map((subscription) => {
              const active = selected === subscription.id;
              const topic = subscriptionTopic(subscription);
              return (
                <button
                  key={subscription.id}
                  type="button"
                  className={chipClass(active)}
                  aria-pressed={active}
                  onClick={() => setSelected(subscription.id)}
                  title={topic === undefined ? undefined : `topic: ${topic}`}
                  data-testid="mcp-topic-filter"
                  data-subscription-id={subscription.id}
                >
                  {subscriptionLabel(subscription)}{" "}
                  <span className="opacity-70">{counts.get(subscription.id) ?? 0}</span>
                </button>
              );
            })}
          </div>
          {events.notice && (
            <p className="mb-3 font-mono text-xs text-foreground" data-testid="mcp-event-notice">
              {events.notice}
            </p>
          )}
          {ready && events.events.length === 0 && selected === null && (
            <p className="font-mono text-xs text-muted-foreground">No events yet.</p>
          )}
          {ready && visible.length === 0 && selected !== null && (
            <p className="font-mono text-xs text-muted-foreground" data-testid="mcp-topic-empty">
              No events for this topic.
            </p>
          )}
          <div className="space-y-6">
            {groups.map((group) => (
              <section key={group.label} className="space-y-3" data-testid="mcp-event-group">
                <div
                  className="theme-radius flex items-baseline justify-between gap-3 border border-border bg-surface px-2 py-1 font-mono text-[11px]"
                  title={group.topic === undefined ? undefined : `topic: ${group.topic}`}
                >
                  <span
                    className="min-w-0 truncate text-foreground"
                    data-testid="mcp-event-group-label"
                  >
                    {group.label}
                  </span>
                  <span className="shrink-0 text-muted-foreground">{group.events.length}</span>
                </div>
                {group.events.map((event) => {
                  const presentation = presentEvent(event, subscriptions);
                  return (
                    <article
                      key={event.id}
                      className="theme-radius border border-border px-3 py-2"
                      data-testid="mcp-event-card"
                      data-event-id={event.id}
                      data-subscription-id={event.subscriptionId}
                    >
                      <div className="font-mono text-[11px] text-muted-foreground">
                        {formatTime(event.timestamp)} ·{" "}
                        <span
                          className="text-foreground"
                          title={
                            presentation.topic === undefined
                              ? undefined
                              : `topic: ${presentation.topic}`
                          }
                          data-testid="mcp-event-label"
                        >
                          {presentation.label}
                        </span>{" "}
                        · <span data-testid="mcp-event-name">{event.name}</span>
                      </div>
                      {event.summary.length > 0 && (
                        <pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-muted-foreground">
                          {event.summary}
                        </pre>
                      )}
                    </article>
                  );
                })}
              </section>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
