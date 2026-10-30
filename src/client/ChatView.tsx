import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  ActivityItem,
  ChatMessage,
  MessageMode,
  Task,
  TaskLedger,
  TokenSpend,
} from "../shared/types";
import { groupSummaryParts } from "./activity-format";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import {
  DeferredMarkdown,
  LazyInlineMarkdown,
  lazyPlainInline,
  loadMarkdown,
} from "./lazy-markdown";
import { cn } from "./lib/utils";
import { ATTACH_ACCEPT, mediaUrl, uploadMedia } from "./media-client";
import { NoticeLine } from "./NoticeView";
import { PiMenu } from "./PiMenu";
import type { ChatStats } from "./StatsView";
import { createTask } from "./task-client";
import { groupTimeline } from "./timeline-groups";
import type { SendOutcome, TimelineItem } from "./use-chat";
import { usePager } from "./use-pager";
import { useStickToBottom } from "./use-stick-to-bottom";
import { type RunClock, WorkingIndicator } from "./WorkingIndicator";

interface ChatViewProps {
  timeline: TimelineItem[];
  running: boolean;
  interrupted: boolean;
  /** When the run started and when the agent last did anything, for the working strip. */
  runClock?: RunClock;
  ready: boolean;
  tasks: Task[];
  send: (text: string, mode?: MessageMode, attachments?: string[]) => Promise<SendOutcome>;
  stop: () => Promise<void>;
  applyTasks: (ledger: TaskLedger) => void;
  stats: ChatStats;
  refreshStats?: () => void;
  history?: HistoryControl;
}

// The side pages and the Markdown renderer are their own chunks, so the chat paints first.
const loadStatsView = () => import("./StatsView");
const loadTasksView = () => import("./TasksView");
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

function SubtaskProgress({ tasks }: { tasks: Task[] }) {
  const subtasks = tasks.filter((task) => task.parentId !== null);
  if (subtasks.length === 0) return null;
  const done = subtasks.filter((task) => task.status === "done").length;
  const label = `${done}/${subtasks.length} completed subtasks`;
  return (
    <span
      role="status"
      data-testid="subtask-progress"
      title={label}
      aria-label={label}
      className="shrink-0 font-mono text-[11px] leading-4 text-muted-foreground"
    >
      {done}/{subtasks.length}
    </span>
  );
}

function pageFromLocation(): number {
  const name = new URLSearchParams(window.location.search).get("page");
  const index = PAGES.findIndex((item) => item.id === name);
  return index < 0 ? CHAT_PAGE : index;
}

/** Local wall-clock `hh:mm` for a message, or null when the timestamp does not parse. */
function clockTime(timestamp: string): string | null {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function MessageTime({ timestamp }: { timestamp: string }) {
  const time = clockTime(timestamp);
  if (time === null) return null;
  return (
    <div className="-mb-0.5 mt-1 text-right font-mono text-[10px] leading-none text-muted-foreground tabular-nums">
      <time dateTime={timestamp} title={new Date(timestamp).toLocaleString()}>
        {time}
      </time>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.notice !== undefined) {
    return <NoticeLine message={message} notice={message.notice} />;
  }
  if (message.role === "system") {
    return (
      <div className="px-2 py-1 text-center font-mono text-[11px] text-muted-foreground">
        ⚠ {message.text}
      </div>
    );
  }

  const mine = message.role === "user";
  const framed = mine || message.isError === true || message.partial === true;
  return (
    <div
      data-message-id={message.id}
      data-role={message.role}
      className={cn(
        "theme-radius w-fit min-w-0 max-w-[85%] bg-surface px-3 py-2 text-sm leading-relaxed [overflow-wrap:anywhere]",
        mine ? "ml-auto" : "mr-auto",
        framed && "border",
        mine && "border-foreground/15",
        message.isError && "border-destructive text-destructive",
        message.partial && "border-dashed",
        message.partial && !message.isError && "border-muted-foreground/70",
      )}
    >
      {message.steer && (
        <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          steer
        </div>
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
      {mine ? (
        message.text.length > 0 && (
          <div className="whitespace-pre-wrap [overflow-wrap:anywhere]">{message.text}</div>
        )
      ) : (
        <DeferredMarkdown text={message.text} />
      )}
      <MessageTime timestamp={message.timestamp} />
    </div>
  );
}

function ActivityGroup({
  groupKey,
  items,
  live,
  usage,
}: {
  groupKey: string;
  items: ActivityItem[];
  live: boolean;
  usage?: TokenSpend;
}) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!live) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [live]);

  const parts = groupSummaryParts(items, live, now, usage);
  return (
    <a
      href={`/activity?run=${encodeURIComponent(groupKey)}`}
      data-testid="run-info"
      aria-label={`Run activity: ${parts.join(", ")}`}
      className="theme-radius flex min-h-9 w-fit min-w-0 max-w-full items-start gap-2 border border-border/70 bg-surface px-2.5 py-2 font-mono text-xs leading-5 text-muted-foreground hover:text-foreground sm:min-h-0 sm:py-1.5"
    >
      <span aria-hidden="true" className="inline-block w-3 shrink-0">
        ▸
      </span>
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
    </a>
  );
}

