import { useMemo } from "react";
import type { ActivityItem } from "../shared/types";
import { activitySummary } from "./activity-format";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import { cn } from "./lib/utils";
import { PiMenu } from "./PiMenu";
import { groupTimeline } from "./timeline-groups";
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
  const failed = activity.kind === "tool" && activity.isError;
  return (
    <Collapsible>
      <CollapsibleTrigger
        className={cn(
          "group flex w-full items-center gap-2 border-b border-border py-3 text-left font-mono text-xs hover:text-foreground",
          failed ? "text-destructive" : "text-muted-foreground",
        )}
      >
        <span className="inline-block w-3 shrink-0 transition-transform group-data-[state=open]:rotate-90">
          ▸
        </span>
        <span className="min-w-0 flex-1 truncate">{activitySummary(activity)}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="theme-radius space-y-3 border-b border-border bg-muted/40 px-3 py-3 pl-8 text-xs">
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
  const run = new URLSearchParams(window.location.search).get("run");
  const activities = useMemo(() => {
    const groups = groupTimeline(timeline);
    const selected =
      run === null
        ? groups
        : groups.filter((group) => group.kind === "activity" && group.key === run);
    return selected.flatMap((group) => (group.kind === "activity" ? group.items : []));
  }, [run, timeline]);

  return (
    <div className="activity-screen">
      <div
        data-testid="activity-card"
        className="ink-line flex h-full min-h-0 flex-col theme-radius border bg-surface"
      >
        <header className="ink-line flex shrink-0 items-center gap-3 border-b px-3 py-1.5">
          <PiMenu />
          <a
            href="/"
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Back to chat
          </a>
        </header>
        <div className="shrink-0 px-4 pt-4">
          <h1 className="text-sm font-medium">Activity</h1>
          <p className="mt-2 text-xs text-muted-foreground">
            {run === null
              ? "Every tool call and thinking block in this conversation, in order."
              : "Tool calls and thinking from this run."}
          </p>
        </div>
        <div
          data-testid="activity-scroll"
          className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-4"
        >
          {!ready && <p className="font-mono text-xs text-muted-foreground">Loading…</p>}
          {ready && activities.length === 0 && (
            <p className="font-mono text-xs text-muted-foreground">
              {run === null ? "No activity yet." : "No activity in this run."}
            </p>
          )}
          <div>
            {activities.map((activity) => (
              <ActivityRow key={activity.id} activity={activity} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
