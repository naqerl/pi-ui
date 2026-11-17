import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_NEW_TASK_TITLE } from "../shared/tasks";
import type { ChatMessage, MessageMode, Task } from "../shared/types";
import { ActivityDialog, Composer, TranscriptRows } from "./ChatView";
import type { TimelineItem } from "./chat-timeline";
import { EmptyCaption } from "./EmptyCaption";
import { NoticeIcon } from "./icons";
import { cn } from "./lib/utils";
import { FIXTURE_CHAT, FIXTURE_PLAN_ID } from "./task-detail-fixture";
import { readTaskDetailFixture } from "./task-detail-query";
import {
  type TaskDockSession,
  useRegisterTaskDock,
  useRegisterTaskRunError,
} from "./task-dock-composer";
import { groupTimeline } from "./timeline-groups";
import { useStickToBottom } from "./use-stick-to-bottom";
import { useTaskChat } from "./use-task-chat";

export function TaskAgentChat({
  task,
  projects,
  variant = "pane",
  composerTarget = "local",
  active = true,
  onShowPlan,
}: {
  task: Task;
  projects: string[];
  /** `pane` is the main-chat look: no card, bubbles, blurred composer. */
  variant?: "pane" | "flush";
  /** `dock` registers send/stop on the persistent main-chat float footer. */
  composerTarget?: "local" | "dock";
  /** False while a mobile tab hides the pane; the shared scroll hook restores on return. */
  active?: boolean;
  /** Switch to the Plan tab, where the pending question set lives. */
  onShowPlan?: () => void;
}) {
  const done = task.status === "done";
  const chat = useTaskChat(task.id, done);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [activityRun, setActivityRun] = useState<string | null | undefined>(undefined);
  const activityTriggerRef = useRef<HTMLButtonElement | null>(null);

  const fixtureChat = readTaskDetailFixture() && task.id === FIXTURE_PLAN_ID;
  const timeline = useMemo<TimelineItem[]>(() => {
    if (!fixtureChat) return chat.timeline;
    return FIXTURE_CHAT.map((message, index) => ({
      kind: "message" as const,
      order: message.order ?? index,
      message: message as ChatMessage,
    }));
  }, [chat.timeline, fixtureChat]);
  const groups = useMemo(() => groupTimeline(timeline), [timeline]);
  const stick = useStickToBottom(`${timeline.length}`, { active });
  const waitingQuestions = task.questions?.questions.length ?? 0;

  useEffect(() => {
    const focus = () => {
      const node =
        inputRef.current ??
        document.querySelector<HTMLTextAreaElement>('[data-testid="task-agent-input"]');
      node?.focus({ preventScroll: true });
    };
    window.addEventListener("pi-focus-task-chat", focus);
    return () => window.removeEventListener("pi-focus-task-chat", focus);
  }, []);

  const placeholderIdle =
    task.title === DEFAULT_NEW_TASK_TITLE ? "Describe the task to plan…" : "Message the task agent";
  const dock = composerTarget === "dock";

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

  const sendMessage = useCallback(
    async (text: string, mode: MessageMode = "queue", attachments: string[] = []) => {
      const ok = await chat.send(text, attachments, mode);
      if (ok) requestAnimationFrame(() => stick.scrollToBottom());
      return ok;
    },
    [chat, stick.scrollToBottom],
  );

  const sendDock = useCallback(
    async (text: string, mode?: MessageMode, attachments?: string[]) =>
      sendMessage(text, mode ?? "queue", attachments ?? []),
    [sendMessage],
  );

  const session = useMemo((): TaskDockSession | null => {
    if (!dock || done) return null;
    return {
      taskId: task.id,
      placeholder: placeholderIdle,
      running: chat.running,
      error: chat.error,
      send: sendDock,
      stop: chat.stop,
      dismissError: chat.dismissError,
    };
  }, [
    dock,
    done,
    task.id,
    placeholderIdle,
    chat.running,
    chat.stop,
    chat.dismissError,
    chat.error,
    sendDock,
  ]);

  useRegisterTaskDock(session);

  // The plan pane has no header of its own: the one app-level host owns run errors.
  const runErrorSurface = useMemo(
    () => ({ taskId: task.id, error: chat.runError, dismiss: chat.dismissError }),
    [task.id, chat.runError, chat.dismissError],
  );
  useRegisterTaskRunError(runErrorSurface);

  const composer = done ? null : (
    <Composer
      tasksPage={false}
      projectMentions
      running={chat.running}
      send={async (text, mode, attachments) =>
        sendMessage(text, mode ?? "queue", attachments ?? [])
      }
      stop={chat.stop}
      unsendSteer={chat.unsendSteer}
      addTask={async () => false}
      projects={projects}
      // Send failures are not RunErrors; the global run-error header cannot carry them.
      error={chat.error}
      onDismissError={chat.dismissError}
      textareaRef={inputRef}
      inputTestId="task-agent-input"
      sendTestId="task-agent-send"
      attachTestId="task-agent-attach"
      inputLabel="Task message"
      placeholder={placeholderIdle}
    />
  );

  return (
    <div
      data-testid="task-agent-chat"
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col", variant === "pane" && "h-full")}
    >
      <main
        ref={stick.containerRef}
        data-testid="task-agent-transcript"
        className={cn(
          // The gap above the first row belongs inside the scroller so it scrolls
          // away with the transcript; padding on the pane would leave a fixed band.
          "flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pt-3 pb-3",
          "[scrollbar-gutter:stable]",
        )}
      >
        <div ref={stick.contentRef} className="flex min-h-0 flex-col gap-3">
          {groups.length === 0 ? (
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <EmptyCaption>
                {done
                  ? "This task is done, so the planning chat is closed."
                  : "Ask the planning agent to help formulate this task."}
              </EmptyCaption>
            </div>
          ) : (
            <TranscriptRows
              groups={groups}
              onCancelQueued={chat.cancelQueued}
              onOpen={openActivity}
            />
          )}
        </div>
      </main>
      {task.questions != null && (
        <div className="shrink-0 px-3 pt-2">
          <button
            type="button"
            data-testid="task-questions-waiting"
            disabled={onShowPlan === undefined}
            onClick={onShowPlan}
            className="theme-radius inline-flex min-h-9 w-full items-center justify-center gap-1.5 border border-border/70 bg-surface/90 px-3 py-1 font-mono text-[11px] leading-5 text-muted-foreground shadow-sm backdrop-blur-md hover:text-foreground disabled:cursor-default"
          >
            <NoticeIcon name="questions" size={14} />
            <span>
              {waitingQuestions} question{waitingQuestions === 1 ? "" : "s"} waiting
            </span>
            <span className="opacity-60">·</span>
            <span>Answer in Plan</span>
          </button>
        </div>
      )}
      {!dock && composer !== null && (
        <div className="glass-composer theme-radius shrink-0">{composer}</div>
      )}
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
