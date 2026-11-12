import {
  lazy,
  memo,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MemoryPathMatch, MemoryReadRange, MemoryToolDetails } from "../shared/memory";
import { pageIdFromPath } from "../shared/pages";
import { acceptMention, mentionAt, parseProjectToken, projectsOf } from "../shared/project";
import { isQueuedNotice, queuedMessageIds, resolveNoticeIconName } from "../shared/queue";
import { isActiveStatus } from "../shared/tasks";
import { formatDateTime, formatTime } from "../shared/time";
import type {
  ActivityItem,
  ChatMessage,
  DelegateRunView,
  MessageMode,
  QueuedMessage,
  QueuedNotice,
  RunError,
  Task,
  TaskActivity,
  TaskLedger,
  TokenSpend,
  ToolActivity,
} from "../shared/types";
import { groupSummaryParts } from "./activity-format";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { DiagramPart } from "./DiagramPart";
import { EmptyCaption } from "./EmptyCaption";
import { haptic } from "./haptics";
import {
  ArrowDownIcon,
  ChevronDownIcon,
  ChevronIcon,
  ChevronUpIcon,
  CloseIcon,
  NoticeIcon,
  SearchIcon,
} from "./icons";
import { DeferredMarkdown, loadMarkdown } from "./lazy-markdown";
import { cn } from "./lib/utils";
import { ATTACH_ACCEPT, mediaUrl, uploadMedia } from "./media-client";
import { ChipButton, NoticeLine } from "./NoticeView";
import { PiMenu } from "./PiMenu";
import { ProjectSuggestions, projectSuggestions } from "./ProjectSuggestions";
import { RunErrorHeader } from "./RunErrorHeader";
import type { ChatStats } from "./StatsView";
import { createTask } from "./task-client";
import { TaskDockComposerProvider, type TaskDockSession } from "./task-dock-composer";
import { TaskLinkProvider } from "./task-link";
import { groupTimeline, type TimelineGroup } from "./timeline-groups";
import type { SendOutcome, TimelineItem } from "./use-chat";
import { usePager } from "./use-pager";
import { useStickToBottom } from "./use-stick-to-bottom";
import { WorkingIndicator } from "./WorkingIndicator";

interface ChatViewProps {
  timeline: TimelineItem[];
  running: boolean;
  thinking: boolean;
  interrupted: boolean;
  /** The server's last unacknowledged run failure, rendered as a thin header. */
  runError?: RunError | null;
  dismissRunError?: (id: string) => void;
  /** Pushed by the server, so the activity page does not poll for it. */
  delegates?: DelegateRunView[];
  ready: boolean;
  tasks: Task[];
  /** Measured run activity per task, from the ledger view. */
  taskActivity?: TaskActivity;
  send: (text: string, mode?: MessageMode, attachments?: string[]) => Promise<SendOutcome>;
  stop: () => Promise<void>;
  /** Takes back the newest steer the run has not reached yet; absent or null when none can be. */
  unsendSteer?: () => Promise<QueuedMessage | null>;
  /** Withdraws a follow-up that is waiting for the current turn to end. */
  cancelQueued?: (id: string) => Promise<boolean>;
  /** How many steers are waiting for the run's next turn boundary. */
  pendingSteers?: number;
  applyTasks: (ledger: TaskLedger) => void;
  stats: ChatStats;
  refreshStats?: () => void;
  history?: HistoryControl;
}

// The side pages and the Markdown renderer are their own chunks, so the chat paints first.
const loadStatsView = () => import("./StatsView");
const loadTasksView = () => import("./TasksView");
const ActivityDialog = lazy(() =>
  import("./ActivityView").then((m) => ({ default: m.ActivityDialog })),
);
const StatsView = lazy(() => loadStatsView().then((m) => ({ default: m.StatsView })));
const TasksView = lazy(() => loadTasksView().then((m) => ({ default: m.TasksView })));
void loadMarkdown();

export interface HistoryControl {
  hasEarlier: boolean;
  loading: boolean;
  loadEarlier: () => void | Promise<void>;
}

const PAGES = [
  { id: "stats", label: "Stats" },
  { id: "chat", label: "Chat" },
  { id: "tasks", label: "Tasks" },
] as const;
const STATS_PAGE = 0;
const CHAT_PAGE = 1;
const TASKS_PAGE = 2;
// The pager slides for 300ms; the composer body's height settles sooner.
const PAGE_SETTLE_MS = 320;

function pageFromLocation(): number {
  const name = new URLSearchParams(window.location.search).get("page");
  const fromQuery = PAGES.findIndex((item) => item.id === name);
  if (fromQuery >= 0) return fromQuery;
  // A push or a bookmark may carry the page as a real path (/tasks). The
  // server serves the shell for it; the pager picks the matching page here.
  const fromPath = pageIdFromPath(window.location.pathname);
  const index = fromPath === undefined ? -1 : PAGES.findIndex((item) => item.id === fromPath);
  return index < 0 ? CHAT_PAGE : index;
}

