import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ActivityItem, ChatMessage } from "../shared/types";
import { activitySummary } from "./activity-format";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { cn } from "./lib/utils";
import type { TimelineItem } from "./use-chat";

interface ChatViewProps {
  timeline: TimelineItem[];
  running: boolean;
  ready: boolean;
  send: (text: string) => Promise<boolean>;
  stop: () => Promise<void>;
}

function MessageBubble({ message }: { message: ChatMessage }) {
  const mine = message.role === "user";
  return (
    <div
      className={cn(
        "max-w-[85%] whitespace-pre-wrap break-words border px-3 py-2 text-sm leading-relaxed",
        mine ? "ml-auto bg-muted" : "mr-auto bg-background",
        message.isError && "border-destructive text-destructive",
      )}
    >
      {message.text}
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

function Composer({
  running,
  send,
  stop,
}: {
  running: boolean;
  send: (text: string) => Promise<boolean>;
  stop: () => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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

  const submit = async () => {
    if (running || value.trim().length === 0) return;
    const sent = await send(value);
    if (sent) {
      setValue("");
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  };

  return (
    <form
      className="border-t border-border bg-background pb-[env(safe-area-inset-bottom)]"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="mx-auto flex w-full max-w-[72ch] items-end gap-2 px-4 py-3">
        <Textarea
          ref={textareaRef}
          aria-label="Message"
          rows={1}
          value={value}
          disabled={running}
          placeholder="Message pi"
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        {running ? (
          <Button type="button" variant="outline" onClick={() => void stop()}>
            Stop
          </Button>
        ) : (
          <Button type="submit" disabled={value.trim().length === 0}>
            Send
          </Button>
        )}
      </div>
    </form>
  );
}

export function ChatView({ timeline, running, ready, send, stop }: ChatViewProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scrolling is keyed to new timeline items
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [timeline.length]);

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

      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[72ch] flex-col gap-3 px-4 py-4">
          {!ready && <p className="font-mono text-xs text-muted-foreground">Loading…</p>}
          {timeline.map((item) =>
            item.kind === "message" ? (
              <MessageBubble key={`message-${item.message.id}`} message={item.message} />
            ) : (
              <ActivityLine key={`activity-${item.activity.id}`} activity={item.activity} />
            ),
          )}
          <div ref={bottomRef} />
        </div>
      </main>

      <Composer running={running} send={send} stop={stop} />
    </div>
  );
}
