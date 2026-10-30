import { useEffect, useId, useMemo, useRef, useState } from "react";
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
  /** Restrict the list to one timeline group; defaults to the page's ?run= value. */
  run?: string | null;
  /** Render as the body of a modal instead of a standalone page. */
  dialog?: { onClose: () => void; titleId: string };
}

interface ActivityDialogProps {
  timeline: TimelineItem[];
  ready: boolean;
  run: string | null;
  onClose: () => void;
}

/** Output longer than this shows its start until the reader asks for the rest. */
const PREVIEW_LINES = 40;
const PREVIEW_CHARS = 4000;

function preview(text: string): string | null {
  const lines = text.split("\n");
  if (lines.length <= PREVIEW_LINES && text.length <= PREVIEW_CHARS) return null;
  return lines.slice(0, PREVIEW_LINES).join("\n").slice(0, PREVIEW_CHARS);
}

function Detail({ label, children, error }: { label: string; children: string; error?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const short = useMemo(() => preview(children), [children]);
  const lineCount = useMemo(() => children.split("\n").length, [children]);
  const collapsed = short !== null && !expanded;
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
        {collapsed ? `${short}\n…` : children}
      </pre>
      {short !== null && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 font-mono text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {expanded
            ? "Show less"
            : `Show all ${lineCount} lines (${children.length.toLocaleString()} characters)`}
        </button>
      )}
    </div>
  );
}

function jobStatus(activity: Extract<ActivityItem, { kind: "job" }>): string {
  switch (activity.notice.status) {
    case "exited":
      return "finished";
    case "lost":
      return "lost (server restarted)";
    default:
      return activity.notice.status;
  }
}

function JobField({ label, value }: { label: string; value: string }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]">{value}</dd>
    </div>
  );
}

function JobActivityRow({ activity }: { activity: Extract<ActivityItem, { kind: "job" }> }) {
  const { notice } = activity;
  const failed = notice.status === "failed" || notice.status === "lost";
  const time = new Date(activity.timestamp);
  const clock = Number.isNaN(time.getTime())
    ? ""
    : `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
  return (
    <Collapsible>
      <CollapsibleTrigger
        data-testid="activity-job"
        data-notice-kind="job"
        className={cn(
          "group flex w-full items-center gap-2 border-b border-border py-3 text-left font-mono text-xs hover:text-foreground",
          failed ? "text-destructive" : "text-muted-foreground",
        )}
      >
        <span className="inline-block w-3 shrink-0 transition-transform group-data-[state=open]:rotate-90">
          ▸
        </span>
        <span aria-hidden="true" className="shrink-0">
          ⚙
        </span>
        <span
          data-testid="activity-job-summary"
          className="min-w-0 flex-1 [overflow-wrap:anywhere]"
        >
          {notice.summary}
        </span>
        {clock !== "" && (
          <time dateTime={activity.timestamp} className="shrink-0 tabular-nums opacity-60">
            {clock}
          </time>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="theme-radius space-y-3 border-b border-border bg-muted/40 px-3 py-3 pl-8 text-xs">
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
            <JobField label="Job" value={notice.id} />
            <JobField label="Name" value={notice.name} />
            <JobField label="Command" value={notice.command} />
            <JobField label="Status" value={jobStatus(activity)} />
            {notice.exitCode !== null && (
              <JobField label="Exit code" value={String(notice.exitCode)} />
            )}
            {notice.signal !== null && <JobField label="Signal" value={notice.signal} />}
            {notice.duration !== null && <JobField label="Duration" value={notice.duration} />}
          </dl>
          <Detail label="last output">
            {notice.output === "" ? "(no output)" : notice.output}
          </Detail>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ActivityRow({ activity }: { activity: ActivityItem }) {
  if (activity.kind === "job") return <JobActivityRow activity={activity} />;
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
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{activitySummary(activity)}</span>
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

/** The run's activity list, shared by the standalone page and the chat's modal. */
export function ActivityView({ timeline, ready, run: runProp, dialog }: ActivityViewProps) {
  const locationRun = new URLSearchParams(window.location.search).get("run");
  const run = runProp === undefined ? locationRun : runProp;
  const activities = useMemo(() => {
    const groups = groupTimeline(timeline);
    const selected =
      run === null
        ? groups
        : groups.filter((group) => group.kind === "activity" && group.key === run);
    return selected.flatMap((group) => (group.kind === "activity" ? group.items : []));
  }, [run, timeline]);

  const card = (
    <div
      data-testid="activity-card"
      className={cn(
        "ink-line flex min-h-0 flex-col theme-radius border bg-surface",
        dialog === undefined ? "h-full" : "flex-1",
      )}
    >
      <header className="ink-line flex shrink-0 items-center gap-3 border-b px-3 py-1.5">
        {dialog === undefined ? (
          <>
            <PiMenu />
            <a
              href="/"
              className="text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              Back to chat
            </a>
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1" />
            <button
              type="button"
              data-testid="activity-dialog-close"
              aria-label="Close"
              onClick={dialog.onClose}
              className="-mr-1 shrink-0 rounded-md px-2 py-1 font-mono text-sm text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
            >
              ✕
            </button>
          </>
        )}
      </header>
      <div className="shrink-0 px-4 pt-4">
        <h1 id={dialog?.titleId} className="text-sm font-medium">
          Activity
        </h1>
        <p className="mt-2 text-xs text-muted-foreground">
          {run === null
            ? "Every tool call, thinking block and job result in this conversation, in order."
            : "Tool calls, thinking blocks and job results from this run."}
        </p>
      </div>
      <div data-testid="activity-scroll" className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 pb-4">
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
  );

  if (dialog !== undefined) {
    return (
      <div className="flex min-h-0 flex-1 flex-col pb-[env(safe-area-inset-bottom)]">{card}</div>
    );
  }
  return <div className="activity-screen">{card}</div>;
}

/** The activity view in a native modal over the chat. */
export function ActivityDialog({ timeline, ready, run, onClose }: ActivityDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    const bodyOverflow = document.body.style.overflow;
    const htmlOverflow = document.documentElement.style.overflow;
    // The transcript behind the sheet must not move while it is open.
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    if (dialog !== null && !dialog.open) dialog.showModal();
    return () => {
      dialog?.close();
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = htmlOverflow;
    };
  }, []);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc is handled by the dialog's cancel event.
    <dialog
      ref={ref}
      data-testid="activity-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // Clicks on the backdrop land on the dialog itself; the panel fills the rest.
        if (event.target === event.currentTarget) onClose();
      }}
      className="m-0 mt-auto flex max-h-[85vh] w-full max-w-full flex-col overflow-hidden rounded-t-xl border border-foreground/15 bg-surface p-0 text-foreground shadow-xl backdrop:bg-black/50 sm:m-auto sm:w-[min(48rem,calc(100vw-2rem))] sm:rounded-xl"
    >
      <ActivityView timeline={timeline} ready={ready} run={run} dialog={{ onClose, titleId }} />
    </dialog>
  );
}
