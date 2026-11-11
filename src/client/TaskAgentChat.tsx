import { useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_NEW_TASK_TITLE } from "../shared/tasks";
import type { ChatMessage, Task } from "../shared/types";
import { Composer, MessageBubble } from "./ChatView";
import { cn } from "./lib/utils";
import { FIXTURE_CHAT, FIXTURE_PLAN_ID } from "./task-detail-fixture";
import { readTaskDetailFixture } from "./task-detail-query";
import { useTaskChat } from "./use-task-chat";

export function TaskAgentChat({
  task,
  projects,
  variant = "pane",
}: {
  task: Task;
  projects: string[];
  /** `pane` is the main-chat look: no card, bubbles, blurred composer. */
  variant?: "pane" | "flush";
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

  useEffect(() => {
    const node = scrollerRef.current;
    if (node === null) return;
    // Keep the latest turn in view as the transcript grows.
    if (rows.length >= 0) node.scrollTop = node.scrollHeight;
  }, [rows.length]);

  useEffect(() => {
    const focus = () => inputRef.current?.focus({ preventScroll: true });
    window.addEventListener("pi-focus-task-chat", focus);
    return () => window.removeEventListener("pi-focus-task-chat", focus);
  }, []);

  useEffect(() => {
    setComposerError(chat.error);
  }, [chat.error]);

  const placeholderIdle =
    task.title === DEFAULT_NEW_TASK_TITLE ? "Describe the task to plan…" : "Message the task agent";

  return (
    <div
      data-testid="task-agent-chat"
      className={cn("flex min-h-0 min-w-0 flex-1 flex-col", variant === "pane" && "h-full")}
    >
      <div
        ref={scrollerRef}
        data-testid="task-agent-transcript"
        className={cn(
          "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3",
          "[scrollbar-gutter:stable]",
        )}
      >
        {rows.length === 0 ? (
          <p className="px-1 py-6 text-center text-sm text-foreground/75">
            {done
              ? "This task is done, so the planning chat is closed."
              : "Ask the planning agent to help formulate this task."}
          </p>
        ) : (
          rows.map((message) => <MessageBubble key={message.id} message={message} />)
        )}
      </div>
      {!done && (
        <div className="glass-composer theme-radius shrink-0">
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
        </div>
      )}
    </div>
  );
}
