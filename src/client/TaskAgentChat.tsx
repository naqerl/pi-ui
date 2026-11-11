import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { acceptMention, mentionAt, parseProjectToken } from "../shared/project";
import { DEFAULT_NEW_TASK_TITLE } from "../shared/tasks";
import type { ChatMessage, Task } from "../shared/types";
import { MessageBubble } from "./ChatView";
import { Button } from "./components/ui/button";
import { Textarea } from "./components/ui/textarea";
import { haptic } from "./haptics";
import { loadMarkdown } from "./lazy-markdown";
import { cn } from "./lib/utils";
import { ProjectSuggestions, projectSuggestions } from "./ProjectSuggestions";
import { FIXTURE_CHAT, FIXTURE_PLAN_ID } from "./task-detail-fixture";
import { readTaskDetailFixture } from "./task-detail-query";
import { useTaskChat } from "./use-task-chat";

void loadMarkdown();

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
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5" fill="currentColor">
      <rect x="7" y="7" width="10" height="10" rx="1" />
    </svg>
  );
}

export function TaskAgentChat({ task, projects }: { task: Task; projects: string[] }) {
  const done = task.status === "done";
  const chat = useTaskChat(task.id, done);
  const [value, setValue] = useState("");
  const [caret, setCaret] = useState<number | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const mention = caret !== null ? mentionAt(value, caret) : null;
  const suggesting =
    mention !== null && mention.start !== dismissedAt
      ? projectSuggestions(projects, mention.query)
      : [];
  const active = Math.min(activeIndex, Math.max(0, suggesting.length - 1));

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

  const fixtureChat = readTaskDetailFixture() && task.id === FIXTURE_PLAN_ID;
  const rows = useMemo(() => {
    const list = fixtureChat ? [...FIXTURE_CHAT] : [...chat.messages];
    if (draftMessage !== null) list.push(draftMessage);
    return list;
  }, [chat.messages, draftMessage, fixtureChat]);

  useEffect(() => {
    const node = scrollerRef.current;
    if (node === null) return;
    // The snapshot and the live draft both change the scroll height.
    void rows.length;
    void chat.draftText;
    node.scrollTop = node.scrollHeight;
  }, [rows.length, chat.draftText]);

  useEffect(() => {
    const focus = () => {
      const element = inputRef.current;
      if (element === null || element.closest("[inert]") !== null) return;
      element.focus({ preventScroll: true });
    };
    void task.id;
    focus();
    window.addEventListener("pi-focus-task-chat", focus);
    return () => window.removeEventListener("pi-focus-task-chat", focus);
  }, [task.id]);

  const accept = (name: string) => {
    if (mention === null) return;
    const next = acceptMention(value, mention, name);
    setValue(next.text);
    setDismissedAt(null);
    setActiveIndex(0);
    requestAnimationFrame(() => {
      const element = inputRef.current;
      if (element === null) return;
      element.focus();
      element.setSelectionRange(next.caret, next.caret);
    });
  };

  const submit = async () => {
    const text = value.trim();
    if (text.length === 0 || done) return;
    haptic();
    const parsed = parseProjectToken(text, projects);
    if (parsed.title.length === 0 && parsed.project !== null) return;
    const ok = await chat.send(text);
    if (ok) setValue("");
  };

  const placeholder =
    task.title === DEFAULT_NEW_TASK_TITLE
      ? "Describe the task…  use @project to file it"
      : "Message the task agent";

  return (
    <div
      data-testid="task-agent-chat"
      className={cn(
        "flex min-h-[16rem] min-w-0 flex-col overflow-hidden rounded-md border border-border bg-background/60",
        "flex-1",
      )}
    >
      <div
        ref={scrollerRef}
        data-testid="task-agent-transcript"
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-3"
      >
        {rows.length === 0 && (
          <p className="px-1 py-6 text-center text-sm text-foreground/75">
            {done
              ? "This task has no planning chat."
              : "Tell the agent what this task should be. It will write the title and a design in the body, without changing any files."}
          </p>
        )}
        {rows.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
      </div>
      {chat.error !== null && (
        <p
          role="alert"
          data-testid="task-agent-error"
          className="px-3 pb-1 font-mono text-[11px] leading-4 text-destructive"
        >
          {chat.error}
        </p>
      )}
      {!done && (
        <form
          ref={formRef}
          data-testid="task-agent-composer"
          className="border-t border-border"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void submit();
          }}
        >
          {suggesting.length > 0 && (
            <ProjectSuggestions
              anchor={formRef}
              items={suggesting}
              active={active}
              onHover={setActiveIndex}
              onAccept={(item) => accept(item.name)}
            />
          )}
          <div className="flex items-end gap-1 p-1.5">
            <Textarea
              ref={inputRef}
              aria-label="Task message"
              data-testid="task-agent-input"
              rows={1}
              value={value}
              placeholder={placeholder}
              aria-autocomplete="list"
              aria-controls={suggesting.length > 0 ? "project-suggestions" : undefined}
              aria-activedescendant={
                suggesting.length > 0 ? `project-suggestion-${active}` : undefined
              }
              className="bg-transparent"
              onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
              onBlur={() => setCaret(null)}
              onChange={(event) => {
                setValue(event.target.value);
                setCaret(event.target.selectionStart);
                setActiveIndex(0);
                setDismissedAt(null);
                if (chat.error !== null) chat.dismissError();
              }}
              onKeyDown={(event) => {
                if (suggesting.length > 0 && !event.nativeEvent.isComposing) {
                  const count = suggesting.length;
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setActiveIndex((active + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
                    return;
                  }
                  if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
                    event.preventDefault();
                    const item = suggesting[active];
                    if (item !== undefined) accept(item.name);
                    return;
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setDismissedAt(mention?.start ?? null);
                    return;
                  }
                }
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="flex h-11 w-11 shrink-0 items-stretch">
              {chat.run === "running" && value.trim().length === 0 ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Stop"
                  data-testid="task-agent-stop"
                  className="h-11 w-full hover:bg-foreground/10"
                  onClick={() => {
                    haptic([12, 40, 12]);
                    void chat.stop();
                  }}
                >
                  <StopIcon />
                </Button>
              ) : (
                <Button
                  type="submit"
                  variant="ghost"
                  size="icon"
                  aria-label="Send"
                  data-testid="task-agent-send"
                  className="h-11 w-full hover:bg-foreground/10"
                  disabled={value.trim().length === 0}
                >
                  <SendIcon />
                </Button>
              )}
            </div>
          </div>
        </form>
      )}
    </div>
  );
}
