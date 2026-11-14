import { useEffect, useId, useMemo, useReducer, useState } from "react";
import { Sheet } from "react-modal-sheet";
import type { BuiltinJob } from "../shared/dashboard";
import { formatDateTime, formatTime } from "../shared/time";
import type { DelegateRunView } from "../shared/types";
import { haptic } from "./haptics";
import { CloseIcon } from "./icons";

export type BackgroundJobsKind = "jobs" | "subagents";

/** Finished jobs stay in the registry; only a running one belongs on the live line. */
export function activeJobs(jobs: readonly BuiltinJob[]): BuiltinJob[] {
  return jobs.filter((job) => job.status === "running");
}

/** A queued sub-agent is already accepted work, so it counts until it finishes. */
export function activeSubagents(delegates: readonly DelegateRunView[]): DelegateRunView[] {
  return delegates.filter((run) => run.status === "running" || run.status === "queued");
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

/** `mm:ss`, or `h:mm:ss` once the item has run for an hour. */
function elapsed(startedAt: string | null, now: number): string {
  if (startedAt === null) return "—";
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return "—";
  const total = Math.max(0, Math.floor((now - started) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (part: number) => String(part).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** How long the counts stay mounted for their opacity/transform exit. */
const EXIT_MS = 220;
/** Open at a partial detent; the 80dvh cap keeps the top of the page visible. */
const SHEET_SNAP_POINTS = [0, 0.72, 1];

interface JobCounts {
  jobs: number;
  subagents: number;
}

type CountsState = { counts: JobCounts | null; open: boolean };
type CountsAction = { type: "show"; counts: JobCounts } | { type: "hide" } | { type: "unmount" };

function countsReducer(state: CountsState, action: CountsAction): CountsState {
  switch (action.type) {
    case "show":
      if (
        state.open &&
        state.counts !== null &&
        state.counts.jobs === action.counts.jobs &&
        state.counts.subagents === action.counts.subagents
      ) {
        return state;
      }
      return { counts: action.counts, open: true };
    case "hide":
      if (state.counts === null || !state.open) return state;
      return { ...state, open: false };
    case "unmount":
      return state.counts === null ? state : { counts: null, open: false };
  }
}

/**
 * The live jobs/sub-agent counts, painted inline at the start of the composer's
 * status row. They are deliberately absent when both lists are empty, and only
 * their own opacity/transform animates: the row keeps its height, so the
 * composer and the transcript never move when work starts, finishes, or the
 * reader switches pages. The node is removed after the exit, so a non-chat
 * surface never carries a hidden counter.
 */
export function BackgroundJobsCounts({
  jobs,
  delegates,
  onOpen,
  visible,
}: {
  jobs: readonly BuiltinJob[];
  delegates: readonly DelegateRunView[];
  onOpen: (kind: BackgroundJobsKind) => void;
  /** Counts belong to the chat page only; the exit still paints before they unmount. */
  visible: boolean;
}) {
  const jobCount = activeJobs(jobs).length;
  const subagentCount = activeSubagents(delegates).length;
  const live = jobCount > 0 || subagentCount > 0;
  const [state, dispatch] = useReducer(countsReducer, {
    counts: visible && live ? { jobs: jobCount, subagents: subagentCount } : null,
    open: visible && live,
  });

  useEffect(() => {
    if (visible && live) {
      dispatch({ type: "show", counts: { jobs: jobCount, subagents: subagentCount } });
      return;
    }
    dispatch({ type: "hide" });
  }, [visible, live, jobCount, subagentCount]);

  useEffect(() => {
    if (state.counts === null || state.open) return;
    const timer = window.setTimeout(() => dispatch({ type: "unmount" }), EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [state.counts, state.open]);

  const rendered = state.counts;
  if (rendered === null) return null;

  const chip = (kind: BackgroundJobsKind, count: number, noun: string) => (
    <button
      type="button"
      data-testid={`bg-jobs-line-${kind}`}
      aria-label={plural(count, noun)}
      onClick={() => {
        haptic();
        onOpen(kind);
      }}
      className="shrink-0 whitespace-nowrap font-mono text-[11px] leading-4 text-muted-foreground transition-colors hover:text-foreground"
    >
      {plural(count, noun)}
    </button>
  );

  return (
    <span
      data-testid="bg-jobs-line"
      data-open={state.open ? "true" : "false"}
      data-surface={visible ? "chat" : "away"}
      // The outer box starts at the plus button's box; the inset puts the text
      // ink on the plus icon's ink, so the edge reads aligned on both sizes.
      className="bg-jobs-counts -ml-3 inline-flex min-w-0 shrink-0 items-baseline gap-1.5 pl-[11px]"
    >
      {rendered.jobs > 0 && chip("jobs", rendered.jobs, "job")}
      {rendered.jobs > 0 && rendered.subagents > 0 && (
        <span aria-hidden="true" className="shrink-0 leading-4">
          ·
        </span>
      )}
      {rendered.subagents > 0 && chip("subagents", rendered.subagents, "subagent")}
    </span>
  );
}

async function readJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/**
 * The page sheet shared by the jobs and sub-agent chips. It re-reads the registry once
 * on open; the live duration is the only thing that ticks, and it never polls. A row
 * opens the existing activity surface rather than growing a second detail panel here.
 */
export function BackgroundJobsSheet({
  kind,
  jobs,
  delegates,
  onOpenItem,
  onClose,
}: {
  kind: BackgroundJobsKind;
  jobs: readonly BuiltinJob[];
  delegates: readonly DelegateRunView[];
  onOpenItem: (kind: BackgroundJobsKind, id: string) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const [jobItems, setJobItems] = useState<BuiltinJob[] | null>(null);
  const [runItems, setRunItems] = useState<DelegateRunView[] | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    const url = kind === "jobs" ? "/api/jobs" : "/api/delegates";
    void readJson<unknown>(url).then((value) => {
      if (!active || !Array.isArray(value)) return;
      if (kind === "jobs") setJobItems(value as BuiltinJob[]);
      else setRunItems(value as DelegateRunView[]);
    });
    return () => {
      active = false;
    };
  }, [kind]);

  const liveJobs = useMemo(() => {
    // The one re-read can see a job before its stream frame; the live frame wins on
    // status, while the fetched row still supplies fields the frame omits.
    const merged = new Map<string, BuiltinJob>();
    for (const job of jobItems ?? []) merged.set(job.id, job);
    for (const job of jobs) merged.set(job.id, { ...merged.get(job.id), ...job });
    return activeJobs([...merged.values()]);
  }, [jobItems, jobs]);
  const liveRuns = useMemo(() => {
    const merged = new Map<string, DelegateRunView>();
    for (const run of runItems ?? []) merged.set(run.id, run);
    for (const run of delegates) merged.set(run.id, { ...merged.get(run.id), ...run });
    return activeSubagents([...merged.values()]);
  }, [runItems, delegates]);
  const title = kind === "jobs" ? "Background jobs" : "Subagents";

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <Sheet
      isOpen
      onClose={onClose}
      snapPoints={SHEET_SNAP_POINTS}
      initialSnap={1}
      tweenConfig={{ ease: "easeOut", duration: 0.24 }}
    >
      <Sheet.Container
        data-testid="bg-jobs-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{ backgroundColor: "var(--surface)" }}
        className="max-h-[80dvh] overflow-hidden rounded-t-xl border border-foreground/15 text-foreground shadow-xl"
      >
        <Sheet.Header>
          <header className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-3 border-b border-border px-3 py-2">
            <span aria-hidden="true" />
            <h2 id={titleId} className="whitespace-nowrap text-sm font-medium">
              {title}
            </h2>
            <button
              type="button"
              data-testid="bg-jobs-sheet-close"
              aria-label="Close"
              onClick={onClose}
              className="-mr-1 justify-self-end rounded-md px-2 py-1 font-mono text-sm text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
            >
              <CloseIcon size={16} />
            </button>
          </header>
        </Sheet.Header>

        <Sheet.Content
          data-kind={kind}
          disableDrag
          className="min-h-0 flex-1"
          scrollClassName="px-3 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
        >
          <div data-testid="bg-jobs-sheet-list" className="flex flex-col gap-1.5">
            {kind === "jobs"
              ? liveJobs.map((job) => (
                  <button
                    key={job.id}
                    type="button"
                    data-testid="bg-jobs-sheet-job"
                    data-id={job.id}
                    onClick={() => {
                      haptic();
                      onOpenItem("jobs", job.id);
                    }}
                    className="theme-radius w-full border border-border/70 bg-background/80 px-3 py-2 text-left transition-colors hover:bg-muted"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                        {job.name}
                      </span>
                      <span
                        data-testid="bg-jobs-sheet-duration"
                        className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground"
                      >
                        {elapsed(job.startedAt, now)}
                      </span>
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                      started{" "}
                      <time dateTime={job.startedAt} title={formatDateTime(job.startedAt)}>
                        {formatTime(job.startedAt)}
                      </time>
                    </div>
                  </button>
                ))
              : liveRuns.map((run) => (
                  <button
                    key={run.id}
                    type="button"
                    data-testid="bg-jobs-sheet-subagent"
                    data-id={run.id}
                    onClick={() => {
                      haptic();
                      onOpenItem("subagents", run.id);
                    }}
                    className="theme-radius w-full border border-border/70 bg-background/80 px-3 py-2 text-left transition-colors hover:bg-muted"
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                        {run.agent} · {run.taskFirstLine}
                      </span>
                      <span
                        data-testid="bg-jobs-sheet-duration"
                        className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground"
                      >
                        {elapsed(run.startedAt ?? run.queuedAt, now)}
                      </span>
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                      {run.status} · started{" "}
                      <time
                        dateTime={run.startedAt ?? run.queuedAt}
                        title={formatDateTime(run.startedAt ?? run.queuedAt)}
                      >
                        {formatTime(run.startedAt ?? run.queuedAt)}
                      </time>
                    </div>
                  </button>
                ))}
            {kind === "jobs" && liveJobs.length === 0 && (
              <p className="font-mono text-xs text-muted-foreground">No jobs are running.</p>
            )}
            {kind === "subagents" && liveRuns.length === 0 && (
              <p className="font-mono text-xs text-muted-foreground">No subagents are running.</p>
            )}
          </div>
        </Sheet.Content>
      </Sheet.Container>
      <Sheet.Backdrop onTap={onClose} />
    </Sheet>
  );
}
