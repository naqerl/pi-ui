import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import {
  type ChatNotice,
  type DelegateNoticeDetails,
  type IdleNoticeDetails,
  type InterruptedNoticeDetails,
  type JobNoticeDetails,
  type McpNoticeDetails,
  type MemoryDeltaDetails,
  type MemoryNoticeDetails,
  memoryUndoPrompt,
  type OperatorNoticeDetails,
  type QuestionNoticeDetails,
  type TaskDecisionNoticeDetails,
} from "../shared/notices";
import { noticeIconName } from "../shared/queue";
import { formatDateTime, formatTime } from "../shared/time";
import type { ChatMessage } from "../shared/types";
import { CloseIcon, NoticeIcon } from "./icons";
import { cn } from "./lib/utils";
import { useTaskLink } from "./task-link";

function noticeTimestamp(message: ChatMessage, notice: ChatNotice): string {
  if (notice.kind === "mcp") {
    for (let index = notice.events.length - 1; index >= 0; index--) {
      const timestamp = notice.events[index]?.timestamp;
      if (timestamp !== null && timestamp !== undefined) return timestamp;
    }
  }
  return message.timestamp;
}

function noticeClock(message: ChatMessage, notice: ChatNotice): string {
  return formatTime(noticeTimestamp(message, notice));
}

function failed(notice: ChatNotice): boolean {
  return (
    (notice.kind === "job" && (notice.status === "failed" || notice.status === "lost")) ||
    (notice.kind === "delegate" && notice.status === "failed")
  );
}

function noticeLabel(notice: ChatNotice): string {
  return notice.kind === "interrupted" ? notice.note : notice.summary;
}

function noticeIcon(notice: ChatNotice) {
  return notice.kind === "decision"
    ? noticeIconName(notice.kind, notice.decision)
    : noticeIconName(notice.kind);
}

