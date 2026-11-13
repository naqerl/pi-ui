import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_NEW_TASK_TITLE } from "../shared/tasks";
import type { ChatMessage, MessageMode, Task } from "../shared/types";
import { Composer, RunStatusLine, TranscriptRows } from "./ChatView";
import type { TimelineItem } from "./chat-timeline";
import { EmptyCaption } from "./EmptyCaption";
import { cn } from "./lib/utils";
import { RunErrorHeader } from "./RunErrorHeader";
import { TaskQuestionPanel } from "./TaskQuestionPanel";
import { FIXTURE_CHAT, FIXTURE_PLAN_ID } from "./task-detail-fixture";
import { readTaskDetailFixture } from "./task-detail-query";
import { type TaskDockSession, useRegisterTaskDock } from "./task-dock-composer";
import { groupTimeline } from "./timeline-groups";
import { useStickToBottom } from "./use-stick-to-bottom";
import { useTaskChat } from "./use-task-chat";

export function TaskAgentChat({
  task,
  projects,
  variant = "pane",
  composerTarget = "local",
  active = true,
}: {
  task: Task;
  projects: string[];
  /** `pane` is the main-chat look: no card, bubbles, blurred composer. */
  variant?: "pane" | "flush";
  /** `dock` registers send/stop on the persistent main-chat float footer. */
  composerTarget?: "local" | "dock";
  /** False while a mobile tab hides the pane; the shared scroll hook restores on return. */
  active?: boolean;
}) {
  const done = task.status === "done";
  const chat = useTaskChat(task.id, done);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [composerError, setComposerError] = useState<string | null>(null);

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
  const stick = useStickToBottom(timeline.length, { active });

  const pendingQuestions = chat.questions;
  useEffect(() => {
    if (pendingQuestions !== null && active) stick.scrollToBottom();
  }, [active, pendingQuestions, stick.scrollToBottom]);

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

  useEffect(() => {
    setComposerError(chat.error);
  }, [chat.error]);

  const placeholderIdle =
    task.title === DEFAULT_NEW_TASK_TITLE ? "Describe the task to plan…" : "Message the task agent";
  const dock = composerTarget === "dock";

  const sendMessage = useCallback(
    async (text: string, mode: MessageMode = "queue", attachments: string[] = []) => {
      const ok = await chat.send(text, attachments, mode);
      if (!ok && chat.error !== null) setComposerError(chat.error);
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
      error: composerError,
      send: sendDock,
      stop: chat.stop,
      dismissError: () => {
        setComposerError(null);
        chat.dismissError();
      },
    };
  }, [
    dock,
    done,
    task.id,
    placeholderIdle,
    chat.running,
    chat.stop,
    chat.dismissError,
    composerError,
    sendDock,
  ]);

  useRegisterTaskDock(session);

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
      error={composerError}
      onDismissError={() => {
        setComposerError(null);
        chat.dismissError();
      }}
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
          "flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-3",
          "[scrollbar-gutter:stable]",
        )}
      >
        <div ref={stick.contentRef} className="flex min-h-0 flex-col gap-3">
          {groups.length === 0 && chat.questions === null ? (
            <div className="flex min-h-0 flex-1 items-center justify-center">
              <EmptyCaption>
                {done
                  ? "This task is done, so the planning chat is closed."
                  : "Ask the planning agent to help formulate this task."}
              </EmptyCaption>
            </div>
          ) : (
            <TranscriptRows groups={groups} onCancelQueued={chat.cancelQueued} />
          )}
          {chat.questions !== null && (
            <TaskQuestionPanel
              key={chat.questions.id}
              set={chat.questions}
              onAnswer={chat.answerQuestions}
            />
          )}
        </div>
      </main>
      <div className="theme-radius mx-3 mb-1 flex shrink-0 items-center border border-border/70 bg-surface/90 px-2 py-1 backdrop-blur-md">
        <RunStatusLine
          running={chat.running}
          thinking={chat.thinking}
          ready={chat.ready}
          label="Planning"
          testId="task-agent-status"
        />
      </div>
      {chat.runError !== null && (
        <div className="relative h-9 shrink-0">
          <RunErrorHeader error={chat.runError} onDismiss={chat.dismissError} />
        </div>
      )}
      {!dock && composer !== null && (
        <div className="glass-composer theme-radius shrink-0">{composer}</div>
      )}
    </div>
  );
}
