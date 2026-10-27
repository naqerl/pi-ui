import type { ActivityItem } from "../shared/types";
import { activitySummary } from "./activity-format";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import { cn } from "./lib/utils";
import type { TimelineItem } from "./use-chat";

interface ActivityViewProps {
  timeline: TimelineItem[];
  ready: boolean;
}

function Detail({ label, children, error }: { label: string; children: string; error?: boolean }) {
  return (
    <div>
      <div className="mb-1 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <pre
        className={cn(
          "whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground",
          error && "text-destructive",
        )}
      >
        {children}
      </pre>
    </div>
  );
}

function ActivityRow({ activity }: { activity: ActivityItem }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="group flex w-full items-center gap-2 border-b border-border py-3 text-left font-mono text-xs text-muted-foreground hover:text-foreground">
        <span className="inline-block w-3 shrink-0 transition-transform group-data-[state=open]:rotate-90">
          ▸
        </span>
        <span className="truncate">{activitySummary(activity)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="space-y-3 border-b border-border py-3 pl-5 text-xs">
          {activity.kind === "tool" ? (
            <>
              <Detail label="arguments">{activity.arguments}</Detail>
              <Detail label={activity.isError ? "error" : "result"} error={activity.isError}>
                {activity.output && activity.output.length > 0 ? activity.output : "(no output)"}
              </Detail>
            </>
          ) : (
            <Detail label="thinking">{activity.text}</Detail>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function ActivityView({ timeline, ready }: ActivityViewProps) {
  const activities = timeline
    .filter((item): item is Extract<TimelineItem, { kind: "activity" }> => item.kind === "activity")
    .map((item) => item.activity);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-border pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-10 w-full max-w-[72ch] items-center justify-between px-4">
          <a href="/" className="text-sm font-medium text-foreground">
            pi
          </a>
          <a
            href="/"
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Back to chat
          </a>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[72ch] px-4 py-6">
          <h1 className="mb-2 text-sm font-medium">Activity</h1>
          <p className="mb-4 text-xs text-muted-foreground">
            Every tool call and thinking block in this conversation, in order.
          </p>

          {!ready && <p className="font-mono text-xs text-muted-foreground">Loading…</p>}
          {ready && activities.length === 0 && (
            <p className="font-mono text-xs text-muted-foreground">No activity yet.</p>
          )}

          <div>
            {activities.map((activity) => (
              <ActivityRow key={activity.id} activity={activity} />
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
