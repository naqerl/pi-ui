import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ActivityItem, ChatMessage, MessageMode, QueuedMessage } from "../shared/types";
import { activitySummary, groupSummary } from "./activity-format";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { cn } from "./lib/utils";
import { groupTimeline } from "./timeline-groups";
import type { TimelineItem } from "./use-chat";
import { useStickToBottom } from "./use-stick-to-bottom";
import { WorkingIndicator } from "./WorkingIndicator";

interface ChatViewProps {
  timeline: TimelineItem[];
  running: boolean;
  runStartedAt: string | null;
  queue: QueuedMessage[];
  ready: boolean;
  send: (text: string, mode?: MessageMode) => Promise<boolean>;
  cancelQueued: (id: string) => Promise<boolean>;
  steerQueued: (id: string) => Promise<boolean>;
  stop: () => Promise<void>;
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const mine = message.role === "user";
  return (
    <div
      className={cn(
        "max-w-[85%] border px-3 py-2 text-sm leading-relaxed",
        mine ? "ml-auto bg-muted" : "mr-auto bg-background",
        message.isError && "border-destructive text-destructive",
      )}
    >
      {message.steer && (
        <div className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          steer
        </div>
      )}
      <div className="whitespace-pre-wrap break-words">{message.text}</div>
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const canSend = value.trim().length > 0;

  // biome-ignore lint/correctness/useExhaustiveDependencies: value drives the autosize measurement
  useLayoutEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "0px";
    const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight) || 20;
    const maxHeight = lineHeight * 8 + 16;
    const nextHeight = Math.min(element.scrollHeight, maxHeight);
    element.style.height = `${nextHeight}px`;
    element.style.overflowY = element.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [value]);

  const submit = async (mode: MessageMode) => {
    if (!canSend) return;
    const sent = await send(value, mode);
    if (sent) {
      setValue("");
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  };

  return (
    <form
      className="bg-background pb-[env(safe-area-inset-bottom)]"
      onSubmit={(event) => {
        event.preventDefault();
        void submit("queue");
      }}
    >
      <div className="mx-auto flex w-full max-w-[72ch] items-end gap-2 px-4 py-3">
        <Textarea
          ref={textareaRef}
          aria-label="Message"
          rows={1}
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
        {running ? (
          <>
            <Button type="button" size="sm" variant="outline" onClick={() => void stop()}>
              Stop
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canSend}
              onClick={() => void submit("steer")}
            >
              Steer
            </Button>
            <Button type="submit" size="sm" disabled={!canSend}>
              Queue
            </Button>
          </>
        ) : (
          <Button type="submit" disabled={!canSend}>
            Send
          </Button>
        )}
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
  runStartedAt,
  queue,
  ready,
  send,
  cancelQueued,
  steerQueued,
  stop,
}: ChatViewProps) {
  const stick = useStickToBottom(timeline.length);
  const groups = useMemo(() => groupTimeline(timeline), [timeline]);

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
      <header className="border-b border-border pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-10 w-full max-w-[72ch] items-center justify-between px-4">
          <a href="/" className="text-sm font-medium text-foreground">
            pi
          </a>
          <a
            href="/activity"
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Activity
          </a>
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <main ref={stick.containerRef} className="h-full overflow-y-auto">
          <div
            ref={stick.contentRef}
            className="mx-auto flex w-full max-w-[72ch] flex-col gap-3 px-4 py-4"
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
          <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
            <button
              type="button"
              className="pointer-events-auto border border-border bg-background px-2 py-1 font-mono text-[11px] text-muted-foreground hover:text-foreground"
              onClick={stick.scrollToBottom}
            >
              ↓ latest
            </button>
          </div>
        )}
      </div>

      <div className="shrink-0 border-t border-border bg-background">
        <QueueStack queue={queue} running={running} onCancel={cancelQueued} onSteer={steerQueued} />
        <div className="h-7 shrink-0" aria-live="polite">
          <WorkingIndicator running={running} startedAt={runStartedAt} activity={currentActivity} />
        </div>
        <Composer running={running} send={handleSend} stop={stop} />
      </div>
    </div>
  );
}
