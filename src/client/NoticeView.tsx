import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { ChatNotice, JobNoticeDetails, McpNoticeDetails } from "../shared/notices";
import { formatDateTime, formatTime } from "../shared/time";
import type { ChatMessage } from "../shared/types";
import { cn } from "./lib/utils";

/** The instant a notice is about: the newest MCP event, or when the notice was recorded. */
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
  return formatTime(noticeTimestamp(message, notice), { seconds: notice.kind === "mcp" });
}

function failed(notice: ChatNotice): boolean {
  return notice.kind === "job" && (notice.status === "failed" || notice.status === "lost");
}

/** A background job result or MCP event, shown as one centred line. Tapping it opens the details. */
export function NoticeLine({ message, notice }: { message: ChatMessage; notice: ChatNotice }) {
  const [open, setOpen] = useState(false);
  const timestamp = noticeTimestamp(message, notice);
  const time = noticeClock(message, notice);
  return (
    <div
      data-message-id={message.id}
      data-role={message.role}
      className="flex justify-center px-2 py-0.5"
    >
      <button
        type="button"
        data-testid="chat-notice"
        data-notice-kind={notice.kind}
        aria-haspopup="dialog"
        title={notice.summary}
        onClick={() => setOpen(true)}
        className={cn(
          "flex min-w-0 max-w-[92%] items-center gap-1.5 rounded-full border border-foreground/10 bg-surface/90 px-2.5 py-0.5 font-mono text-[11px] leading-5 text-muted-foreground shadow-sm backdrop-blur-md transition-colors hover:border-foreground/25 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground/40",
          failed(notice) && "border-destructive/40 text-destructive hover:text-destructive",
        )}
      >
        <span aria-hidden="true" className="shrink-0">
          {notice.kind === "job" ? "⚙" : "↯"}
        </span>
        <span className="min-w-0 truncate" data-testid="chat-notice-summary">
          {notice.summary}
        </span>
        {time !== "" && (
          <time dateTime={timestamp} className="shrink-0 tabular-nums opacity-60">
            {time}
          </time>
        )}
      </button>
      {open && <NoticeDialog message={message} notice={notice} onClose={() => setOpen(false)} />}
    </div>
  );
}

function NoticeDialog({
  message,
  notice,
  onClose,
}: {
  message: ChatMessage;
  notice: ChatNotice;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const timestamp = noticeTimestamp(message, notice);
  const dateTime = formatDateTime(timestamp);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog !== null && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc is handled by the dialog's cancel event.
    <dialog
      ref={ref}
      data-testid="notice-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // Clicks on the backdrop land on the dialog itself; the panel fills the rest.
        if (event.target === event.currentTarget) onClose();
      }}
      className="m-0 mt-auto w-full max-w-full overflow-hidden rounded-t-xl border border-foreground/15 bg-surface p-0 text-foreground shadow-xl backdrop:bg-black/50 sm:m-auto sm:w-[min(40rem,calc(100vw-2rem))] sm:rounded-xl"
    >
      <div className="flex max-h-[85dvh] flex-col pb-[env(safe-area-inset-bottom)]">
        <header className="flex items-start gap-3 border-b border-foreground/10 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              {notice.kind === "job" ? "Background job" : "MCP event"}
              {dateTime !== "" && ` · ${dateTime}`}
            </div>
            <h2 id={titleId} className="mt-0.5 font-mono text-sm [overflow-wrap:anywhere]">
              {notice.summary}
            </h2>
          </div>
          <button
            type="button"
            data-testid="notice-dialog-close"
            aria-label="Close"
            onClick={onClose}
            className="-mr-1 shrink-0 rounded-md px-2 py-1 font-mono text-sm text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          >
            ✕
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm">
          {notice.kind === "job" ? <JobDetails notice={notice} /> : <McpDetails notice={notice} />}
        </div>
      </div>
    </dialog>
  );
}

function Fields({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
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
    <section className="mt-3">
      <h3 className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </h3>
      <pre className="max-h-[40dvh] overflow-auto rounded-md border border-foreground/10 bg-background/60 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">
        {children}
      </pre>
    </section>
  );
}

const JOB_STATUS: Record<JobNoticeDetails["status"], string> = {
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
          // biome-ignore lint/suspicious/noArrayIndexKey: a notice never changes once recorded.
          key={`${event.id ?? "event"}-${index}`}
          className="mt-4 border-t border-foreground/10 pt-3"
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
          // biome-ignore lint/suspicious/noArrayIndexKey: a notice never changes once recorded.
          key={`${status.server}-${status.name}-${index}`}
          className="mt-4 border-t border-foreground/10 pt-3"
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
