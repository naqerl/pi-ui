import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ActivityItem, ChatMessage, MessageMode, QueuedMessage } from "../shared/types";
import { activitySummary, groupSummary } from "./activity-format";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { cn } from "./lib/utils";
import { Markdown } from "./markdown";
import { groupTimeline } from "./timeline-groups";
import type { TimelineItem } from "./use-chat";
import { useStickToBottom } from "./use-stick-to-bottom";
import { WorkingIndicator } from "./WorkingIndicator";

interface ChatViewProps {
  timeline: TimelineItem[];
  running: boolean;
  interrupted: boolean;
  runStartedAt: string | null;
  queue: QueuedMessage[];
  ready: boolean;
  send: (text: string, mode?: MessageMode) => Promise<boolean>;
  cancelQueued: (id: string) => Promise<boolean>;
  steerQueued: (id: string) => Promise<boolean>;
  stop: () => Promise<void>;
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
  return (
    <div
      className={cn(
        "max-w-[85%] border px-3 py-2 text-sm leading-relaxed",
        mine ? "ml-auto bg-muted" : "mr-auto bg-background",
        message.isError && "border-destructive text-destructive",
        message.partial && "border-dashed",
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

function ActivityLine({ activity }: { activity: ActivityItem }) {
  return (
    <a
      href="/activity"
      className="block truncate font-mono text-xs text-muted-foreground hover:text-foreground"
      title="Open activity"
    >
      ▸ {activitySummary(activity)}
    </a>
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
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const open = expanded[groupKey] === true;
  const toggle = () =>
    setExpanded((current) => ({ ...current, [groupKey]: current[groupKey] !== true }));

  return (
    <div>
      <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-foreground"
        >
          <span
            aria-hidden="true"
            className={cn("inline-block w-3 shrink-0 transition-transform", open && "rotate-90")}
          >
            ▸
          </span>
          <span className="truncate whitespace-nowrap">{groupSummary(items, live)}</span>
        </button>
        <a
          href="/activity"
          className="shrink-0 whitespace-nowrap text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          open in activity
        </a>
      </div>
      {open && (
        <div className="mt-2 space-y-1 border-l border-border pl-3">
          {items.map((activity) => (
            <ActivityLine key={activity.id} activity={activity} />
          ))}
        </div>
      )}
    </div>
  );
}

function queuePreview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 59)}…` : oneLine;
}

function QueueStack({
  queue,
  running,
  onCancel,
  onSteer,
}: {
  queue: QueuedMessage[];
  running: boolean;
  onCancel: (id: string) => Promise<boolean>;
  onSteer: (id: string) => Promise<boolean>;
}) {
  if (queue.length === 0) return null;
  return (
    <div className="border-b border-border bg-muted/40">
      <div className="mx-auto w-full max-w-[72ch] px-4">
        {queue.map((item, index) => (
          <div
            key={item.id}
            className="flex items-center gap-2 border-b border-border py-1.5 font-mono text-xs text-muted-foreground last:border-b-0"
          >
            <span className="w-4 shrink-0 tabular-nums">{index + 1}.</span>
            <span className="min-w-0 flex-1 truncate" title={item.text}>
              {queuePreview(item.text)}
            </span>
            {running && (
              <button
                type="button"
                className="shrink-0 hover:text-foreground"
                onClick={() => void onSteer(item.id)}
              >
                steer now
              </button>
            )}
            <button
              type="button"
              className="shrink-0 hover:text-destructive"
              onClick={() => void onCancel(item.id)}
            >
              cancel
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_PX = 10;
const STEER_HINT_KEY = "pi-ui:steer-long-press-hint";
const ACTION_BUTTON_CLASS = "h-9 w-full";

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

    const apply = () => {
      frame = null;
      const height = viewport?.height ?? window.innerHeight;
      if (!Number.isFinite(height) || height <= 0) return;
      if (Math.abs(height - lastHeight) < 0.5) return;
      lastHeight = height;
      root.style.setProperty("--app-height", `${height}px`);
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
    };
  }, []);
}

function Composer({
  running,
  send,
  stop,
}: {
  running: boolean;
  send: (text: string, mode?: MessageMode) => Promise<boolean>;
  stop: () => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [holdingSteer, setHoldingSteer] = useState(false);
  const [showSteerHint, setShowSteerHint] = useState(false);
  const steerHintConsumedRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const rowRef = useRef<HTMLDivElement>(null);
  const rowWidthRef = useRef<number | null>(null);
  const holdTimerRef = useRef<number | null>(null);
  const holdStartRef = useRef<{ x: number; y: number } | null>(null);
  const longPressRef = useRef(false);
  const suppressClickRef = useRef(false);
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

  useEffect(() => {
    if (steerHintConsumedRef.current || !running || !canSend) return;
    try {
      if (sessionStorage.getItem(STEER_HINT_KEY) === "1") {
        steerHintConsumedRef.current = true;
        return;
      }
      sessionStorage.setItem(STEER_HINT_KEY, "1");
    } catch {
      // Storage is optional; the in-memory ref still makes the hint one-time.
    }
    steerHintConsumedRef.current = true;
    setShowSteerHint(true);
  }, [canSend, running]);

  useEffect(() => {
    if (!showSteerHint) return;
    if (running && canSend) return;
    setShowSteerHint(false);
  }, [canSend, running, showSteerHint]);

  useEffect(
    () => () => {
      if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current);
    },
    [],
  );

  const clearHoldTimer = () => {
    if (holdTimerRef.current === null) return;
    window.clearTimeout(holdTimerRef.current);
    holdTimerRef.current = null;
  };

  const cancelHold = () => {
    clearHoldTimer();
    holdStartRef.current = null;
    setHoldingSteer(false);
  };

  const submit = async (mode: MessageMode) => {
    if (!canSend) return;
    const element = textareaRef.current;
    const text = value;
    const coarse = usesCoarsePointer();
    const sent = await send(text, mode);
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

  const handleSteerPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!canSend || (event.pointerType === "mouse" && event.button !== 0)) return;
    clearHoldTimer();
    longPressRef.current = false;
    suppressClickRef.current = false;
    holdStartRef.current = { x: event.clientX, y: event.clientY };
    setHoldingSteer(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is best-effort; the window still receives pointerup.
    }
    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null;
      longPressRef.current = true;
      setHoldingSteer(false);
      setShowSteerHint(false);
      void submit("queue");
    }, LONG_PRESS_MS);
  };

  const handleSteerPointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = holdStartRef.current;
    if (start === null) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) <= LONG_PRESS_MOVE_PX) return;
    suppressClickRef.current = true;
    cancelHold();
  };

  const handleSteerPointerUp = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (longPressRef.current) suppressClickRef.current = true;
    clearHoldTimer();
    holdStartRef.current = null;
    setHoldingSteer(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // The pointer may already be released.
    }
  };

  const handleSteerClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    if (!canSend) return;
    void submit("steer");
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit("queue");
      }}
    >
      <div ref={rowRef} className="mx-auto flex w-full max-w-[72ch] items-end gap-2 px-4 py-3">
        <Textarea
          ref={textareaRef}
          aria-label="Message"
          rows={1}
          className="bg-transparent"
          value={value}
          placeholder={running ? "Queue a message · Steer with ⌘/Ctrl+Enter" : "Message pi"}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              const steer = running && (event.metaKey || event.ctrlKey);
              void submit(steer ? "steer" : "queue");
            }
          }}
        />
        <div className="flex h-9 w-24 shrink-0 items-stretch">
          {running && !canSend ? (
            <Button
              key="stop"
              type="button"
              variant="outline"
              className={ACTION_BUTTON_CLASS}
              onClick={() => void stop()}
            >
              Stop
            </Button>
          ) : running ? (
            <Button
              key="steer"
              type="button"
              aria-label={holdingSteer ? "Steer (release to queue)" : "Steer"}
              className={cn(ACTION_BUTTON_CLASS, holdingSteer && "bg-muted text-foreground")}
              onClick={handleSteerClick}
              onPointerDown={handleSteerPointerDown}
              onPointerMove={handleSteerPointerMove}
              onPointerUp={handleSteerPointerUp}
              onPointerCancel={cancelHold}
            >
              {holdingSteer ? "Queue…" : "Steer"}
            </Button>
          ) : (
            <Button key="send" type="submit" className={ACTION_BUTTON_CLASS} disabled={!canSend}>
              Send
            </Button>
          )}
        </div>
      </div>
      <div
        className="mx-auto h-4 w-full max-w-[72ch] px-4 font-mono text-[10px] leading-4 text-muted-foreground"
        aria-live="polite"
      >
        {showSteerHint && running && canSend ? (
          <span>Hold Steer to queue without interrupting the run.</span>
        ) : null}
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
  queue,
  ready,
  send,
  cancelQueued,
  steerQueued,
  stop,
}: ChatViewProps) {
  useViewportHeight();
  const groups = useMemo(() => groupTimeline(timeline), [timeline]);
  const footerRef = useRef<HTMLDivElement | null>(null);
  const [footerHeight, setFooterHeight] = useState(0);

  useLayoutEffect(() => {
    const footer = footerRef.current;
    if (!footer) return;
    const measure = () => {
      const height = footer.getBoundingClientRect().height;
      setFooterHeight((current) => (Math.abs(current - height) < 0.5 ? current : height));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(footer);
    return () => observer.disconnect();
  }, []);

  // Re-run the stick sync when either the timeline or the measured footer height changes:
  // the footer grows with the queue and working indicator, and the transcript's bottom
  // padding follows it, so an attached transcript must chase the new scroll height.
  const stick = useStickToBottom(`${timeline.length}:${footerHeight}`);

  const currentActivity = useMemo(() => {
    if (!running) return undefined;
    const lastUserOrder = lastUserMessageOrder(timeline);
    for (let index = timeline.length - 1; index >= 0; index--) {
      const item = timeline[index];
      if (item.kind === "activity" && item.activity.order > lastUserOrder) {
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      {interrupted && (
        <div
          role="status"
          className="shrink-0 border-b border-border bg-muted/40 py-1.5 text-center font-mono text-[11px] text-muted-foreground"
        >
          ⚠ run interrupted — the last response may be partial
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <main ref={stick.containerRef} className="h-full overflow-y-auto">
          <header className="sticky top-0 z-10 border-b border-border bg-black/85 pt-[env(safe-area-inset-top)] backdrop-blur-md supports-[backdrop-filter]:bg-black/60">
            <div className="mx-auto flex h-10 w-full max-w-[72ch] items-center px-4">
              <a href="/" className="text-sm font-medium text-foreground">
                pi
              </a>
            </div>
          </header>

          <div
            ref={stick.contentRef}
            className="mx-auto flex w-full max-w-[72ch] flex-col gap-3 px-4 pt-4"
            style={{ paddingBottom: footerHeight }}
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
        {!stick.attached && (
          <div
            className="pointer-events-none absolute inset-x-0 z-20 flex justify-center"
            style={{ bottom: footerHeight + 8 }}
          >
            <button
              type="button"
              className="pointer-events-auto border border-border bg-black/85 px-2 py-1 font-mono text-[11px] text-white/90 backdrop-blur-md hover:text-white supports-[backdrop-filter]:bg-black/60"
              onClick={stick.scrollToBottom}
            >
              ↓ latest
            </button>
          </div>
        )}

        <div
          ref={footerRef}
          className="absolute inset-x-0 bottom-0 z-20 border-t border-border bg-black/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-md supports-[backdrop-filter]:bg-black/60"
        >
          <QueueStack
            queue={queue}
            running={running}
            onCancel={cancelQueued}
            onSteer={steerQueued}
          />
          <div className="h-7 shrink-0" aria-live="polite">
            <WorkingIndicator
              running={running}
              startedAt={runStartedAt}
              activity={currentActivity}
            />
          </div>
          <Composer running={running} send={handleSend} stop={stop} />
        </div>
      </div>
    </div>
  );
}
