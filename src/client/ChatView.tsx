import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  ActivityItem,
  ChatMessage,
  McpEventsState,
  MessageMode,
  Task,
  TaskLedger,
} from "../shared/types";
import { activityLabel, groupSummary } from "./activity-format";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { cn } from "./lib/utils";
import { Markdown } from "./markdown";
import { PiMenu } from "./PiMenu";
import { TasksView } from "./TasksView";
import { createTask } from "./task-client";
import { groupTimeline } from "./timeline-groups";
import type { TimelineItem } from "./use-chat";
import { usePager } from "./use-pager";
import { useStickToBottom } from "./use-stick-to-bottom";
import { WorkingIndicator } from "./WorkingIndicator";

const LIVE_STATUS = new Set(["opening", "active", "reconnecting"]);

interface ChatViewProps {
  timeline: TimelineItem[];
  running: boolean;
  interrupted: boolean;
  runStartedAt: string | null;
  mcpEvents: McpEventsState;
  unavailableServers: string[];
  ready: boolean;
  tasks: Task[];
  send: (text: string, mode?: MessageMode) => Promise<boolean>;
  stop: () => Promise<void>;
  applyTasks: (ledger: TaskLedger) => void;
}

const PAGES = [
  { id: "chat", label: "Chat" },
  { id: "tasks", label: "Tasks" },
] as const;

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
  return index < 0 ? 0 : index;
}