const ACTION_BUTTON_CLASS = "h-9 w-full hover:bg-foreground/10";
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

function usesCoarsePointer(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(pointer: coarse)").matches;
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

  return { items, add, remove, clear };
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
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}

function Composer({
  tasksPage,
  parentTitle,
  running,
  send,
  stop,
  addTask,
  error,
  onDismissError,
}: {
  tasksPage: boolean;
  parentTitle: string | null;
  running: boolean;
  send: (text: string, mode?: MessageMode, attachments?: string[]) => Promise<boolean>;
  stop: () => Promise<void>;
  addTask: (text: string, attachments?: string[]) => Promise<boolean>;
  error: string | null;
  onDismissError: () => void;
}) {
  const [value, setValue] = useState("");
  const attachments = useAttachments();
  const fileRef = useRef<HTMLInputElement>(null);
  const uploading = attachments.items.some((item) => item.status === "uploading");
  const failed = attachments.items.some((item) => item.status === "error");
  const readyIds = attachments.items.flatMap((item) =>
    item.status === "ready" && item.id !== undefined ? [item.id] : [],
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const rowWidthRef = useRef<number | null>(null);

  const hasText = value.trim().length > 0;
  // A task still needs a title; a chat message can be images alone.
  const canSend = !uploading && !failed && (hasText || (!tasksPage && readyIds.length > 0));

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
  }, []);

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
    const coarse = usesCoarsePointer();
    const ids = readyIds;
    const sentKeys = attachments.items.map((item) => item.key);
    const sent = tasksPage ? await addTask(text, ids) : await send(text, mode, ids);
    if (!sent) return;
    attachments.clear(sentKeys);
    // Keep a draft typed while the request was in flight; only clear the text we sent.
    if (element !== null && element.value !== text) return;
    setValue("");
    if (element === null) return;
    if (coarse) {
      element.blur();
    } else {
      element.focus({ preventScroll: true });
      element.setSelectionRange(0, 0);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit(running ? "steer" : "queue");
      }}
    >
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
      <AttachmentStrip items={attachments.items} onRemove={attachments.remove} />
      <div ref={rowRef} className="flex w-full items-end gap-1 p-1.5">
        <input
          ref={fileRef}
          type="file"
          accept={ATTACH_ACCEPT}
          multiple
          hidden
          data-testid="attach-input"
          onChange={(event) => {
            const files = event.target.files;
            if (files !== null) attachments.add([...files]);
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
          aria-invalid={error !== null ? true : undefined}
          aria-errormessage={error !== null ? "composer-error" : undefined}
          aria-label={tasksPage ? (parentTitle === null ? "New task" : "New subtask") : "Message"}
          rows={1}
          className="bg-transparent"
          value={value}
          placeholder={
            tasksPage
              ? parentTitle === null
                ? "New task"
                : `Subtask of ${parentTitle}`
              : "Message pi"
          }
          onChange={(event) => {
            setValue(event.target.value);
            if (error !== null) onDismissError();
          }}
          onPaste={(event) => {
            const files = [...event.clipboardData.files].filter((file) =>
              file.type.startsWith("image/"),
            );
            if (files.length === 0) return;
            event.preventDefault();
            attachments.add(files);
          }}
          onKeyDown={(event) => {
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
              className={ACTION_BUTTON_CLASS}
              disabled={!canSend}
            >
              <SendIcon />
            </Button>
          ) : running && !hasText && attachments.items.length === 0 ? (
            <Button
              key="stop"
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Stop"
              className={ACTION_BUTTON_CLASS}
              onClick={() => void stop()}
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
    if (item.kind === "message" && item.message.role === "user") {
      order = Math.max(order, item.message.order);
    }
  }
  return order;
}

export function ChatView({
  timeline,
  running,
  interrupted,
  runClock,
  ready,
  tasks,
  send,
  stop,
  applyTasks,
  stats,
  refreshStats,
  history,
}: ChatViewProps) {
  useViewportHeight();
  const pager = usePager(PAGES.length, pageFromLocation());
  const [armedParentId, setArmedParentId] = useState<string | null>(null);
  const [composerError, setComposerError] = useState<string | null>(null);
  const tasksPage = pager.page === TASKS_PAGE;
  // An error belongs to the page it was raised on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset on page change only
  useEffect(() => setComposerError(null), [pager.page]);
  const statsPage = pager.page === STATS_PAGE;
  const armed = tasks.find((task) => task.id === armedParentId) ?? null;

  useEffect(() => {
    if (!tasksPage || (armedParentId !== null && armed === null)) setArmedParentId(null);
  }, [armed, armedParentId, tasksPage]);

  useEffect(() => {
    if (statsPage) refreshStats?.();
  }, [statsPage, refreshStats]);

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
  const groups = useMemo(() => groupTimeline(timeline), [timeline]);
  const headerRef = useRef<HTMLElement | null>(null);
  const footerRef = useRef<HTMLDivElement | null>(null);
  const [headerClearance, setHeaderClearance] = useState(0);
  const [footerClearance, setFooterClearance] = useState(0);

  useLayoutEffect(() => {
    const header = headerRef.current;
    const footer = footerRef.current;
    const container = footer?.parentElement;
    if (header === null || footer === null || container == null) return;
    const measure = () => {
      const containerBox = container.getBoundingClientRect();
      const headerBox = header.getBoundingClientRect();
      const footerBox = footer.getBoundingClientRect();
      const nextHeader = headerBox.bottom - containerBox.top;
      const nextFooter = containerBox.bottom - footerBox.top;
      setHeaderClearance((current) =>
        Math.abs(current - nextHeader) < 0.5 ? current : nextHeader,
      );
      setFooterClearance((current) =>
        Math.abs(current - nextFooter) < 0.5 ? current : nextFooter,
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(header);
    observer.observe(footer);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Re-run the stick sync when the transcript or either floating bar changes height.
  // A run slides a status line out of the composer, and the composer grows with the draft.
  const stick = useStickToBottom(`${timeline.length}:${footerClearance}:${headerClearance}`);

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
        previous instanceof HTMLElement && previous.dataset.testid === "run-info"
          ? previous
          : bubble;
      revealTop(target, headerClearance + TRANSCRIPT_END_GAP);
    });
  }, [revealAfter, timeline, revealTop, headerClearance]);

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
    const outcome = await send(text, mode, attachments);
    if (!outcome.ok) {
      if (outcome.error !== null) setComposerError(outcome.error);
      return false;
    }
    setComposerError(null);
    requestAnimationFrame(() => stick.scrollToBottom());
    return true;
  };

  const addTask = async (text: string, attachments: string[] = []) => {
    const outcome = await createTask(text, tasksPage ? (armed?.id ?? null) : null, attachments);
    if (!outcome.ok) {
      setComposerError(outcome.error);
      return false;
    }
    setComposerError(null);
    applyTasks(outcome.ledger);
    return true;
  };

  const selectPage = (index: number) => {
    pager.setPage(index);
    if (index !== TASKS_PAGE) setArmedParentId(null);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      {interrupted && (
        <div
          role="status"
          className="shrink-0 border-b border-border bg-muted py-1.5 text-center font-mono text-[11px] text-foreground"
        >
          ⚠ run interrupted — the last response may be partial
        </div>
      )}

      <div className="relative min-h-0 flex-1">
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
                <StatsView
                  stats={stats}
                  ready={ready}
                  active={statsPage}
                  headerClearance={headerClearance}
                  footerClearance={footerClearance}
                />
              </Suspense>
            </section>
            <section
              className="h-full min-w-0 shrink-0 grow-0 basis-full"
              aria-hidden={pager.page !== CHAT_PAGE && !pager.dragging}
              inert={pager.page !== CHAT_PAGE && !pager.dragging ? true : undefined}
            >
              <main ref={stick.containerRef} className="h-full overflow-x-hidden overflow-y-auto">
                <div
                  ref={stick.contentRef}
                  className="mx-auto flex w-full max-w-[72ch] flex-col gap-4 px-4"
                  style={{
                    paddingTop: headerClearance + TRANSCRIPT_END_GAP,
                    paddingBottom: footerClearance + TRANSCRIPT_END_GAP,
                  }}
                >
                  {!ready && <p className="font-mono text-xs text-muted-foreground">Loading…</p>}
                  {history?.hasEarlier === true && (
                    <EarlierMessages
                      history={history}
                      scroller={stick.containerRef}
                      attached={stick.attached}
                    />
                  )}
                  {groups.map((group, index) => {
                    if (group.kind === "message") {
                      return <MessageBubble key={group.key} message={group.message} />;
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
                  tasks={tasks}
                  ready={ready}
                  headerClearance={headerClearance}
                  footerClearance={footerClearance}
                  armedParentId={armed?.id ?? null}
                  onArmParent={setArmedParentId}
                  onLedger={applyTasks}
                />
              </Suspense>
            </section>
          </div>
        </div>
        <header ref={headerRef} className="float-header absolute z-10 flex flex-col theme-radius">
          <div className="grid w-full grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center px-[18px] py-1.5">
            <div className="justify-self-start">
              <PiMenu />
            </div>
            <div
              role="tablist"
              aria-label="Pages"
              data-testid="page-dots"
              className="flex items-center justify-center"
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
                      "block h-1.5 rounded-full",
                      pager.page === index ? "w-4 bg-foreground" : "w-1.5 bg-foreground/40",
                    )}
                  />
                </button>
              ))}
            </div>
            <div className="flex min-w-0 max-w-full items-center justify-end gap-3 justify-self-end overflow-hidden empty:hidden">
              {tasksPage && <SubtaskProgress tasks={tasks} />}
            </div>
          </div>
        </header>
        {ready && groups.length === 0 && pager.page === CHAT_PAGE && (
          <p
            className="pointer-events-none absolute inset-x-0 z-10 -translate-y-1/2 px-4 text-center font-mono text-xs text-muted-foreground"
            style={{ top: `calc((100% - ${footerClearance}px) / 2)` }}
          >
            Send a message to start.
          </p>
        )}
        {!stick.attached && pager.page === CHAT_PAGE && (
          <div
            className="pointer-events-none absolute inset-x-0 z-20 flex justify-center"
            style={{ bottom: footerClearance + 8 }}
          >
            <button
              type="button"
              className="pointer-events-auto bg-foreground px-2 py-1 font-mono text-[11px] text-background"
              onClick={stick.scrollToBottom}
            >
              ↓ latest
            </button>
          </div>
        )}

        <div ref={footerRef} className="float-footer absolute z-20 theme-radius">
          <div
            data-testid="working-status"
            data-open={running ? "true" : "false"}
            aria-hidden={running ? undefined : true}
            className="working-strip"
          >
            <div className="working-strip-clip">
              <div
                aria-live="polite"
                className="working-strip-slide ink-line flex w-full min-w-0 items-center border-b px-[18px] py-1.5 font-mono text-[11px] leading-4 text-muted-foreground"
              >
                <WorkingIndicator running={running} clock={runClock} />
              </div>
            </div>
          </div>
          {tasksPage && armed !== null && (
            <div className="flex items-center gap-2 px-3 font-mono text-[10px] text-muted-foreground">
              <span className="min-w-0 truncate">
                subtask of <LazyInlineMarkdown text={armed.title} />
              </span>
              <button
                type="button"
                className="shrink-0 hover:text-foreground"
                aria-label="New top-level task"
                onClick={() => setArmedParentId(null)}
              >
                top level
              </button>
            </div>
          )}
          <Composer
            tasksPage={tasksPage}
            parentTitle={tasksPage && armed !== null ? lazyPlainInline(armed.title) : null}
            running={running}
            send={handleSend}
            stop={stop}
            addTask={addTask}
            error={composerError}
            onDismissError={() => setComposerError(null)}
          />
        </div>
      </div>
    </div>
  );
}
