import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MessageMode } from "../shared/types";
import { ActivityDialog, Composer, TranscriptRows } from "./ChatView";
import { EmptyCaption } from "./EmptyCaption";
import { RunErrorHeader } from "./RunErrorHeader";
import { groupTimeline } from "./timeline-groups";
import { useBotChat } from "./use-bot-chat";
import { useStickToBottom } from "./use-stick-to-bottom";
import { WorkingIndicator } from "./WorkingIndicator";
import { workingWord } from "./working-state";

/** The first paint of an empty bot conversation; `ready` separates idle from still loading. */
export function BotChatEmpty({
  name,
  ready,
  hasRows,
}: {
  name: string;
  ready: boolean;
  hasRows: boolean;
}) {
  if (hasRows) return null;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      {ready ? (
        <div data-testid="bot-chat-empty">
          <EmptyCaption>Ask {name} for something.</EmptyCaption>
        </div>
      ) : (
        <div data-testid="bot-chat-loading">
          <EmptyCaption>Opening the conversation…</EmptyCaption>
        </div>
      )}
    </div>
  );
}

/**
 * One bot's chat surface. It is the plan chat's renderer over a bot transport: the same
 * transcript rows, activity chips and composer, with the bot's own durable conversation.
 */
export function BotChat({
  botId,
  name,
  onClose,
}: {
  botId: string;
  name: string;
  onClose: () => void;
}) {
  const chat = useBotChat(botId);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [activityRun, setActivityRun] = useState<string | null | undefined>(undefined);
  const activityTriggerRef = useRef<HTMLButtonElement | null>(null);

  const timeline = chat.timeline;
  const groups = useMemo(() => groupTimeline(timeline), [timeline]);
  const stick = useStickToBottom(`${timeline.length}`, { active: true });

  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // The run-error dialog owns Escape while it is open.
      if (document.querySelector("dialog[open]") !== null) return;
      onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const openActivity = useCallback((run: string, trigger: HTMLButtonElement) => {
    activityTriggerRef.current = trigger;
    setActivityRun(run);
  }, []);

  const closeActivity = useCallback(() => {
    const trigger = activityTriggerRef.current;
    activityTriggerRef.current = null;
    setActivityRun(undefined);
    requestAnimationFrame(() => {
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      else inputRef.current?.focus({ preventScroll: true });
    });
  }, []);

  const send = useCallback(
    async (text: string, mode: MessageMode = "queue", attachments: string[] = []) => {
      const ok = await chat.send(text, attachments, mode);
      if (ok) requestAnimationFrame(() => stick.scrollToBottom());
      return ok;
    },
    [chat, stick.scrollToBottom],
  );

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={name}
      data-testid="bot-chat"
      className="fixed inset-0 z-50 flex flex-col bg-background font-mono text-xs text-foreground"
    >
      <header className="flex shrink-0 items-center justify-between gap-lg border-b border-border/70 bg-surface/95 px-xl py-sm backdrop-blur-md">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Bot</div>
          <h2 className="truncate text-sm text-foreground">{name}</h2>
        </div>
        <div className="flex shrink-0 items-center gap-lg">
          {chat.running ? (
            <WorkingIndicator
              running
              quiet={chat.quiet}
              word={workingWord(chat.thinking)}
              testId="bot-chat-working"
              activityTestId="bot-chat-status"
            />
          ) : (
            <span
              data-testid="bot-chat-status"
              className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground"
            >
              {chat.ready ? "idle" : "connecting"}
            </span>
          )}
          <button
            type="button"
            data-testid="bot-chat-close"
            aria-label={`Close ${name}`}
            onClick={onClose}
            className="theme-radius px-lg py-xs text-base text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          >
            ✕
          </button>
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {chat.runError === null ? null : (
          <RunErrorHeader error={chat.runError} onDismiss={chat.dismissError} />
        )}
        <main
          ref={stick.containerRef}
          data-testid="bot-chat-transcript"
          className="flex min-h-0 flex-1 flex-col overflow-y-auto px-xl pt-xl pb-2xl [scrollbar-gutter:stable]"
        >
          <div ref={stick.contentRef} className="flex shrink-0 flex-col gap-xl">
            <BotChatEmpty name={name} ready={chat.ready} hasRows={groups.length > 0} />
            {groups.length === 0 ? null : (
              <TranscriptRows
                groups={groups}
                timeline={timeline}
                running={chat.running}
                onCancelQueued={chat.cancelQueued}
                onOpen={openActivity}
                surfaceKey={`bot:${botId}`}
              />
            )}
          </div>
        </main>
        <div className="glass-composer theme-radius shrink-0">
          {/* The bot route has no stop or steer endpoint; dead buttons are worse than none. */}
          <Composer
            tasksPage={false}
            runControls={false}
            running={chat.running}
            send={send}
            stop={chat.stop}
            unsendSteer={chat.unsendSteer}
            addTask={async () => false}
            projects={[]}
            error={chat.error}
            onDismissError={chat.dismissError}
            textareaRef={inputRef}
            inputTestId="bot-chat-input"
            sendTestId="bot-chat-send"
            attachTestId="bot-chat-attach"
            inputLabel={`Message ${name}`}
            placeholder={`Message ${name}…`}
            draftKey={`bot:${botId}`}
            replyKey={`bot:${botId}`}
          />
        </div>
      </div>
      {activityRun !== undefined && (
        <Suspense fallback={null}>
          <ActivityDialog
            timeline={timeline}
            ready={chat.ready}
            run={activityRun}
            onClose={closeActivity}
          />
        </Suspense>
      )}
    </div>
  );
}