/** A stable client key lets an optimistic task card be replaced by its ledger row. */
function newTaskKey(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

interface OptimisticTask {
  key: string;
  task: Task;
  /** Ids already in the ledger when this card was painted, so only a new row can replace it. */
  knownIds: Set<string>;
}

/** The deep link /activity?run=... opens the chat with that run's activity already showing. */
function activityRunFromLocation(): string | null | undefined {
  const path = window.location.pathname.replace(/\/+$/, "");
  if (path !== "/activity") return undefined;
  return new URLSearchParams(window.location.search).get("run");
}

function MessageTime({ timestamp }: { timestamp: string }) {
  const time = formatTime(timestamp);
  if (time === "") return null;
  return (
    <div className="-mb-0.5 mt-1 text-right font-mono text-[10px] leading-none text-muted-foreground tabular-nums">
      <time dateTime={timestamp} title={formatDateTime(timestamp)}>
        {time}
      </time>
    </div>
  );
}

/** True for the pi-ui update note, including entries recorded before it carried a marker. */
function isVersionUpdate(message: ChatMessage): boolean {
  return (
    message.version !== undefined ||
    /^(?:Updated pi-ui from \S+ to \S+|pi-ui \d)/.test(message.text)
  );
}

/**
 * The pi-ui update note: a card that opens the changelog the agent was told about. The note itself
 * stays one line, because the changelog is long and belongs in a sheet the operator asks for.
 */
function VersionUpdateCard({ message }: { message: ChatMessage }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const version = message.version;
  const changes = version?.changes ?? "";
  const title = version === undefined || version.to === "" ? "pi-ui update" : `pi-ui ${version.to}`;

  return (
    <>
      <button
        type="button"
        data-message-id={message.id}
        data-role={message.role}
        data-testid="version-update"
        onClick={() => {
          haptic();
          setOpen(true);
        }}
        className="theme-radius mx-auto w-fit min-w-0 max-w-[92%] cursor-pointer bg-accent px-3 py-1 text-center font-mono text-[11px] leading-5 text-background transition-opacity [overflow-wrap:anywhere] hover:opacity-90"
      >
        {message.text}
      </button>
      {open ? (
        // biome-ignore lint/a11y/useKeyWithClickEvents: Esc is handled by the dialog cancel event.
        <dialog
          ref={ref}
          data-testid="version-update-dialog"
          aria-labelledby={titleId}
          onCancel={(event) => {
            event.preventDefault();
            setOpen(false);
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
          className="m-auto flex max-h-[85vh] w-[min(46rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-foreground/15 bg-surface p-0 text-foreground shadow-xl backdrop:bg-black/50"
        >
          <div className="flex items-center justify-between gap-2 border-b border-foreground/10 px-3 py-2">
            <h2
              id={titleId}
              className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground"
            >
              {title}
            </h2>
            <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
          <div
            data-testid="version-update-changelog"
            className="min-h-0 flex-1 overflow-y-auto px-3 py-2 text-sm leading-relaxed"
          >
            {changes.trim() === "" ? (
              <p className="text-muted-foreground">CHANGELOG.md has no entry for this version.</p>
            ) : (
              <DeferredMarkdown text={changes} />
            )}
          </div>
        </dialog>
      ) : null}
    </>
  );
}

/** An assistant reply: its full Markdown, rendered the same way at any length. */
function AssistantReply({ message }: { message: ChatMessage }) {
  return (
    <div
      data-testid="message-body"
      className="relative min-w-0 max-w-full [overflow-wrap:anywhere]"
    >
      <DeferredMarkdown text={message.text} />
    </div>
  );
}

/** Non-text message parts, such as diagrams drawn by a tool. */
function MessageParts({ parts }: { parts: ChatMessage["parts"] }) {
  if (parts === undefined || parts.length === 0) return null;
  return (
    <div data-testid="message-parts" className="mt-1.5 flex min-w-0 flex-col gap-1.5">
      {parts.map((part) =>
        part.kind === "diagram" ? (
          <DiagramPart
            key={part.diagram.id}
            id={part.diagram.id}
            revision={part.diagram.revision}
          />
        ) : null,
      )}
    </div>
  );
}

/** A queued machine notice, shown as the translucent version of its future notice chip. */
function QueuedNoticeChip({
  message,
  notice,
  onCancelQueued,
}: {
  message: ChatMessage;
  notice: QueuedNotice;
  onCancelQueued?: (id: string) => unknown;
}) {
  const queueIds = queuedMessageIds(message);
  const count = message.queueCount ?? 1;
  const icon = resolveNoticeIconName(notice.glyph, notice.kind);
  const cancelAll = async () => {
    if (onCancelQueued === undefined) return;
    haptic();
    for (const id of queueIds) await onCancelQueued(id);
  };
  return (
    <div
      data-message-id={message.id}
      data-role={message.role}
      data-pending-queue="true"
      data-testid="queued-notice-chip"
      className="flex justify-center px-2 py-0.5"
    >
      <div className="inline-flex min-w-0 max-w-[92%] items-center gap-1.5 rounded-full border border-foreground/10 bg-background/40 px-2.5 py-0.5 font-mono text-[11px] leading-5 text-foreground/80 backdrop-blur-md">
        <NoticeIcon name={icon} size={14} />
        <span className="min-w-0 truncate">{notice.label}</span>
        <span className="shrink-0 tabular-nums">{count} queued</span>
        {queueIds.length > 0 && onCancelQueued !== undefined && (
          <button
            type="button"
            title="Remove this queued message"
            aria-label="cancel"
            className="shrink-0 font-mono text-[11px] leading-none text-foreground hover:text-destructive"
            onClick={() => cancelAll()}
          >
            <CloseIcon size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

export function MessageBubble({
  message,
  onSteer,
  onCancelQueued,
}: {
  message: ChatMessage;
  onSteer?: (text: string) => void;
  onCancelQueued?: (id: string) => unknown;
}) {
  if (message.pendingQueue === true && isQueuedNotice(message.notice)) {
    return (
      <QueuedNoticeChip
        message={message}
        notice={message.notice}
        {...(onCancelQueued === undefined ? {} : { onCancelQueued })}
      />
    );
  }
  if (message.notice !== undefined && !isQueuedNotice(message.notice)) {
    return <NoticeLine message={message} notice={message.notice} onSteer={onSteer} />;
  }
  if (message.role === "system") {
    if (message.repair !== undefined) {
      return (
        <div
          data-message-id={message.id}
          data-role={message.role}
          data-testid="durable-repair"
          className="theme-radius mx-auto w-fit min-w-0 max-w-[92%] border border-foreground/10 bg-surface/90 px-3 py-1 text-center font-mono text-[11px] leading-5 text-muted-foreground backdrop-blur-md [overflow-wrap:anywhere]"
        >
          {message.text}
        </div>
      );
    }
    if (isVersionUpdate(message)) {
      return <VersionUpdateCard message={message} />;
    }
    return (
      <div className="flex items-center justify-center gap-1.5 px-2 py-1 text-center font-mono text-[11px] text-muted-foreground">
        <NoticeIcon name="warning" size={14} />
        {message.text}
      </div>
    );
  }

  const mine = message.role === "user";
  const framed = mine || message.isError === true || message.partial === true;
  return (
    <div
      data-message-id={message.id}
      data-role={message.role}
      data-pending-steer={message.pendingSteer ? "true" : undefined}
      data-pending-queue={message.pendingQueue ? "true" : undefined}
      data-pending-send={message.pendingSend ? "true" : undefined}
      data-steer-error={message.steerError === undefined ? undefined : "true"}
      className={cn(
        "theme-radius w-fit min-w-0 max-w-[85%] bg-surface px-3 py-2 text-sm leading-relaxed [overflow-wrap:anywhere]",
        mine ? "ml-auto" : "mr-auto",
        framed && "border",
        mine && "border-foreground/15",
        (message.pendingSteer || message.pendingQueue || message.pendingSend) &&
          "border-dashed opacity-70",
        message.isError && "border-destructive text-destructive",
        message.partial && "border-dashed",
        message.partial && !message.isError && "border-muted-foreground/70",
      )}
    >
      {message.pendingQueue && (
        <div className="mb-1 flex items-center justify-between gap-3 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          <span>queued</span>
          {message.queueId !== undefined && onCancelQueued !== undefined && (
            <button
              type="button"
              title="Remove this queued message"
              className="shrink-0 font-mono text-[10px] normal-case tracking-normal text-foreground underline decoration-dotted underline-offset-2 hover:text-destructive"
              onClick={() => {
                haptic();
                onCancelQueued(message.queueId as string);
              }}
            >
              cancel
            </button>
          )}
        </div>
      )}
      {message.steer && (
        <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          {message.pendingSteer
            ? "steer · pending"
            : message.steerError
              ? "steer · dropped"
              : "steer"}
        </div>
      )}
      {message.steerError && (
        <p className="mb-1 font-mono text-[11px] leading-4 text-destructive">
          {message.steerError}
        </p>
      )}
      {message.partial && (
        <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          partial
        </div>
      )}
      {message.attachments !== undefined && message.attachments.length > 0 && (
        <div
          className="mb-1.5 flex flex-wrap justify-end gap-1.5"
          data-testid="message-attachments"
        >
          {message.attachments.map((item) => (
            <a
              key={item.id}
              href={mediaUrl(item.id)}
              target="_blank"
              rel="noreferrer"
              className="block overflow-hidden rounded-sm border border-foreground/10"
            >
              <img
                src={mediaUrl(item.id)}
                alt="Attachment"
                loading="lazy"
                className="block max-h-48 max-w-full object-cover"
              />
            </a>
          ))}
        </div>
      )}
      {mine
        ? message.text.length > 0 && (
            <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{message.text}</div>
          )
        : message.text.length > 0 && <AssistantReply message={message} />}
      <MessageParts parts={message.parts} />
      <MessageTime timestamp={message.timestamp} />
    </div>
  );
}

const MemoMessageBubble = memo(MessageBubble);

interface MemoryChipView {
  label: string;
  paths: MemoryPathMatch[];
  reads: MemoryReadRange[];
}

/** Collapses every memory tool call in one activity group into the data its chip shows. */
export function memoryChipView(items: ActivityItem[]): MemoryChipView | null {
  let hits: number | undefined = 0;
  let reportedTopics: number | undefined = 0;
  let searches = 0;
  const paths = new Map<string, MemoryPathMatch>();
  const reads = new Map<string, MemoryReadRange>();
  for (const item of items) {
    if (item.kind !== "tool" || item.memory === undefined) continue;
    const memory: MemoryToolDetails = item.memory;
    const readOnly =
      memory.operation === "read" ||
      (memory.operation === undefined &&
        memory.reads.length > 0 &&
        memory.paths.length === 0 &&
        (memory.hits ?? 0) === 0);
    if (!readOnly) {
      searches += 1;
      hits = hits === undefined || memory.hits === undefined ? undefined : hits + memory.hits;
      reportedTopics =
        reportedTopics === undefined || memory.topics === undefined
          ? undefined
          : reportedTopics + memory.topics;
    }
    for (const match of memory.paths) {
      if (!paths.has(match.path)) paths.set(match.path, match);
    }
    for (const read of memory.reads) {
      if (!reads.has(read.path)) reads.set(read.path, read);
    }
  }
  const topics = paths.size > 0 ? paths.size : reportedTopics;
  if ((hits ?? 0) === 0 && (topics ?? 0) === 0 && reads.size === 0) return null;
  const parts = ["memory"];
  if (hits !== undefined && (hits > 0 || paths.size > 0)) {
    parts.push(`${hits} ${hits === 1 ? "hit" : "hits"}`);
  }
  if (topics !== undefined && topics > 0) {
    parts.push(`${topics} ${topics === 1 ? "topic" : "topics"}`);
  }
  if (searches > 1) parts.push(`×${searches}`);
  if (reads.size > 0) {
    const ranges = [...reads.values()].map(
      (read) => `${read.path} (lines ${read.from}–${read.to})`,
    );
    parts.push(`read ${ranges.join(", ")}`);
  }
  return { label: parts.join(" · "), paths: [...paths.values()], reads: [...reads.values()] };
}

/** One chip for all the memory searches and reads in a turn. */
function MemoryActivityChip({ items }: { items: ActivityItem[] }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const view = useMemo(() => memoryChipView(items), [items]);
  if (view === null) return null;
  return (
    <div data-testid="memory-chip" className="flex min-w-0 max-w-full flex-col items-start gap-1">
      <ChipButton
        testId="memory-search-chip"
        kind="memory-search"
        title={view.label}
        expanded={open}
        controls={detailsId}
        onClick={() => setOpen((current) => !current)}
      >
        <SearchIcon size={14} />
        <span className="min-w-0 truncate" data-testid="memory-search-chip-summary">
          {view.label}
        </span>
        <span aria-hidden="true" className="shrink-0 opacity-60">
          {open ? <ChevronUpIcon size={12} /> : <ChevronDownIcon size={12} />}
        </span>
      </ChipButton>
      {open && (
        <div
          id={detailsId}
          data-testid="memory-search-details"
          className="theme-radius w-fit max-w-full border border-foreground/10 bg-surface/90 px-3 py-2 font-mono text-[11px] leading-5 text-muted-foreground shadow-sm backdrop-blur-md"
        >
          {view.paths.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {view.paths.map((match) => (
                <li
                  key={match.path}
                  data-testid="memory-search-path"
                  className="min-w-0 [overflow-wrap:anywhere]"
                >
                  <span className="text-foreground">{match.path}</span>
                  <span aria-hidden="true" className="mx-1 opacity-50">
                    ·
                  </span>
                  <span>{match.line}</span>
                </li>
              ))}
            </ul>
          )}
          {view.paths.length === 0 && view.reads.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {view.reads.map((read) => (
                <li
                  key={read.path}
                  data-testid="memory-search-read"
                  className="min-w-0 [overflow-wrap:anywhere]"
                >
                  <span className="text-foreground">{read.path}</span>
                  <span className="mx-1 opacity-50">·</span>
                  <span>
                    lines {read.from}–{read.to}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function ActivityGroup({
  groupKey,
  items,
  live,
  usage,
  onOpen,
}: {
  groupKey: string;
  items: ActivityItem[];
  live: boolean;
  usage?: TokenSpend;
  onOpen: (groupKey: string, trigger: HTMLButtonElement) => void;
}) {
  const [now, setNow] = useState(Date.now);
  const memory = items.filter(
    (item): item is ToolActivity => item.kind === "tool" && item.memory !== undefined,
  );
  const memoryView = memoryChipView(memory);
  const other = items.filter((item) => !(item.kind === "tool" && item.memory !== undefined));

  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [live]);

  const parts = groupSummaryParts(items, live, now, usage);
  const runInfo =
    other.length === 0 ? null : (
      <button
        type="button"
        onClick={(event) => onOpen(groupKey, event.currentTarget)}
        aria-haspopup="dialog"
        data-testid="run-info"
        aria-label={`Run activity: ${parts.join(", ")}`}
        className="theme-radius flex min-h-9 w-fit min-w-0 max-w-full items-start gap-2 border border-border/70 bg-surface px-2.5 py-2 text-left font-mono text-xs leading-5 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground/40 sm:min-h-0 sm:py-1.5"
      >
        <ChevronIcon size={14} className="shrink-0" />
        {/* Each piece stays whole and the line wraps between pieces on a narrow screen. */}
        <span className="flex min-w-0 flex-wrap gap-x-1.5">
          {parts.map((part, index) => (
            <span key={part} className="whitespace-nowrap">
              {index > 0 && (
                <span aria-hidden="true" className="mr-1.5 text-muted-foreground/60">
                  ·
                </span>
              )}
              {part}
            </span>
          ))}
        </span>
      </button>
    );
  if (memory.length === 0 || memoryView === null) return runInfo;
  return (
    <div
      data-testid="activity-group"
      className="flex min-w-0 max-w-full flex-col items-start gap-1"
    >
      {runInfo}
      <MemoryActivityChip items={memory} />
    </div>
  );
}

const ACTION_BUTTON_CLASS = "h-9 w-full hover:bg-foreground/10";
const BACKLOG_LONG_PRESS_MS = 500;
/** Space above the first message and below the last, on every viewport. */
const TRANSCRIPT_END_GAP = 16;

function SendIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M22 2 11 13" />
      <path d="m22 2-7 20-4-9-9-4Z" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5 text-destructive">
      <circle cx="12" cy="12" r="10" fill="currentColor" />
      <rect x="8" y="8" width="8" height="8" rx="1" fill="#fff" />
    </svg>
  );
}

function computedLineHeight(element: HTMLElement): number {
  const style = getComputedStyle(element);
  const lineHeight = Number.parseFloat(style.lineHeight);
  if (Number.isFinite(lineHeight) && lineHeight > 0) return lineHeight;
  const fontSize = Number.parseFloat(style.fontSize);
  return (Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 16) * 1.25;
}

function useViewportHeight() {
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    let frame: number | null = null;
    let lastHeight = -1;
    let lastOffset = -1;

    const apply = () => {
      frame = null;
      const height = viewport?.height ?? window.innerHeight;
      const offset = viewport?.offsetTop ?? 0;
      if (!Number.isFinite(height) || height <= 0) return;
      if (Math.abs(height - lastHeight) < 0.5 && Math.abs(offset - lastOffset) < 0.5) return;
      lastHeight = height;
      lastOffset = offset;
      root.style.setProperty("--app-height", `${height}px`);
      root.style.setProperty("--app-shift", `${offset}px`);
    };
    const schedule = () => {
      if (frame !== null) return;
      frame = requestAnimationFrame(apply);
    };

    apply();
    window.addEventListener("resize", schedule);
    window.addEventListener("orientationchange", schedule);
    viewport?.addEventListener("resize", schedule);
    viewport?.addEventListener("scroll", schedule);
    return () => {
      window.removeEventListener("resize", schedule);
      window.removeEventListener("orientationchange", schedule);
      viewport?.removeEventListener("resize", schedule);
      viewport?.removeEventListener("scroll", schedule);
      if (frame !== null) cancelAnimationFrame(frame);
      root.style.removeProperty("--app-height");
      root.style.removeProperty("--app-shift");
    };
  }, []);
}

interface Attachment {
  key: string;
  preview: string;
  name: string;
  status: "uploading" | "ready" | "error";
  id?: string;
  error?: string;
}

let attachmentKey = 0;

/** Images picked or pasted into the composer, uploaded as soon as they are added. */
function useAttachments() {
  const [items, setItems] = useState<Attachment[]>([]);
  const itemsRef = useRef(items);
  itemsRef.current = items;

  useEffect(
    () => () => {
      for (const item of itemsRef.current) URL.revokeObjectURL(item.preview);
    },
    [],
  );

  const add = useCallback((files: Iterable<File>) => {
    for (const file of files) {
      const key = `a${++attachmentKey}`;
      const preview = URL.createObjectURL(file);
      setItems((current) => [...current, { key, preview, name: file.name, status: "uploading" }]);
      uploadMedia(file).then(
        (ref) =>
          setItems((current) =>
            current.map((item) =>
              item.key === key ? { ...item, status: "ready", id: ref.id } : item,
            ),
          ),
        (error: unknown) =>
          setItems((current) =>
            current.map((item) =>
              item.key === key
                ? {
                    ...item,
                    status: "error",
                    error: error instanceof Error ? error.message : "Upload failed",
                  }
                : item,
            ),
          ),
      );
    }
  }, []);

  const remove = useCallback((key: string) => {
    setItems((current) => {
      const item = current.find((entry) => entry.key === key);
      if (item !== undefined) URL.revokeObjectURL(item.preview);
      return current.filter((entry) => entry.key !== key);
    });
  }, []);

  const clear = useCallback((sent: readonly string[]) => {
    setItems((current) => {
      for (const item of current) if (sent.includes(item.key)) URL.revokeObjectURL(item.preview);
      return current.filter((item) => !sent.includes(item.key));
    });
  }, []);

  /** Puts already uploaded media back, such as the images of a steer taken back. */
  const restore = useCallback((ids: readonly string[]) => {
    setItems((current) => [
      ...current,
      ...ids.map((id) => ({
        key: `a${++attachmentKey}`,
        preview: mediaUrl(id),
        name: id,
        status: "ready" as const,
        id,
      })),
    ]);
  }, []);

  return { items, add, remove, clear, restore };
}

function PlusIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function AttachmentStrip({
  items,
  onRemove,
}: {
  items: Attachment[];
  onRemove: (key: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ul
      aria-label="Attachments"
      data-testid="composer-attachments"
      className="flex gap-2 overflow-x-auto px-2.5 pt-2.5 pb-0.5"
    >
      {items.map((item, index) => (
        <li
          key={item.key}
          data-status={item.status}
          className="relative shrink-0"
          title={item.error ?? item.name}
        >
          <img
            src={item.preview}
            alt={`Attachment ${index + 1}`}
            className={cn(
              "block size-16 rounded-sm border object-cover",
              item.status === "error" ? "border-destructive opacity-60" : "border-foreground/15",
              item.status === "uploading" && "animate-pulse opacity-60",
            )}
          />
          {item.status === "error" && (
            <span className="absolute inset-x-0 bottom-0 truncate bg-destructive px-1 font-mono text-[9px] leading-4 text-white">
              {item.error}
            </span>
          )}
          <button
            type="button"
            aria-label={`Remove attachment ${index + 1}`}
            className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-foreground font-mono text-[11px] leading-none text-background"
            onClick={() => onRemove(item.key)}
          >
            <CloseIcon size={12} />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function Composer({
  tasksPage,
  projectMentions,
  running,
  send,
  stop,
  unsendSteer,
  addTask,
  projects,
  error,
  onDismissError,
  textareaRef,
  inputTestId,
  sendTestId,
  attachTestId,
  inputLabel,
  placeholder,
  draftKey,
}: {
  tasksPage: boolean;
  /** When set, @project suggestions work even if this is not the create-task composer. */
  projectMentions?: boolean;
  running: boolean;
  send: (text: string, mode?: MessageMode, attachments?: string[]) => Promise<boolean>;
  stop: () => Promise<void>;
  unsendSteer?: () => Promise<QueuedMessage | null>;
  /** Without a project a subtask takes its parent's, and a top-level task gets none. */
  addTask: (
    text: string,
    attachments: string[],
    project?: string,
    options?: { backlog?: boolean },
  ) => Promise<boolean>;
  /** Known project names, A–Z, for the `@` autocomplete. */
  projects: string[];
  error: string | null;
  onDismissError: () => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  inputTestId?: string;
  sendTestId?: string;
  attachTestId?: string;
  inputLabel?: string;
  placeholder?: string;
  /** Stable instance: text drafts are stored per target instead of remounting. */
  draftKey?: string;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const key = draftKey ?? "default";
  const value = drafts[key] ?? "";
  const setValue = (text: string) => {
    setDrafts((all) => ({ ...all, [key]: text }));
  };
  const [caret, setCaret] = useState<number | null>(null);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [backlog, setBacklog] = useState(false);
  const backlogPress = useRef<{ timer: number; x: number; y: number } | null>(null);
  const suppressAddClick = useRef(false);
  // Bumped by every user edit, so a failed send can tell an untouched composer from a new draft.
  const draftRevision = useRef(0);
  const mentions = projectMentions ?? tasksPage;
  const mention = mentions && caret !== null ? mentionAt(value, caret) : null;
  const suggestions = mention === null ? [] : projectSuggestions(projects, mention.query);
  const suggesting = mention !== null && dismissedAt !== mention.start && suggestions.length > 0;
  const active = suggesting ? Math.min(activeIndex, suggestions.length - 1) : -1;
  const attachments = useAttachments();
  const fileRef = useRef<HTMLInputElement>(null);
  const uploading = attachments.items.some((item) => item.status === "uploading");
  const failed = attachments.items.some((item) => item.status === "error");
  const readyIds = attachments.items.flatMap((item) =>
    item.status === "ready" && item.id !== undefined ? [item.id] : [],
  );
  const formRef = useRef<HTMLFormElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const rowWidthRef = useRef<number | null>(null);

  const hasText = value.trim().length > 0;
  // A task still needs a title; a chat message can be images alone.
  const canSend = !uploading && !failed && (hasText || (!tasksPage && readyIds.length > 0));

  const addAttachments = (files: Iterable<File>) => {
    draftRevision.current += 1;
    attachments.add(files);
  };
  const removeAttachment = (key: string) => {
    draftRevision.current += 1;
    attachments.remove(key);
  };

  const clearBacklogPress = useCallback(() => {
    const press = backlogPress.current;
    if (press !== null) window.clearTimeout(press.timer);
    backlogPress.current = null;
  }, []);

  useEffect(() => {
    if (!tasksPage) {
      clearBacklogPress();
      setBacklog(false);
      return;
    }
    const onMove = (event: PointerEvent) => {
      const press = backlogPress.current;
      if (press === null) return;
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 10) return;
      clearBacklogPress();
    };
    const onUp = () => clearBacklogPress();
    const onCancel = () => clearBacklogPress();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      clearBacklogPress();
      setBacklog(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("keydown", onKey);
      clearBacklogPress();
    };
  }, [clearBacklogPress, tasksPage]);

  const startBacklogPress = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!tasksPage || !event.isPrimary) return;
    clearBacklogPress();
    suppressAddClick.current = false;
    const x = event.clientX;
    const y = event.clientY;
    backlogPress.current = {
      x,
      y,
      timer: window.setTimeout(() => {
        backlogPress.current = null;
        suppressAddClick.current = true;
        setBacklog((current) => !current);
        haptic();
      }, BACKLOG_LONG_PRESS_MS),
    };
  };

  const resizeTextarea = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    const style = getComputedStyle(element);
    const lineHeight = computedLineHeight(element);
    const paddingY =
      (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
    const borderY =
      (Number.parseFloat(style.borderTopWidth) || 0) +
      (Number.parseFloat(style.borderBottomWidth) || 0);
    const minHeight = Number.parseFloat(style.minHeight) || 0;
    const maxHeight = lineHeight * 8 + paddingY + borderY;

    element.style.height = "0px";
    const scrollHeight = element.scrollHeight;
    const oneLineHeight = Math.max(minHeight, lineHeight + paddingY);
    const contentHeight = scrollHeight + borderY;
    const singleLine = element.value.length === 0 || scrollHeight <= lineHeight + paddingY + 0.5;
    const nextHeight = Math.min(
      Math.max(singleLine ? oneLineHeight : contentHeight, minHeight),
      maxHeight,
    );

    element.style.height = `${nextHeight}px`;
    element.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
    if (singleLine) element.scrollTop = 0;
  }, [textareaRef]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: value drives the autosize and caret reset
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    resizeTextarea();
    if (element.value.length === 0) element.setSelectionRange(0, 0);
  }, [value, resizeTextarea]);

  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    rowWidthRef.current = row.getBoundingClientRect().width;

    const observer = new ResizeObserver(() => {
      const width = row.getBoundingClientRect().width;
      if (rowWidthRef.current !== null && Math.abs(width - rowWidthRef.current) < 0.5) return;
      rowWidthRef.current = width;
      resizeTextarea();
    });
    observer.observe(row);

    let frame: number | null = null;
    const handleOrientation = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        rowWidthRef.current = null;
        resizeTextarea();
      });
    };
    window.addEventListener("orientationchange", handleOrientation);
    return () => {
      observer.disconnect();
      window.removeEventListener("orientationchange", handleOrientation);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [resizeTextarea]);

  const submit = async (mode: MessageMode) => {
    if (!canSend) return;
    const element = textareaRef.current;
    const text = value;
    const ids = readyIds;
    const sentKeys = attachments.items.map((item) => item.key);
    const parsed = tasksPage ? parseProjectToken(text, projects) : null;
    const sentRevision = draftRevision.current;

    // Clear the draft when the send starts: the optimistic bubble is the only feedback
    // while the request is in flight. Snapshot the text and attachments for a rejection.
    setValue("");
    attachments.clear(sentKeys);
    if (element !== null) {
      element.value = "";
      resizeTextarea();
      element.focus({ preventScroll: true });
      element.setSelectionRange(0, 0);
    }

    let sent: boolean;
    if (parsed !== null) {
      sent = await addTask(
        parsed.title,
        ids,
        parsed.project ?? undefined,
        backlog ? { backlog: true } : undefined,
      );
    } else {
      sent = await send(text, mode, ids);
    }
    if (!sent) {
      // A draft typed while the request was pending wins over the rejected text.
      if (draftRevision.current !== sentRevision) return;
      setValue(text);
      attachments.restore(ids);
      if (element !== null) {
        element.value = text;
        resizeTextarea();
        element.focus({ preventScroll: true });
        element.setSelectionRange(text.length, text.length);
      }
      return;
    }
    haptic();
    if (backlog) setBacklog(false);
  };

  const accept = (name: string) => {
    if (mention === null) return;
    const next = acceptMention(value, mention, name);
    setValue(next.text);
    setCaret(next.caret);
    setActiveIndex(0);
    if (error !== null) onDismissError();
    requestAnimationFrame(() => {
      const element = textareaRef.current;
      if (element === null) return;
      element.focus({ preventScroll: true });
      element.setSelectionRange(next.caret, next.caret);
    });
  };

  return (
    <form
      ref={formRef}
      data-testid="composer-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(running ? "steer" : "queue");
      }}
      onDragOver={(event) => {
        if (![...event.dataTransfer.types].includes("Files")) return;
        event.preventDefault();
      }}
      onDrop={(event) => {
        const files = [...event.dataTransfer.files].filter((file) =>
          file.type.startsWith("image/"),
        );
        if (files.length === 0) return;
        event.preventDefault();
        addAttachments(files);
      }}
    >
      {suggesting && (
        <ProjectSuggestions
          anchor={formRef}
          items={suggestions}
          active={active}
          onHover={setActiveIndex}
          onAccept={(item) => accept(item.name)}
        />
      )}
      {error !== null && (
        <p
          id="composer-error"
          role="alert"
          data-testid="composer-error"
          className="px-3 pt-1.5 font-mono text-[11px] leading-4 text-destructive"
        >
          {error}
        </p>
      )}
      <AttachmentStrip items={attachments.items} onRemove={removeAttachment} />
      <div ref={rowRef} className="flex w-full items-end gap-1 p-1.5">
        <input
          ref={fileRef}
          type="file"
          accept={ATTACH_ACCEPT}
          multiple
          hidden
          data-testid={attachTestId ?? "attach-input"}
          onChange={(event) => {
            const files = event.target.files;
            if (files !== null) addAttachments([...files]);
            event.target.value = "";
          }}
        />
        <div className="flex h-9 w-9 shrink-0 items-stretch">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={tasksPage ? "Attach image to task" : "Attach image"}
            className={ACTION_BUTTON_CLASS}
            onClick={() => fileRef.current?.click()}
          >
            <PlusIcon />
          </Button>
        </div>
        <Textarea
          ref={textareaRef}
          data-testid={inputTestId}
          aria-invalid={error !== null ? true : undefined}
          aria-errormessage={error !== null ? "composer-error" : undefined}
          aria-label={inputLabel ?? (tasksPage ? "New task" : "Message")}
          rows={1}
          className={cn("bg-transparent", backlog && "placeholder:text-muted-foreground/60")}
          value={value}
          aria-autocomplete={mentions ? "list" : undefined}
          aria-controls={suggesting ? "project-suggestions" : undefined}
          aria-activedescendant={suggesting ? `project-suggestion-${active}` : undefined}
          onSelect={(event) => {
            if (mentions) setCaret(event.currentTarget.selectionStart);
          }}
          onBlur={() => setCaret(null)}
          placeholder={
            placeholder ?? (tasksPage ? (backlog ? "New backlog task" : "New task") : "Message pi")
          }
          onChange={(event) => {
            draftRevision.current += 1;
            setValue(event.target.value);
            if (mentions) {
              setCaret(event.target.selectionStart);
              setActiveIndex(0);
              setDismissedAt(null);
            }
            if (error !== null) onDismissError();
          }}
          onPaste={(event) => {
            const files = [...event.clipboardData.files].filter((file) =>
              file.type.startsWith("image/"),
            );
            if (files.length === 0) return;
            event.preventDefault();
            addAttachments(files);
          }}
          onKeyDown={(event) => {
            if (suggesting && !event.nativeEvent.isComposing) {
              const count = suggestions.length;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((active + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
                return;
              }
              if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
                event.preventDefault();
                const item = suggestions[active];
                if (item !== undefined) accept(item.name);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setDismissedAt(mention?.start ?? null);
                return;
              }
            }
            // ArrowUp in an empty composer takes back the newest steer the run has not reached.
            if (
              event.key === "ArrowUp" &&
              unsendSteer !== undefined &&
              value.length === 0 &&
              attachments.items.length === 0 &&
              !event.shiftKey &&
              !event.altKey &&
              !event.metaKey &&
              !event.ctrlKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              void unsendSteer().then((steer) => {
                if (steer === null) return;
                draftRevision.current += 1;
                setValue(steer.text);
                if (steer.attachments !== undefined) attachments.restore(steer.attachments);
                const element = textareaRef.current;
                if (element === null) return;
                requestAnimationFrame(() =>
                  element.setSelectionRange(steer.text.length, steer.text.length),
                );
              });
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit(running ? "steer" : "queue");
            }
          }}
        />
        <div className="flex h-9 w-9 shrink-0 items-stretch">
          {tasksPage ? (
            <Button
              key="add-task"
              type="submit"
              variant="ghost"
              size="icon"
              aria-label="Add task"
              aria-pressed={backlog}
              data-testid="add-task"
              data-backlog={backlog ? "true" : undefined}
              title={backlog ? "Add to backlog" : "Add task"}
              className={cn(ACTION_BUTTON_CLASS, backlog && "text-muted-foreground")}
              disabled={!canSend}
              onPointerDown={startBacklogPress}
              onClick={(event) => {
                if (!suppressAddClick.current) return;
                suppressAddClick.current = false;
                event.preventDefault();
              }}
            >
              <span className="flex flex-col items-center justify-center gap-0.5">
                <SendIcon />
                {backlog && (
                  <span
                    data-testid="backlog-chip"
                    className="font-mono text-[7px] leading-none tracking-tight"
                  >
                    Backlog
                  </span>
                )}
              </span>
            </Button>
          ) : running && !hasText && attachments.items.length === 0 ? (
            <Button
              key="stop"
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Stop"
              data-testid={sendTestId === "task-agent-send" ? "task-agent-stop" : undefined}
              className={ACTION_BUTTON_CLASS}
              onClick={() => {
                haptic([12, 40, 12]);
                void stop();
              }}
            >
              <StopIcon />
            </Button>
          ) : running ? (
            <Button
              key="steer"
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Steer"
              data-testid={sendTestId}
              className={ACTION_BUTTON_CLASS}
              disabled={!canSend}
              onClick={() => void submit("steer")}
            >
              <SendIcon />
            </Button>
          ) : (
            <Button
              key="send"
              type="submit"
              variant="ghost"
              size="icon"
              aria-label="Send"
              data-testid={sendTestId}
              className={ACTION_BUTTON_CLASS}
              disabled={!canSend}
            >
              <SendIcon />
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}

/**
 * The row above the oldest loaded message. Coming within a screen of it loads the page before;
 * the stick hook keeps the message on screen in place while the older ones land above it.
 */
function EarlierMessages({
  history,
  scroller,
  attached,
}: {
  history: HistoryControl;
  scroller: { current: HTMLElement | null };
  attached: boolean;
}) {
  const row = useRef<HTMLDivElement | null>(null);
  const { loadEarlier, loading } = history;

  useEffect(() => {
    const element = row.current;
    const root = scroller.current;
    if (element === null || root === null || loading) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        // Before the first scroll to the end the row is in view; only load once the reader
        // has moved off the end, or when the loaded part does not fill the screen.
        if (attached && root.scrollHeight > root.clientHeight + 1) return;
        void loadEarlier();
      },
      { root, rootMargin: "800px 0px 0px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [attached, loadEarlier, loading, scroller]);

  return (
    <div
      ref={row}
      data-testid="earlier-messages"
      data-stick-skip=""
      className="py-1 text-center font-mono text-[11px] text-muted-foreground"
    >
      {loading ? "Loading earlier messages…" : "Earlier messages"}
    </div>
  );
}

function lastUserMessageOrder(timeline: TimelineItem[]): number {
  let order = Number.NEGATIVE_INFINITY;
  for (const item of timeline) {
    // A steer or follow-up the run has not reached does not start a turn of its own.
    if (
      item.kind === "message" &&
      item.message.role === "user" &&
      !item.message.pendingSteer &&
      !item.message.pendingQueue &&
      !item.message.pendingSend
    ) {
      order = Math.max(order, item.message.order);
    }
  }
  return order;
}

export function ChatView({
  timeline,
  running,
  thinking,
  interrupted,
  runError,
  dismissRunError,
  delegates,
  ready,
  tasks,
  taskActivity,
  send,
  stop,
  unsendSteer,
  cancelQueued,
  pendingSteers = 0,
  applyTasks,
  stats,
  refreshStats,
  history,
}: ChatViewProps) {
  useViewportHeight();
  const pager = usePager(PAGES.length, pageFromLocation());
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const lastVibratedPage = useRef(pager.page);
  const [composerError, setComposerError] = useState<string | null>(null);
  const [optimisticTasks, setOptimisticTasks] = useState<OptimisticTask[]>([]);
  const [activityRun, setActivityRun] = useState<string | null | undefined>(
    activityRunFromLocation,
  );
  const activityTriggerRef = useRef<HTMLButtonElement | null>(null);
  const tasksPage = pager.page === TASKS_PAGE;
  // An error belongs to the page it was raised on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on page change only
  useEffect(() => setComposerError(null), [pager.page]);
  const statsPage = pager.page === STATS_PAGE;
  // A working task is still live work, so its project stays part of the vocabulary.
  const projects = useMemo(
    () => projectsOf(tasks.filter((task) => isActiveStatus(task.status))),
    [tasks],
  );
  const [pageAnimating, setPageAnimating] = useState(false);
  const [taskSelection, setTaskSelection] = useState<{ id: string; request: number } | null>(null);
  const [composerMode, setComposerMode] = useState<"create" | "task-chat" | "collapsed">("create");
  const [taskDock, setTaskDock] = useState<TaskDockSession | null>(null);
  const wantTaskDock = tasksPage && composerMode === "task-chat";
  const dockToTask = wantTaskDock && taskDock !== null;
  const hideTasksComposer = statsPage || (tasksPage && composerMode === "collapsed");
  const lastPagerState = useRef({ page: pager.page, dragging: pager.dragging });
  const shownTasks = useMemo(
    () =>
      optimisticTasks.length === 0
        ? tasks
        : [...tasks, ...optimisticTasks.map((item) => item.task)],
    [tasks, optimisticTasks],
  );

  // A task event can land before the create response. Retire the painted card as soon as
  // a row that was not already in the ledger at paint time carries the same title.
  useEffect(() => {
    if (optimisticTasks.length === 0) return;
    setOptimisticTasks((current) => {
      const next = current.filter(
        (item) =>
          !tasks.some(
            (task) =>
              !item.knownIds.has(task.id) &&
              task.title === item.task.title &&
              task.parentId === item.task.parentId &&
              (task.project ?? null) === (item.task.project ?? null),
          ),
      );
      return next.length === current.length ? current : next;
    });
  }, [tasks, optimisticTasks]);

  useEffect(() => {
    if (statsPage) refreshStats?.();
  }, [statsPage, refreshStats]);

  // A page change is the only thing worth a tap of haptics; a snap back to the
  // same page, the first render, and layout-only renders all stay silent.
  useEffect(() => {
    if (lastVibratedPage.current === pager.page) return;
    lastVibratedPage.current = pager.page;
    haptic(10);
  }, [pager.page]);

  // Keep the dock's blur off for the whole pager movement, including a drag that
  // snaps back to the page it started on.
  useLayoutEffect(() => {
    const previous = lastPagerState.current;
    lastPagerState.current = { page: pager.page, dragging: pager.dragging };
    if (previous.page === pager.page && previous.dragging === pager.dragging) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setPageAnimating(false);
      return;
    }
    setPageAnimating(true);
    const timer = window.setTimeout(() => setPageAnimating(false), PAGE_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [pager.page, pager.dragging]);

  // Ctrl+J focuses the composer on whichever page renders it. Only page to
  // chat when the composer is not available there (the stats page keeps the
  // dock mounted but inert while it is collapsed).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return;
      if (event.code !== "KeyJ" && event.key.toLowerCase() !== "j") return;
      event.preventDefault();
      // A dialog owns the focus while it is open, including its own text fields.
      const active = document.activeElement;
      if (active instanceof Element && active.closest('[role="dialog"]') !== null) return;
      const focusField = (element: HTMLTextAreaElement) => {
        element.focus({ preventScroll: true });
        const end = element.value.length;
        element.setSelectionRange(end, end);
      };
      const taskChat = document.querySelector<HTMLTextAreaElement>(
        '[data-testid="task-agent-input"]',
      );
      if (taskChat !== null && taskChat.offsetParent !== null) {
        focusField(taskChat);
        return;
      }
      const element = composerRef.current;
      if (element !== null && element.closest("[inert]") === null) {
        focusField(element);
        return;
      }
      pager.setPage(CHAT_PAGE);
      requestAnimationFrame(() => {
        if (composerRef.current !== null) focusField(composerRef.current);
      });
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pager.setPage]);

  useEffect(() => {
    const id = PAGES[pager.page]?.id;
    if (id === undefined) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("page") === id) return;
    url.searchParams.set("page", id);
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [pager.page]);

  useEffect(() => {
    const onPop = () => pager.setPage(pageFromLocation());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [pager.setPage]);
  useEffect(() => {
    // Fetch the side pages once the chat is up, so a swipe does not wait on the network.
    const timer = window.setTimeout(() => {
      void loadStatsView();
      void loadTasksView();
    }, 300);
    return () => window.clearTimeout(timer);
  }, []);
  const groups = useMemo<TimelineGroup[]>(
    () =>
      groupTimeline(timeline).flatMap((group): TimelineGroup[] => {
        if (group.kind !== "activity") return [group];
        const items = group.items.filter((item) => item.kind !== "job");
        return items.length === 0 ? [] : [{ ...group, items }];
      }),
    [timeline],
  );
  const footerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!statsPage) return;
    const footer = footerRef.current;
    const active = document.activeElement;
    if (footer !== null && active instanceof HTMLElement && footer.contains(active)) active.blur();
  }, [statsPage]);

  // Re-run the stick sync when the transcript changes. The scroller's own
  // ResizeObserver keeps the end pinned while the dock animates below it.
  const stick = useStickToBottom(timeline.length);

  // A page switch is a navigation, not a content change. Hold the reader's position on
  // the way out and put it back before paint, so an off-screen dock resize cannot shift
  // the transcript. The first mount and a drag that snaps back stay untouched.
  const chatPage = pager.page === CHAT_PAGE;
  const wasChatPage = useRef(chatPage);
  useLayoutEffect(() => {
    if (wasChatPage.current === chatPage) return;
    wasChatPage.current = chatPage;
    if (chatPage) stick.restorePosition();
    else stick.holdPosition();
  }, [chatPage, stick.holdPosition, stick.restorePosition]);

  // When a reply finishes, show it from its start (with the run info row above it) instead of
  // leaving the reader at its last line. Only when the reader is still following the end:
  // someone who scrolled away during the run stays where they are.
  const wasRunningRef = useRef(running);
  const [revealAfter, setRevealAfter] = useState<number | null>(null);
  useEffect(() => {
    const was = wasRunningRef.current;
    wasRunningRef.current = running;
    if (running && !was) setRevealAfter(null);
    else if (!running && was && stick.attached) setRevealAfter(lastUserMessageOrder(timeline));
  }, [running, stick.attached, timeline]);
  const revealTop = stick.revealTop;
  useEffect(() => {
    if (revealAfter === null) return;
    let reply: ChatMessage | undefined;
    for (const item of timeline) {
      if (item.kind === "message" && item.message.role === "assistant") {
        if (item.message.order > revealAfter) reply = item.message;
      }
    }
    if (reply === undefined) {
      // The final message can land just after the run state flips; give it a moment.
      const timer = window.setTimeout(() => setRevealAfter(null), 3000);
      return () => window.clearTimeout(timer);
    }
    const id = reply.id;
    setRevealAfter(null);
    requestAnimationFrame(() => {
      const bubble = document.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
      if (bubble === null) return;
      const previous = bubble.previousElementSibling;
      const target =
        previous instanceof HTMLElement &&
        (previous.dataset.testid === "run-info" ||
          previous.dataset.testid === "activity-group" ||
          previous.querySelector('[data-testid="run-info"]') !== null)
          ? previous
          : bubble;
      revealTop(target, TRANSCRIPT_END_GAP);
    });
  }, [revealAfter, timeline, revealTop]);

  const liveActivityGroupKey = useMemo(() => {
    if (!running) return undefined;
    const lastUserOrder = lastUserMessageOrder(timeline);
    for (let index = groups.length - 1; index >= 0; index--) {
      const group = groups[index];
      if (group.kind === "activity" && group.items[0].order > lastUserOrder) {
        return group.key;
      }
    }
    return undefined;
  }, [groups, running, timeline]);

  const handleSend = async (text: string, mode: MessageMode = "queue", attachments?: string[]) => {
    // `send` paints the optimistic bubble before its first await; scroll it into view now.
    const pending = send(text, mode, attachments);
    requestAnimationFrame(() => stick.scrollToBottom());
    const outcome = await pending;
    if (!outcome.ok) {
      if (outcome.error !== null) setComposerError(outcome.error);
      return false;
    }
    haptic();
    setComposerError(null);
    requestAnimationFrame(() => stick.scrollToBottom());
    return true;
  };

  const sendNoticeRef = useRef(handleSend);
  sendNoticeRef.current = handleSend;
  const steerNotice = useCallback((text: string) => {
    void sendNoticeRef.current(text, "steer");
  }, []);

  const addTask = async (
    text: string,
    attachments: string[],
    project?: string,
    options?: { backlog?: boolean },
  ) => {
    const title = text.trim();
    const key = newTaskKey();
    const created: OptimisticTask = {
      key,
      knownIds: new Set(tasks.map((task) => task.id)),
      task: {
        id: `pending-${key}`,
        title,
        status: options?.backlog === true ? "backlog" : "open",
        parentId: null,
        blockedBy: [],
        createdAt: new Date().toISOString(),
        completedAt: null,
        completion: null,
        ...(project === undefined ? {} : { project }),
        createdBy: "operator",
      },
    };
    const retire = () =>
      setOptimisticTasks((current) => current.filter((item) => item.key !== key));
    // Paint the card in this frame; the create request only confirms it.
    if (title.length > 0) setOptimisticTasks((current) => [...current, created]);
    const outcome = await createTask(title, null, attachments, project, options);
    if (!outcome.ok) {
      retire();
      setComposerError(outcome.error);
      return false;
    }
    // Drop the painted copy and take the server's ledger in one render, keyed by its id.
    retire();
    setComposerError(null);
    applyTasks(outcome.ledger);
    if (options?.backlog !== true) {
      const opened = outcome.ledger.tasks
        .filter((task) => !created.knownIds.has(task.id))
        .sort((left, right) => (left.createdAt < right.createdAt ? 1 : -1))[0];
      if (opened !== undefined) {
        openTaskFromChat(opened.id);
        void fetch(`/api/tasks/${encodeURIComponent(opened.id)}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: title }),
        }).catch((error: unknown) => {
          console.error("[pi] could not start the task agent", error);
        });
        requestAnimationFrame(() => {
          window.dispatchEvent(new Event("pi-focus-task-chat"));
        });
      }
    }
    return true;
  };

  const openActivity = (run: string, trigger: HTMLButtonElement) => {
    activityTriggerRef.current = trigger;
    setActivityRun(run);
  };

  const closeActivity = useCallback(() => {
    const trigger = activityTriggerRef.current;
    setActivityRun(undefined);
    const path = window.location.pathname.replace(/\/+$/, "");
    if (path === "/activity") {
      // A direct deep link closes back to the chat rather than reloading the modal.
      const url = new URL(window.location.href);
      url.pathname = "/";
      url.searchParams.delete("run");
      window.history.replaceState(
        window.history.state,
        "",
        `${url.pathname}${url.search}${url.hash}`,
      );
    }
    requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    });
  }, []);

  const selectPage = (index: number) => {
    pager.setPage(index);
  };

  const openTaskFromChat = useCallback(
    (id: string) => {
      pager.setPage(TASKS_PAGE);
      setTaskSelection((current) => ({ id, request: (current?.request ?? 0) + 1 }));
    },
    [pager.setPage],
  );

  const content = (
    <div className="chat-shell min-h-0" data-testid="chat-shell">
      {interrupted && (
        <div
          role="status"
          className="flex shrink-0 items-center justify-center gap-1.5 border-b border-border bg-muted py-1.5 text-center font-mono text-[11px] text-foreground"
        >
          <NoticeIcon name="warning" size={14} />
          run interrupted — the last response may be partial
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        {runError !== undefined && runError !== null && dismissRunError !== undefined && (
          <RunErrorHeader error={runError} onDismiss={dismissRunError} />
        )}
        <div
          {...pager.pagerProps}
          data-testid="pager"
          data-page={PAGES[pager.page].id}
          className="absolute inset-0 overflow-hidden overscroll-x-none"
        >
          <div
            className={cn(
              "flex h-full w-full",
              pager.dragging
                ? "transition-none"
                : "transition-transform duration-300 ease-out motion-reduce:transition-none",
            )}
            style={{
              transform: `translate3d(calc(${-pager.page * 100}% + ${pager.dragX}px), 0, 0)`,
            }}
          >
            <section
              className="h-full min-w-0 shrink-0 grow-0 basis-full"
              aria-label="Stats"
              aria-hidden={pager.page !== STATS_PAGE && !pager.dragging}
              inert={pager.page !== STATS_PAGE && !pager.dragging ? true : undefined}
            >
              <Suspense fallback={null}>
                <StatsView stats={stats} ready={ready} active={statsPage} footerClearance={0} />
              </Suspense>
            </section>
            <section
              className="flex h-full min-h-0 min-w-0 shrink-0 grow-0 basis-full flex-col"
              aria-hidden={pager.page !== CHAT_PAGE && !pager.dragging}
              inert={pager.page !== CHAT_PAGE && !pager.dragging ? true : undefined}
            >
              <main ref={stick.containerRef} data-testid="chat-scroller" className="chat-scroller">
                <div
                  ref={stick.contentRef}
                  data-testid="chat-content"
                  className="mx-auto flex w-full max-w-[72ch] flex-col gap-4 px-4"
                  style={{
                    paddingTop: TRANSCRIPT_END_GAP,
                    paddingBottom: TRANSCRIPT_END_GAP,
                  }}
                >
                  {!ready && (
                    <p
                      data-testid="chat-loading"
                      className="theme-radius w-fit self-center border border-border bg-surface/90 px-3 py-1.5 font-mono text-xs text-muted-foreground shadow-sm backdrop-blur-md"
                    >
                      Loading…
                    </p>
                  )}
                  {history?.hasEarlier === true && (
                    <EarlierMessages
                      history={history}
                      scroller={stick.containerRef}
                      attached={stick.attached}
                    />
                  )}
                  {groups.map((group, index) => {
                    if (group.kind === "message") {
                      return (
                        <MemoMessageBubble
                          key={group.key}
                          message={group.message}
                          onSteer={steerNotice}
                          onCancelQueued={cancelQueued}
                        />
                      );
                    }
                    const next = groups[index + 1];
                    const usage =
                      next?.kind === "message" && next.message.role === "assistant"
                        ? next.message.usage
                        : undefined;
                    return (
                      <ActivityGroup
                        key={group.key}
                        groupKey={group.key}
                        items={group.items}
                        live={group.key === liveActivityGroupKey}
                        usage={usage}
                        onOpen={openActivity}
                      />
                    );
                  })}
                </div>
              </main>
            </section>
            <section
              className="h-full min-w-0 shrink-0 grow-0 basis-full"
              aria-label="Tasks"
              aria-hidden={pager.page !== TASKS_PAGE && !pager.dragging}
              inert={pager.page !== TASKS_PAGE && !pager.dragging ? true : undefined}
            >
              <Suspense fallback={null}>
                <TasksView
                  tasks={shownTasks}
                  activity={taskActivity}
                  ready={ready}
                  footerClearance={0}
                  onLedger={applyTasks}
                  selection={taskSelection}
                  onComposerMode={setComposerMode}
                />
              </Suspense>
            </section>
          </div>
        </div>
        {ready && groups.length === 0 && pager.page === CHAT_PAGE && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-4">
            <EmptyCaption mono>Send a message to start.</EmptyCaption>
          </div>
        )}
        {!stick.attached && pager.page === CHAT_PAGE && (
          <div
            className="pointer-events-none absolute inset-x-0 z-20 flex justify-center"
            style={{ bottom: 8 }}
          >
            <button
              type="button"
              data-testid="latest-button"
              className="pointer-events-auto inline-flex items-center gap-1.5 bg-foreground px-2 py-1 font-mono text-[11px] text-background"
              onClick={stick.scrollToBottom}
            >
              <ArrowDownIcon size={14} />
              latest
            </button>
          </div>
        )}
      </div>
      <div
        ref={footerRef}
        data-testid="composer-dock"
        data-transitioning={pager.dragging || pageAnimating ? "true" : undefined}
        className="float-footer relative z-20 theme-radius"
      >
        <div data-testid="composer-slide">
          <div className="ink-line flex items-center gap-3 border-b py-1.5 pr-1.5 pl-[18px]">
            <div
              data-testid="working-status"
              data-open={running ? "true" : "false"}
              aria-live="polite"
              className="min-w-0 flex-1 truncate font-mono text-[11px] leading-4 text-muted-foreground"
            >
              {running ? (
                <WorkingIndicator running={running} thinking={thinking} />
              ) : (
                // Idle is a server statement. Before the first snapshot the answer
                // is not known yet, so do not paint a guess that can be wrong.
                <span>{ready ? "idle" : "connecting"}</span>
              )}
            </div>
            <div
              role="tablist"
              aria-label="Pages"
              data-testid="page-dots"
              className="flex shrink-0 items-center justify-center"
            >
              {PAGES.map((item, index) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={pager.page === index}
                  aria-label={item.label}
                  data-testid={`page-dot-${item.id}`}
                  className="grid h-6 w-6 place-items-center"
                  onClick={() => selectPage(index)}
                >
                  <span
                    className={cn(
                      "block rounded-full transition-[width,height,border-radius] duration-200 ease-out motion-reduce:transition-none",
                      pager.page === index
                        ? "size-3 rounded-[4px] bg-foreground"
                        : "size-1.5 bg-foreground/40",
                    )}
                  />
                </button>
              ))}
            </div>
            <PiMenu />
          </div>
          <div
            data-testid="composer-body"
            data-hidden={hideTasksComposer ? "true" : "false"}
            data-collapsed={hideTasksComposer ? "true" : "false"}
            aria-hidden={hideTasksComposer ? true : undefined}
            inert={hideTasksComposer ? true : undefined}
            className="composer-body"
          >
            <Composer
              draftKey={
                wantTaskDock
                  ? taskDock !== null
                    ? `task:${taskDock.taskId}`
                    : "task:pending"
                  : "main"
              }
              tasksPage={tasksPage && !wantTaskDock}
              projectMentions={wantTaskDock ? true : undefined}
              running={dockToTask ? taskDock.running : running}
              send={
                dockToTask
                  ? async (text, mode, attachments) =>
                      await Promise.resolve(taskDock.send(text, mode, attachments ?? []))
                  : wantTaskDock
                    ? async () => false
                    : handleSend
              }
              stop={dockToTask ? () => Promise.resolve(taskDock.stop()) : stop}
              unsendSteer={!tasksPage && pendingSteers > 0 ? unsendSteer : undefined}
              addTask={addTask}
              projects={projects}
              error={dockToTask ? taskDock.error : composerError}
              onDismissError={dockToTask ? taskDock.dismissError : () => setComposerError(null)}
              textareaRef={composerRef}
              inputTestId={wantTaskDock ? "task-agent-input" : undefined}
              sendTestId={wantTaskDock ? "task-agent-send" : undefined}
              attachTestId={wantTaskDock ? "task-agent-attach" : undefined}
              inputLabel={wantTaskDock ? "Task message" : undefined}
              placeholder={
                wantTaskDock
                  ? (taskDock?.placeholder ?? "Ask the planning agent to help formulate this task.")
                  : undefined
              }
            />
          </div>
        </div>
      </div>
      {activityRun !== undefined && (
        <Suspense fallback={null}>
          <ActivityDialog
            timeline={timeline}
            ready={ready}
            run={activityRun}
            delegates={delegates}
            onClose={closeActivity}
          />
        </Suspense>
      )}
    </div>
  );

  return (
    <TaskLinkProvider tasks={shownTasks} openTask={openTaskFromChat}>
      <TaskDockComposerProvider onSession={setTaskDock}>{content}</TaskDockComposerProvider>
    </TaskLinkProvider>
  );
}