export function ChipButton({
  testId,
  kind,
  title,
  onClick,
  dialog = false,
  interactive = true,
  expanded,
  controls,
  tone = "default",
  children,
}: {
  testId: string;
  kind: string;
  title: string;
  onClick?: () => void;
  dialog?: boolean;
  interactive?: boolean;
  expanded?: boolean;
  controls?: string;
  tone?: "default" | "warning" | "destructive";
  children: ReactNode;
}) {
  const className = cn(
    "inline-flex min-w-0 max-w-[92%] items-center gap-md rounded-full border px-xl py-xs font-mono text-[11px] leading-5 shadow-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground/40",
    tone === "warning"
      ? "border-status-warn/40 bg-status-warn/10 text-status-warn"
      : tone === "destructive"
        ? "border-destructive/40 bg-surface/90 text-destructive"
        : "border-foreground/10 bg-surface/90 text-muted-foreground",
    interactive &&
      (tone === "warning"
        ? "hover:border-status-warn/60 hover:text-status-warn"
        : tone === "destructive"
          ? "hover:border-foreground/25 hover:text-destructive"
          : "hover:border-foreground/25 hover:text-foreground"),
  );
  if (!interactive) {
    return (
      <span data-testid={testId} data-notice-kind={kind} className={className}>
        {children}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid={testId}
      data-notice-kind={kind}
      aria-haspopup={dialog ? "dialog" : undefined}
      aria-expanded={expanded}
      aria-controls={controls}
      title={title}
      onClick={onClick}
      className={className}
    >
      {children}
    </button>
  );
}

export function NoticeLine({
  message,
  notice,
  onSteer,
}: {
  message: ChatMessage;
  notice: ChatNotice;
  onSteer?: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const link = useTaskLink();
  const taskId =
    notice.kind === "decision" && notice.decision === "approved" ? notice.taskId : undefined;
  const timestamp = noticeTimestamp(message, notice);
  const time = noticeClock(message, notice);
  const label = noticeLabel(notice);
  const interactive = notice.kind !== "interrupted" || notice.stopped;
  return (
    <div
      data-message-id={message.id}
      data-role={message.role}
      className="flex justify-center px-lg py-xs"
    >
      <ChipButton
        testId="chat-notice"
        kind={notice.kind}
        title={label}
        dialog={interactive}
        interactive={interactive}
        onClick={() => {
          if (!interactive) return;
          if (taskId !== undefined) link?.openTask(taskId);
          setOpen(true);
        }}
        tone={
          notice.kind === "interrupted" ? "warning" : failed(notice) ? "destructive" : "default"
        }
      >
        <NoticeIcon name={noticeIcon(notice)} size={14} />
        <span className="min-w-0 truncate" data-testid="chat-notice-summary">
          {label}
        </span>
        {time !== "" && (
          <time dateTime={timestamp} className="shrink-0 tabular-nums opacity-60">
            {time}
          </time>
        )}
      </ChipButton>
      {interactive && open && (
        <NoticeDialog
          message={message}
          notice={notice}
          onClose={() => setOpen(false)}
          {...(onSteer === undefined ? {} : { onSteer })}
        />
      )}
    </div>
  );
}

function NoticeDialog({
  message,
  notice,
  onClose,
  onSteer,
}: {
  message: ChatMessage;
  notice: ChatNotice;
  onClose: () => void;
  onSteer?: (text: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const timestamp = noticeTimestamp(message, notice);
  const dateTime = formatDateTime(timestamp);
  const label = noticeLabel(notice);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      data-testid="notice-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="m-0 mt-auto w-full max-w-full overflow-hidden rounded-t-xl border border-foreground/15 bg-surface p-0 text-foreground shadow-xl backdrop:bg-black/50 sm:m-auto sm:w-[min(40rem,calc(100vw-2rem))] sm:rounded-xl"
    >
      <div className="flex max-h-[85dvh] flex-col safe-bottom">
        <header className="flex items-start gap-xl border-b border-foreground/10 px-2xl py-xl">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              {notice.kind === "job"
                ? "Background job"
                : notice.kind === "delegate"
                  ? "Delegate run"
                  : notice.kind === "mcp"
                    ? notice.statuses.length > 0
                      ? "MCP status"
                      : notice.raw !== undefined
                        ? "MCP notice"
                        : "MCP event"
                    : notice.kind === "memory"
                      ? "Memory write"
                      : notice.kind === "memory-delta"
                        ? "Memory updated"
                        : notice.kind === "idle"
                          ? notice.stale === true
                            ? "Status check"
                            : "Idle nudge"
                          : notice.kind === "decision"
                            ? "Proposal decision"
                            : notice.kind === "questions"
                              ? "Question answers"
                              : notice.kind === "operator"
                                ? "Operator request"
                                : notice.stopped
                                  ? "Run stopped"
                                  : "Run interrupted"}
              {dateTime !== "" && ` · ${dateTime}`}
            </div>
            <h2 id={titleId} className="mt-xs font-mono text-sm [overflow-wrap:anywhere]">
              {label}
            </h2>
          </div>
          <button
            type="button"
            data-testid="notice-dialog-close"
            aria-label="Close"
            onClick={onClose}
            className="-mr-sm shrink-0 rounded-md px-lg py-sm font-mono text-sm text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          >
            <CloseIcon size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-2xl py-xl text-sm">
          {notice.kind === "job" ? (
            <JobDetails notice={notice} />
          ) : notice.kind === "delegate" ? (
            <DelegateDetails notice={notice} />
          ) : notice.kind === "mcp" ? (
            <McpDetails notice={notice} />
          ) : notice.kind === "memory" ? (
            <MemoryDetails notice={notice} onSteer={onSteer} />
          ) : notice.kind === "memory-delta" ? (
            <MemoryDeltaDetailsView notice={notice} />
          ) : notice.kind === "idle" ? (
            <IdleDetails notice={notice} />
          ) : notice.kind === "decision" ? (
            <TaskDecisionDetails notice={notice} />
          ) : notice.kind === "questions" ? (
            <QuestionDetails notice={notice} />
          ) : notice.kind === "operator" ? (
            <OperatorDetails notice={notice} />
          ) : (
            <InterruptedDetails notice={notice} />
          )}
        </div>
      </div>
    </dialog>
  );
}

function DelegateDetails({ notice }: { notice: DelegateNoticeDetails }) {
  return (
    <div className="space-y-xl text-sm">
      <p className="[overflow-wrap:anywhere]">
        {notice.status}
        {notice.duration === null ? "" : ` · ${notice.duration}`}
      </p>
      {notice.task.length > 0 && <p className="[overflow-wrap:anywhere]">{notice.task}</p>}
      {notice.excerpt !== null && notice.excerpt.length > 0 && (
        <p className="[overflow-wrap:anywhere] whitespace-pre-wrap">{notice.excerpt}</p>
      )}
      {notice.tokens !== null && (
        <p className="font-mono text-xs text-muted-foreground">
          {notice.tokens.input.toLocaleString()} in / {notice.tokens.output.toLocaleString()} out
        </p>
      )}
      {notice.error !== null && <p className="text-destructive">{notice.error}</p>}
      <div className="flex flex-wrap gap-xl font-mono text-xs">
        <a
          className="underline underline-offset-2"
          href={`/api/delegates/${encodeURIComponent(notice.runId)}/result`}
        >
          Open result
        </a>
        <a
          className="underline underline-offset-2"
          href={`/api/delegates/${encodeURIComponent(notice.runId)}/activity`}
        >
          Open activity
        </a>
      </div>
    </div>
  );
}

function InterruptedDetails({ notice }: { notice: InterruptedNoticeDetails }) {
  return <p className="[overflow-wrap:anywhere]">{notice.note}</p>;
}

function IdleDetails({ notice }: { notice: IdleNoticeDetails }) {
  return (
    <>
      <p className="[overflow-wrap:anywhere]">{notice.text}</p>
      <Fields
        rows={[
          [
            notice.stale === true
              ? "Tracked tasks"
              : notice.closed === true
                ? "Closed tasks"
                : "Open tasks",
            notice.taskIds.join(", "),
          ],
        ]}
      />
    </>
  );
}

function OperatorDetails({ notice }: { notice: OperatorNoticeDetails }) {
  return (
    <>
      <p className="[overflow-wrap:anywhere]">{notice.body}</p>
      <div className="mt-xl">
        <Fields rows={[["Reason", notice.reason]]} />
      </div>
    </>
  );
}

function TaskDecisionDetails({ notice }: { notice: TaskDecisionNoticeDetails }) {
  return (
    <>
      <Fields
        rows={[
          ["Decision", notice.decision],
          ["Proposal", notice.proposalId],
          ["Task", notice.taskId],
          ["Title", notice.taskTitle],
        ]}
      />
      <Block label="Prompt sent to the agent">{notice.text}</Block>
    </>
  );
}

function QuestionDetails({ notice }: { notice: QuestionNoticeDetails }) {
  return (
    <>
      <Fields
        rows={[
          ["Answers", String(notice.count)],
          ["Set", notice.setId],
        ]}
      />
      {notice.answers.length === 0 ? (
        <p className="mt-md text-muted-foreground">
          {notice.dismissed === true
            ? "The questions were dismissed, so the agent will decide itself."
            : "The answers were sent to the agent."}
        </p>
      ) : (
        <ul className="mt-md flex flex-col gap-md">
          {notice.answers.map((answer) => (
            <li key={answer.id} data-question-id={answer.id} className="min-w-0">
              <p className="min-w-0 [overflow-wrap:anywhere]">{answer.prompt}</p>
              {answer.labels.length > 0 && (
                <div className="mt-xs flex flex-wrap gap-xs">
                  {answer.labels.map((label) => (
                    <span
                      key={label}
                      className="theme-radius border border-border/70 bg-background px-sm py-xs font-mono text-[11px] leading-5 text-foreground"
                    >
                      {label}
                    </span>
                  ))}
                </div>
              )}
              {answer.text.length > 0 && (
                <p className="mt-xs whitespace-pre-wrap border-l-2 border-border/70 pl-sm text-muted-foreground [overflow-wrap:anywhere]">
                  {answer.text}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <Block label="Prompt sent to the agent">{notice.text}</Block>
    </>
  );
}

function MemoryDetails({
  notice,
  onSteer,
}: {
  notice: MemoryNoticeDetails;
  onSteer?: (text: string) => void;
}) {
  return (
    <>
      <Fields rows={[["Path", notice.path]]} />
      <Block label="Written">
        {notice.truncated ? `${notice.text}\n\n… truncated` : notice.text}
      </Block>
      <button
        type="button"
        data-testid="memory-undo"
        disabled={onSteer === undefined}
        onClick={() => onSteer?.(memoryUndoPrompt(notice.path))}
        className="mt-2xl theme-radius border border-foreground/20 bg-surface px-xl py-md font-mono text-[11px] text-foreground disabled:opacity-40"
      >
        Undo
      </button>
    </>
  );
}

function MemoryDeltaDetailsView({ notice }: { notice: MemoryDeltaDetails }) {
  return (
    <>
      {notice.topics.map((topic) => (
        <section key={topic.path} className="mb-xl last:mb-0">
          <Fields
            rows={[
              ["Path", topic.path],
              ["Title", topic.title],
              ["Chars", String(topic.chars)],
              ["Updated", topic.updated],
            ]}
          />
        </section>
      ))}
      <p className="mt-xl text-muted-foreground">
        Read a topic with <code>memory_read</code> before relying on it.
      </p>
    </>
  );
}

function Fields({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-xl gap-y-sm font-mono text-xs">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="min-w-0 [overflow-wrap:anywhere]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Block({ label, children }: { label: string; children: string }) {
  return (
    <section className="mt-xl">
      <h3 className="mb-sm font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </h3>
      <pre className="max-h-[40dvh] overflow-auto rounded-md border border-foreground/10 bg-background/60 p-lg font-mono text-[11px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
        {children}
      </pre>
    </section>
  );
}

const JOB_STATUS: Record<JobNoticeDetails["status"], string> = {
  running: "running",
  exited: "finished",
  failed: "failed",
  cancelled: "cancelled",
  lost: "lost (server restarted)",
};

function JobDetails({ notice }: { notice: JobNoticeDetails }) {
  const rows: [string, ReactNode][] = [
    ["Job", notice.id],
    ["Name", notice.name],
    ["Command", notice.command],
    ["Status", JOB_STATUS[notice.status]],
  ];
  if (notice.exitCode !== null) rows.push(["Exit code", String(notice.exitCode)]);
  if (notice.signal !== null) rows.push(["Signal", notice.signal]);
  if (notice.duration !== null) rows.push(["Duration", notice.duration]);
  return (
    <>
      <Fields rows={rows} />
      <Block label="Last output">{notice.output === "" ? "(no output)" : notice.output}</Block>
    </>
  );
}

function payload(data: unknown): string {
  if (data === undefined) return "(no payload)";
  if (typeof data === "string") return data;
  return JSON.stringify(data, null, 2);
}

function McpDetails({ notice }: { notice: McpNoticeDetails }) {
  if (notice.raw !== undefined) {
    return <Block label="Raw notice">{notice.raw}</Block>;
  }
  return (
    <>
      <Fields
        rows={[
          [notice.servers.length === 1 ? "Server" : "Servers", notice.servers.join(", ")],
          ...(notice.events.length > 0
            ? [["Events", String(notice.events.length)] as [string, ReactNode]]
            : []),
          ...(notice.dropped > 0
            ? [["Dropped", String(notice.dropped)] as [string, ReactNode]]
            : []),
        ]}
      />
      {notice.events.map((event, index) => (
        <section
          key={`${event.id ?? "event"}-${index}`}
          className="mt-2xl border-t border-foreground/10 pt-xl"
        >
          <Fields
            rows={[
              ["Event", event.name],
              ...(notice.servers.length > 1
                ? [["Server", event.server] as [string, ReactNode]]
                : []),
              ...(event.timestamp !== null
                ? [["Time", formatDateTime(event.timestamp)] as [string, ReactNode]]
                : []),
              ...(event.id !== null ? [["Id", event.id] as [string, ReactNode]] : []),
            ]}
          />
          <Block label="Payload">{payload(event.data)}</Block>
        </section>
      ))}
      {notice.statuses.map((status, index) => (
        <section
          key={`${status.server}-${status.name}-${index}`}
          className="mt-2xl border-t border-foreground/10 pt-xl"
        >
          <Fields
            rows={[
              ["Subscription", status.name],
              ["Server", status.server],
              ["Status", status.status],
              ...(status.error !== null ? [["Error", status.error] as [string, ReactNode]] : []),
            ]}
          />
        </section>
      ))}
    </>
  );
}
