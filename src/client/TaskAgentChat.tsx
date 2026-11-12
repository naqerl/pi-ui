import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_NEW_TASK_TITLE } from "../shared/tasks";
import type { ChatMessage, MessageMode, Task } from "../shared/types";
import { Composer, MessageBubble } from "./ChatView";
import { EmptyCaption } from "./EmptyCaption";
import { cn } from "./lib/utils";
import { TaskQuestionPanel } from "./TaskQuestionPanel";
import { FIXTURE_CHAT, FIXTURE_PLAN_ID } from "./task-detail-fixture";
import { readTaskDetailFixture } from "./task-detail-query";
import { type TaskDockSession, useRegisterTaskDock } from "./task-dock-composer";
import { useTaskChat } from "./use-task-chat";

export function TaskAgentChat({
  task,
  projects,
  variant = "pane",
  composerTarget = "local",
}: {
  task: Task;
  projects: string[];
  /** `pane` is the main-chat look: no card, bubbles, blurred composer. */
  variant?: "pane" | "flush";
  /** `dock` registers send/stop on the persistent main-chat float footer. */
  composerTarget?: "local" | "dock";
}) {
  const done = task.status === "done";
  const chat = useTaskChat(task.id, done);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [composerError, setComposerError] = useState<string | null>(null);

  const fixtureChat = readTaskDetailFixture() && task.id === FIXTURE_PLAN_ID;
  const draftMessage: ChatMessage | null =
    chat.draftText.trim().length === 0
      ? null
      : {
          id: "task-agent-draft",
          role: "assistant",
          text: chat.draftText,
          timestamp: new Date().toISOString(),
          order: Number.MAX_SAFE_INTEGER,
          partial: true,
        };

  const rows = useMemo(() => {
    const list = fixtureChat ? [...FIXTURE_CHAT] : [...chat.messages];
    if (draftMessage !== null) list.push(draftMessage);
    return list;
  }, [chat.messages, draftMessage, fixtureChat]);

  const pendingQuestions = chat.questions;
  const pendingKey =
    pendingQuestions === null ? "" : `${pendingQuestions.id}:${pendingQuestions.questions.length}`;
  useEffect(() => {
    const node = scrollerRef.current;
    if (node === null) return;
    // Keep the latest turn and any pending questions in view as they arrive.
    if (pendingKey.length > 0 || rows.length >= 0) node.scrollTop = node.scrollHeight;
  }, [rows.length, pendingKey]);

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

  const sendDock = useCallback(
    async (text: string, _mode?: MessageMode, attachments?: string[]) => {
      const ok = await chat.send(text, attachments ?? []);
      if (!ok && chat.error !== null) setComposerError(chat.error);
      return ok;
    },
    [chat],
  );

  const session = useMemo((): TaskDockSession | null => {
    if (!dock || done) return null;
    return {
      taskId: task.id,
      placeholder: placeholderIdle,
      running: chat.run === "running",
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
    chat.run,
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
      running={chat.run === "running"}
      send={async (text, _mode, attachments) => {
        const ok = await chat.send(text, attachments ?? []);
        if (!ok && chat.error !== null) setComposerError(chat.error);
        return ok;
      }}
      stop={chat.stop}
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
      <div
        ref={scrollerRef}
        data-testid="task-agent-transcript"
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-3",
          "[scrollbar-gutter:stable]",
        )}
      >
        {rows.length === 0 && chat.questions === null ? (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <EmptyCaption>
              {done
                ? "This task is done, so the planning chat is closed."
                : "Ask the planning agent to help formulate this task."}
            </EmptyCaption>
          </div>
        ) : (
          rows.map((message) => <MessageBubble key={message.id} message={message} />)
        )}
        {chat.questions !== null && (
          <TaskQuestionPanel
            key={chat.questions.id}
            set={chat.questions}
            onAnswer={chat.answerQuestions}
          />
        )}
      </div>
      {!dock && composer !== null && (
        <div className="glass-composer theme-radius shrink-0">{composer}</div>
      )}
    </div>
  );
}