function MessageBubble({ message }: { message: ChatMessage }) {
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
      className={cn(
        "theme-radius w-fit max-w-[85%] bg-surface px-3 py-2 text-sm leading-relaxed",
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
      {mine ? (
        <div className="whitespace-pre-wrap break-words">{message.text}</div>
      ) : (
        <Markdown text={message.text} />
      )}
    </div>
  );
}

function ActivityGroup({
  groupKey,
  items,
  live,
}: {
  groupKey: string;
  items: ActivityItem[];
  live: boolean;
}) {
  return (
    <a
      href={`/activity?run=${encodeURIComponent(groupKey)}`}
      className="flex min-w-0 items-center gap-2 font-mono text-xs text-muted-foreground hover:text-foreground"
    >
      <span aria-hidden="true" className="inline-block w-3 shrink-0">
        ▸
      </span>
      <span className="truncate whitespace-nowrap">{groupSummary(items, live)}</span>
    </a>
  );
}

function McpHeader({ events }: { events: McpEventsState }) {
  const names: string[] = [];
  for (const subscription of events.subscriptions) {
    if (!LIVE_STATUS.has(subscription.status) || names.includes(subscription.server)) continue;
    names.push(subscription.server);
  }
  if (names.length === 0 && events.notice === null) return null;
  return (
    <>
      {names.length > 0 && (
        <a
          href="/events"
          data-testid="mcp-subscriptions"
          title={names.join(" · ")}
          className="min-w-0 truncate font-mono text-[11px] leading-4 text-muted-foreground hover:text-foreground"
        >
          {names.join(" · ")}
        </a>
      )}
      {events.notice !== null && (
        <span
          data-testid="mcp-event-notice"
          className="min-w-0 truncate font-mono text-[11px] leading-4 text-foreground"
        >
          {events.notice}
        </span>
      )}
    </>
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
  send: (text: string, mode?: MessageMode) => Promise<boolean>;
  stop: () => Promise<void>;
  addTask: (text: string) => Promise<boolean>;
  error: string | null;
  onDismissError: () => void;
}) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const rowWidthRef = useRef<number | null>(null);
  const canSend = value.trim().length > 0;

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
    const sent = tasksPage ? await addTask(text) : await send(text, mode);
    if (!sent) return;
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
      <div ref={rowRef} className="flex w-full items-end gap-2 p-1.5">
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
          ) : running && !canSend ? (
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
  runStartedAt,
  mcpEvents,
  unavailableServers,
  ready,
  tasks,
  send,
  stop,
  applyTasks,
}: ChatViewProps) {
  useViewportHeight();
  const pager = usePager(PAGES.length, pageFromLocation());
  const [armedParentId, setArmedParentId] = useState<string | null>(null);
  const [composerError, setComposerError] = useState<string | null>(null);
  const tasksPage = pager.page === 1;
  const armed = tasks.find((task) => task.id === armedParentId) ?? null;

  useEffect(() => {
    if (!tasksPage || (armedParentId !== null && armed === null)) setArmedParentId(null);
  }, [armed, armedParentId, tasksPage]);

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
  // A run adds a status line to the header, and the composer grows with the draft.
  const stick = useStickToBottom(`${timeline.length}:${footerClearance}:${headerClearance}`);

  const currentTool = useMemo(() => {
    if (!running) return undefined;
    const lastUserOrder = lastUserMessageOrder(timeline);
    for (let index = timeline.length - 1; index >= 0; index--) {
      const item = timeline[index];
      if (
        item.kind === "activity" &&
        item.activity.kind === "tool" &&
        item.activity.pending === true &&
        item.activity.order > lastUserOrder
      ) {
        return item.activity;
      }
    }
    return undefined;
  }, [running, timeline]);

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

  const handleSend = async (text: string, mode: MessageMode = "queue") => {
    const sent = await send(text, mode);
    if (sent) requestAnimationFrame(() => stick.scrollToBottom());
    return sent;
  };

  const addTask = async (text: string) => {
    const outcome = await createTask(text, tasksPage ? (armed?.id ?? null) : null);
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
    if (index !== 1) setArmedParentId(null);
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
              aria-hidden={pager.page !== 0 && !pager.dragging}
              inert={pager.page !== 0 && !pager.dragging ? true : undefined}
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
                  {groups.map((group) =>
                    group.kind === "message" ? (
                      <MessageBubble key={group.key} message={group.message} />
                    ) : (
                      <ActivityGroup
                        key={group.key}
                        groupKey={group.key}
                        items={group.items}
                        live={group.key === liveActivityGroupKey}
                      />
                    ),
                  )}
                </div>
              </main>
            </section>
            <section
              className="h-full min-w-0 shrink-0 grow-0 basis-full"
              aria-label="Tasks"
              aria-hidden={pager.page !== 1 && !pager.dragging}
              inert={pager.page !== 1 && !pager.dragging ? true : undefined}
            >
              <TasksView
                tasks={tasks}
                ready={ready}
                headerClearance={headerClearance}
                footerClearance={footerClearance}
                armedParentId={armed?.id ?? null}
                onArmParent={setArmedParentId}
                onLedger={applyTasks}
              />
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
            <div className="flex min-w-0 items-center justify-end gap-3 justify-self-end empty:hidden">
              <McpHeader events={mcpEvents} />
              {unavailableServers.length > 0 && (
                <span
                  role="note"
                  data-testid="mcp-unavailable"
                  title={unavailableServers.map((name) => `${name} unavailable`).join(" · ")}
                  className="min-w-0 truncate font-mono text-[11px] leading-4 text-muted-foreground"
                >
                  {unavailableServers.map((name) => `${name} unavailable`).join(" · ")}
                </span>
              )}
              {tasksPage && <SubtaskProgress tasks={tasks} />}
            </div>
          </div>
          {running && (
            <div
              data-testid="working-status"
              aria-live="polite"
              className="flex w-full min-w-0 items-center gap-2 border-t border-border px-[18px] py-1.5 font-mono text-[11px] leading-4 text-muted-foreground"
            >
              <WorkingIndicator running={running} startedAt={runStartedAt} />
              <span
                data-testid="header-activity"
                title={currentTool === undefined ? "working" : activityLabel(currentTool)}
                className="min-w-0 truncate"
              >
                {currentTool === undefined ? "working" : activityLabel(currentTool)}
              </span>
            </div>
          )}
        </header>
        {ready && groups.length === 0 && pager.page === 0 && (
          <p
            className="pointer-events-none absolute inset-x-0 z-10 -translate-y-1/2 px-4 text-center font-mono text-xs text-muted-foreground"
            style={{ top: `calc((100% - ${footerClearance}px) / 2)` }}
          >
            Send a message to start.
          </p>
        )}
        {!stick.attached && pager.page === 0 && (
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
          {tasksPage && armed !== null && (
            <div className="flex items-center gap-2 px-3 font-mono text-[10px] text-muted-foreground">
              <span className="min-w-0 truncate">subtask of {armed.title}</span>
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
            parentTitle={tasksPage ? (armed?.title ?? null) : null}
            running={running}
            send={handleSend}
            stop={stop}
            addTask={addTask}
            error={tasksPage ? composerError : null}
            onDismissError={() => setComposerError(null)}
          />
        </div>
      </div>
    </div>
  );
}
