import { useEffect, useId, useMemo, useReducer, useRef, useState } from "react";
import { Sheet } from "react-modal-sheet";
import type { BuiltinJob } from "../shared/dashboard";
import { formatDateTime, formatTime } from "../shared/time";
import type { DelegateRunView } from "../shared/types";
import { haptic } from "./haptics";
import { CloseIcon } from "./icons";
import { cn } from "./lib/utils";
import type { DockPhase } from "./use-dock-scan";

export type BackgroundJobsKind = "jobs" | "subagents";

export function activeJobs(jobs: readonly BuiltinJob[]): BuiltinJob[] {
  return jobs.filter((job) => job.status === "running");
}

export function activeSubagents(delegates: readonly DelegateRunView[]): DelegateRunView[] {
  return delegates.filter((run) => run.status === "running" || run.status === "queued");
}

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

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

const EXIT_MS = 220;
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

export function BackgroundJobsCounts({
  jobs,
  delegates,
  onOpen,
  visible,
  phase = "settled",
  order = 2,
}: {
  jobs: readonly BuiltinJob[];
  delegates: readonly DelegateRunView[];
  onOpen: (kind: BackgroundJobsKind) => void;
  visible: boolean;
  phase?: DockPhase;
  order?: number;
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

  const entering = phase === "enter";
  const rendered = entering
    ? visible && live
      ? { jobs: jobCount, subagents: subagentCount }
      : null
    : state.counts;
  const open = entering ? visible && live : state.open;
  const exitMs = entering ? 0 : EXIT_MS;
  const identity = rendered === null ? null : `${rendered.jobs}:${rendered.subagents}`;
  const previous = useRef({ identity, phase });
  const swept = useRef(false);
  if (phase === "enter" && rendered !== null) {
    swept.current = true;
  } else if (
    phase === "settled" &&
    previous.current.phase === "settled" &&
    previous.current.identity !== identity
  ) {
    swept.current = false;
  }
  previous.current = { identity, phase };
  const interactive = open && phase !== "exit";

  useEffect(() => {
    if (state.counts === null || state.open) return;
    const timer = window.setTimeout(() => dispatch({ type: "unmount" }), exitMs);
    return () => window.clearTimeout(timer);
  }, [state.counts, state.open, exitMs]);

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
      data-open={open ? "true" : "false"}
      data-swept={swept.current ? "true" : undefined}
      data-surface={visible ? "chat" : "away"}
      data-dock-phase={phase === "settled" ? undefined : phase}
      aria-hidden={interactive ? undefined : true}
      inert={interactive ? undefined : true}
      className={cn(
        "bg-jobs-counts dock-swap inline-flex min-w-0 shrink-0 items-baseline gap-md",
        order !== 0 && `dock-order-${order}`,
        !interactive && "pointer-events-none",
      )}
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
          <header className="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-xl border-b border-border px-xl py-lg">
            <span aria-hidden="true" />
            <h2 id={titleId} className="whitespace-nowrap text-sm font-medium">
              {title}
            </h2>
            <button
              type="button"
              data-testid="bg-jobs-sheet-close"
              aria-label="Close"
              onClick={onClose}
              className="-mr-sm justify-self-end rounded-md px-lg py-sm font-mono text-sm text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
            >
              <CloseIcon size={16} />
            </button>
          </header>
        </Sheet.Header>

        <Sheet.Content
          data-kind={kind}
          disableDrag
          className="min-h-0 flex-1"
          scrollClassName="px-xl py-xl pb-xl safe-bottom"
        >
          <div data-testid="bg-jobs-sheet-list" className="flex flex-col gap-md">
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
                    className="theme-radius w-full border border-border/70 bg-background/80 px-xl py-lg text-left transition-colors hover:bg-muted"
                  >
                    <div className="flex min-w-0 items-center gap-lg">
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
                    <div className="mt-xs font-mono text-[11px] text-muted-foreground">
                      started{" "}
                      <time dateTime={job.startedAt} title={formatDateTime(job.startedAt)}>
                        {formatTime(job.startedAt)}
                      </time>
                    </div>
                  </button>
                ))
              : liveRuns.map((run) => (
                  <div
                    key={run.id}
                    data-testid="bg-jobs-sheet-subagent"
                    data-id={run.id}
                    className="theme-radius w-full border border-border/70 bg-background/80 px-xl py-lg text-left"
                  >
                    <div className="flex min-w-0 items-center gap-lg">
                      <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
                        {run.taskFirstLine}
                      </span>
                      <span
                        data-testid="bg-jobs-sheet-duration"
                        className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground"
                      >
                        {elapsed(run.startedAt ?? run.queuedAt, now)}
                      </span>
                    </div>
                    <div className="mt-xs font-mono text-[11px] text-muted-foreground">
                      {run.status} · started{" "}
                      <time
                        dateTime={run.startedAt ?? run.queuedAt}
                        title={formatDateTime(run.startedAt ?? run.queuedAt)}
                      >
                        {formatTime(run.startedAt ?? run.queuedAt)}
                      </time>
                    </div>
                  </div>
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
