import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { TASK_BODY_MAX_LENGTH } from "../shared/tasks";
import { formatCompactDateTime } from "../shared/time";
import type { Task, TaskLedger, TaskState, TaskTrace } from "../shared/types";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { CloseIcon, MoreVerticalIcon, RefreshIcon } from "./icons";
import { cn } from "./lib/utils";
import { InlineMarkdown, Markdown } from "./markdown";
import { mediaUrl } from "./media-client";
import type { ProjectSuggestion } from "./ProjectSuggestions";
import { TaskAgentChat } from "./TaskAgentChat";

function shortId(id: string): string {
  return id.slice(0, 4);
}

const SCROLLBAR_GUTTER = "[scrollbar-gutter:stable]";
const QUIET = "text-foreground/75";
const DETAIL_CARD = "bg-surface theme-radius p-3";

export interface TaskDetailModel {
  task: Task;
  tasks: Task[];
  state: TaskState;
  trace: TaskTrace | undefined;
  wide: boolean;
  statusPending: boolean;
  notice: string | null;
  editingTitle: boolean;
  titleDraft: string;
  titleError: string | null;
  titleRef: RefObject<HTMLTextAreaElement | null>;
  setTitleDraft: (value: string) => void;
  setTitleError: (value: string | null) => void;
  setEditingTitle: (value: boolean) => void;
  saveTitle: (value: string) => void | Promise<void>;
  editingBody: boolean;
  bodyDraft: string;
  bodyError: string | null;
  bodyRef: RefObject<HTMLTextAreaElement | null>;
  bodyEditorRef: RefObject<HTMLDivElement | null>;
  bodyIgnoreBlur: RefObject<boolean>;
  setBodyDraft: (value: string) => void;
  setBodyError: (value: string | null) => void;
  setEditingBody: (value: boolean) => void;
  beginBodyEdit: () => void;
  saveBody: (value?: string) => void | Promise<void>;
  projectDraft: string;
  projectError: string | null;
  projectOpen: boolean;
  projectMatches: ProjectSuggestion[];
  activeProject: number;
  projectAnchor: RefObject<HTMLDivElement | null>;
  setProjectDraft: (value: string) => void;
  setProjectError: (value: string | null) => void;
  setProjectOpen: (value: boolean) => void;
  setProjectActive: (value: number | ((current: number) => number)) => void;
  saveProject: (value?: string) => void | Promise<void>;
  acceptProject: (name: string) => void;
  done: boolean;
  proposed: boolean;
  parked: boolean;
  backlogLabel: string;
  openChildren: boolean;
  parent: Task | undefined;
  children: Task[];
  blockers: Array<{ id: string; title: string; done: boolean }>;
  reason: string | null;
  badge: string;
  title: string;
  projects: string[];
  onClose: () => void;
  onOpen: (id: string) => void;
  onStatus: (task: Task, status: Task["status"]) => void;
  onApprove: () => void;
  onDismiss: () => void;
  onRemove: () => void;
  onLedger?: (ledger: TaskLedger) => void;
}

function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <p role="alert" data-testid="task-error" className="px-1 text-xs leading-4 text-destructive">
      {children}
    </p>
  );
}

function SectionLabel({ children }: { children: ReactNode }) {
  return <h3 className="text-sm font-medium leading-5 text-foreground">{children}</h3>;
}

function TitleField({ model, className }: { model: TaskDetailModel; className?: string }) {
  const {
    task,
    editingTitle,
    titleDraft,
    titleError,
    titleRef,
    setTitleDraft,
    setTitleError,
    setEditingTitle,
    saveTitle,
  } = model;
  if (editingTitle) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <textarea
          ref={titleRef}
          aria-label="Task title"
          aria-invalid={titleError !== null ? true : undefined}
          data-testid="task-title-input"
          rows={Math.max(1, titleDraft.split("\n").length)}
          value={titleDraft}
          onChange={(event) => {
            setTitleDraft(event.target.value);
            setTitleError(null);
          }}
          onBlur={(event) => void saveTitle(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setTitleDraft(task.title);
              setTitleError(null);
              setEditingTitle(false);
            }
          }}
          className={cn(
            "block w-full min-w-0 resize-none overflow-hidden border-0 bg-transparent p-0 text-base font-semibold leading-5 text-foreground outline-none [overflow-wrap:anywhere] focus-visible:ring-1 focus-visible:ring-foreground",
            className,
          )}
        />
        {titleError !== null && <ErrorLine>{titleError}</ErrorLine>}
      </div>
    );
  }
  return (
    <div className="flex w-full min-w-0 flex-col gap-1">
      {/* biome-ignore lint/a11y/useSemanticElements: the read-only markdown is replaced by a textarea when focused. */}
      <div
        role="textbox"
        aria-readonly="true"
        aria-label="Task title"
        tabIndex={0}
        data-testid="task-title"
        className={cn(
          "min-w-0 cursor-text outline-none focus-visible:ring-1 focus-visible:ring-foreground",
          className,
        )}
        onFocus={() => {
          setTitleDraft(task.title);
          setTitleError(null);
          setEditingTitle(true);
        }}
      >
        <h2
          className={cn(
            "min-w-0 text-base font-semibold leading-5 [overflow-wrap:anywhere]",
            className,
          )}
        >
          <InlineMarkdown text={task.title} />
        </h2>
      </div>
      {titleError !== null && <ErrorLine>{titleError}</ErrorLine>}
    </div>
  );
}

function ProjectPicker({ model }: { model: TaskDetailModel }) {
  const {
    task,
    projectDraft,
    projectError,
    projects,
    setProjectDraft,
    setProjectError,
    setProjectActive,
    setProjectOpen,
    acceptProject,
  } = model;
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const current = (task.project ?? "").trim();
  const query = projectDraft.trim().replace(/^@/, "");
  const lowered = query.toLowerCase();
  const matches =
    lowered.length === 0
      ? projects
      : projects.filter((name) => name.toLowerCase().includes(lowered));
  const exact = projects.some((name) => name.toLowerCase() === lowered);
  const canCreate = query.length > 0 && !exact;
  const label = current.length > 0 ? `@${current}` : "No project";

  const openMenu = (next: boolean) => {
    setOpen(next);
    setProjectOpen(next);
    if (next) {
      setProjectDraft(current);
      setProjectError(null);
      setProjectActive(0);
    }
  };

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
  }, [open]);

  return (
    <div className="min-w-0" data-testid="task-project-line">
      <DropdownMenu open={open} onOpenChange={openMenu}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-testid="task-header-project"
            aria-label="Task project"
            className="max-w-[40vw] truncate rounded-md px-1 text-xs leading-4 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground"
          >
            {label}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64 p-1" data-testid="task-project-menu">
          <div className="px-1 pb-1">
            <input
              ref={inputRef}
              type="text"
              aria-label="Task project"
              data-testid="task-project-input"
              value={projectDraft}
              placeholder="No project"
              onChange={(event) => {
                setProjectDraft(event.target.value);
                setProjectError(null);
                setProjectActive(0);
              }}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  const next = query;
                  if (next.length === 0) acceptProject("");
                  else acceptProject(next);
                  openMenu(false);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setProjectDraft(current);
                  setProjectError(null);
                  openMenu(false);
                }
              }}
              className="h-11 w-full rounded-md border border-border bg-background px-2 text-sm leading-5 text-foreground outline-none placeholder:text-foreground/50 focus-visible:ring-1 focus-visible:ring-foreground"
            />
          </div>
          <DropdownMenuItem
            data-testid="task-project-clear"
            onSelect={() => {
              acceptProject("");
            }}
          >
            No project
          </DropdownMenuItem>
          {matches.map((name) => (
            <DropdownMenuItem
              key={name}
              data-testid={`project-suggestion-${name}`}
              onSelect={() => acceptProject(name)}
            >
              @{name}
            </DropdownMenuItem>
          ))}
          {canCreate && (
            <DropdownMenuItem
              data-testid={`project-suggestion-${query}`}
              onSelect={() => acceptProject(query)}
            >
              Create @{query}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {projectError !== null && <ErrorLine>{projectError}</ErrorLine>}
    </div>
  );
}

function BodyField({ model, fill }: { model: TaskDetailModel; fill?: boolean }) {
  const {
    task,
    editingBody,
    bodyDraft,
    bodyError,
    bodyRef,
    bodyEditorRef,
    bodyIgnoreBlur,
    setBodyDraft,
    setBodyError,
    setEditingBody,
    beginBodyEdit,
    saveBody,
  } = model;
  const grow = fill === true;
  if (editingBody) {
    return (
      <div
        data-testid="task-body-section"
        className={cn("flex min-w-0 flex-col gap-1", grow && "min-h-32 flex-1")}
      >
        <div
          ref={bodyEditorRef}
          className={cn("flex min-w-0 flex-col", grow && "min-h-0 flex-1 overflow-hidden")}
        >
          <textarea
            ref={bodyRef}
            aria-label="Task body"
            data-testid="task-body-input"
            rows={1}
            maxLength={TASK_BODY_MAX_LENGTH}
            value={bodyDraft}
            placeholder="Write markdown…"
            onChange={(event) => {
              setBodyDraft(event.target.value);
              setBodyError(null);
            }}
            onBlur={(event) => {
              if (bodyIgnoreBlur.current) {
                bodyIgnoreBlur.current = false;
                return;
              }
              void saveBody(event.currentTarget.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                bodyIgnoreBlur.current = true;
                setBodyDraft(task.body ?? "");
                setBodyError(null);
                setEditingBody(false);
              }
            }}
            className={cn(
              "block w-full min-w-0 resize-none border-0 bg-transparent p-0 text-sm leading-5 text-foreground outline-none placeholder:text-foreground/50 focus-visible:ring-1 focus-visible:ring-foreground",
              grow
                ? "min-h-0 flex-1 overflow-y-auto"
                : cn("max-h-[min(60vh,40rem)] overflow-y-auto", SCROLLBAR_GUTTER),
            )}
          />
        </div>
        {bodyError !== null && <ErrorLine>{bodyError}</ErrorLine>}
      </div>
    );
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: the body keeps its markdown descendants instead of becoming a fieldset.
    <div
      data-testid="task-body-section"
      role="group"
      aria-label="Task body"
      {...{ tabIndex: 0 }}
      className={cn(
        "flex min-w-0 cursor-text flex-col gap-1 outline-none focus-visible:ring-1 focus-visible:ring-foreground",
        grow && "min-h-32 flex-1",
      )}
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("a, button") !== null) {
          return;
        }
        beginBodyEdit();
      }}
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          beginBodyEdit();
        }
      }}
    >
      <div
        data-testid={task.body !== undefined && task.body.length > 0 ? "task-body" : undefined}
        className={cn(
          "min-w-0 cursor-text text-sm leading-5",
          task.body !== undefined && task.body.length > 0
            ? cn(
                "overflow-y-auto",
                SCROLLBAR_GUTTER,
                grow ? "min-h-0 max-h-full flex-1" : "max-h-[min(60vh,40rem)]",
              )
            : QUIET,
        )}
      >
        {task.body !== undefined && task.body.length > 0 ? (
          <div className="pr-1">
            <Markdown text={task.body} />
          </div>
        ) : (
          <p className="whitespace-pre-wrap break-words">Write markdown…</p>
        )}
      </div>
    </div>
  );
}

function MetaBlock({ model }: { model: TaskDetailModel }) {
  const { task, reason } = model;
  return (
    <div className="flex flex-col gap-3">
      {task.reopens !== undefined && task.reopens.length > 0 && (
        <section
          data-testid="task-reopen"
          className="flex flex-col gap-1 rounded-md border border-border bg-background px-3 py-2"
        >
          <SectionLabel>Last reopen</SectionLabel>
          <p className="whitespace-pre-wrap text-sm leading-5 [overflow-wrap:anywhere]">
            {task.reopens[task.reopens.length - 1]?.reason}
          </p>
          <time
            dateTime={task.reopens[task.reopens.length - 1]?.at}
            title={task.reopens[task.reopens.length - 1]?.at}
            className={cn("text-xs leading-4", QUIET)}
          >
            {task.reopens[task.reopens.length - 1]?.at}
          </time>
        </section>
      )}
      {task.releaseReason !== undefined && (
        <p
          data-testid={`task-released-${task.id}`}
          className={cn("text-xs leading-4 [overflow-wrap:anywhere]", QUIET)}
        >
          {`released${task.releasedAt === undefined ? "" : ` ${task.releasedAt}`} · ${task.releaseReason}`}
        </p>
      )}
      {reason !== null && (
        <p data-testid="task-failure" className={cn("text-sm leading-5", QUIET)}>
          {reason}
        </p>
      )}
      {task.rationale !== undefined && task.rationale.length > 0 && (
        <div
          data-testid="task-rationale"
          className={cn("min-w-0", model.wide && "max-h-40 overflow-y-auto")}
        >
          <p className="whitespace-pre-wrap pr-1 text-sm leading-5 [overflow-wrap:anywhere]">
            {task.rationale}
          </p>
        </div>
      )}
      {model.done && (
        <section className="flex flex-col gap-1" data-testid="task-modal-completion">
          <SectionLabel>Evidence</SectionLabel>
          {task.completion == null ? (
            <p className={cn("text-sm leading-5", QUIET)}>No evidence recorded</p>
          ) : (
            <p
              data-testid="task-evidence"
              className="whitespace-pre-wrap text-sm leading-5 [overflow-wrap:anywhere]"
            >
              {task.completion.evidence}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

function StatusMark({ done }: { done: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "size-3.5 shrink-0 rounded-sm border border-foreground/40",
        done && "border-foreground bg-foreground",
      )}
    />
  );
}

function RelationRow({
  wide,
  done,
  children,
}: {
  wide: boolean;
  done: boolean;
  children: ReactNode;
}) {
  return (
    <li
      className={cn(
        "flex items-center gap-2 border-t border-border px-1 py-2 text-sm leading-5 first:border-t-0",
        wide ? "min-h-8" : "min-h-11",
      )}
    >
      <StatusMark done={done} />
      {children}
    </li>
  );
}

function Subtasks({ model, heading = true }: { model: TaskDetailModel; heading?: boolean }) {
  if (model.children.length === 0) return null;
  return (
    <section className="flex flex-col gap-1">
      {heading ? <SectionLabel>Subtasks</SectionLabel> : null}
      <ul>
        {model.children.map((child) => (
          <RelationRow key={child.id} wide={model.wide} done={child.status === "done"}>
            <button
              type="button"
              onClick={() => model.onOpen(child.id)}
              className="min-w-0 flex-1 text-left text-sm leading-5 [overflow-wrap:anywhere] underline-offset-4 hover:underline"
            >
              <InlineMarkdown text={child.title} />
            </button>
          </RelationRow>
        ))}
      </ul>
    </section>
  );
}

function Attachments({ model }: { model: TaskDetailModel }) {
  const attachments = model.task.attachments;
  if (attachments === undefined || attachments.length === 0) return null;
  return (
    <section className="flex flex-wrap gap-2" data-testid="task-attachments">
      {attachments.map((id, index) => (
        <img
          key={id}
          src={mediaUrl(id)}
          alt={`Task attachment ${index + 1}`}
          loading="lazy"
          draggable={false}
          className="block size-16 rounded-md border border-border object-cover"
        />
      ))}
    </section>
  );
}

export function TaskActionsMenu({ model }: { model: TaskDetailModel }) {
  const {
    task,
    title,
    wide,
    statusPending,
    done,
    proposed,
    parked,
    backlogLabel,
    openChildren,
    onStatus,
    onApprove,
    onDismiss,
    onRemove,
  } = model;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid="task-detail-menu"
          aria-label={`Actions for ${title}`}
          className={cn("shrink-0 rounded-md", !wide && "min-h-11 min-w-11")}
        >
          <MoreVerticalIcon size={18} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="task-detail-menu-content">
        {proposed ? (
          <>
            <DropdownMenuItem onSelect={onApprove} aria-label={`Approve ${title} proposal`}>
              Approve
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={statusPending}
              data-testid="task-detail-backlog"
              onSelect={() => onStatus(task, parked ? "open" : "backlog")}
            >
              {backlogLabel}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={onDismiss}
              aria-label={`Dismiss ${title} proposal`}
            >
              Dismiss
            </DropdownMenuItem>
          </>
        ) : (
          <>
            {!done && (
              <DropdownMenuItem
                disabled={statusPending}
                data-testid="task-detail-backlog"
                onSelect={() => onStatus(task, parked ? "open" : "backlog")}
              >
                {backlogLabel}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              data-testid="task-detail-status"
              disabled={openChildren && !done}
              title={openChildren && !done ? "Finish open subtasks first" : undefined}
              onSelect={() => {
                if (openChildren && !done) return;
                onStatus(task, done ? "open" : "done");
              }}
            >
              {done ? "Reopen…" : "Mark done"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              data-testid="task-detail-remove"
              onSelect={onRemove}
              aria-label={`Remove ${title} task`}
            >
              Remove
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MetaLine({ model }: { model: TaskDetailModel }) {
  const created = formatCompactDateTime(model.task.createdAt);
  const closed =
    model.task.status === "done" && typeof model.task.completedAt === "string"
      ? formatCompactDateTime(model.task.completedAt)
      : "";
  return (
    <div
      data-testid="task-header-meta"
      className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-4", QUIET)}
    >
      <Badge
        data-testid="task-state"
        variant={model.state === "working" || model.state === "failed" ? "default" : "outline"}
        className="h-5 px-1.5 text-[10px] font-normal leading-4"
      >
        {model.badge}
      </Badge>
      {(model.task.reopens?.length ?? 0) > 0 && (
        <Badge
          variant="outline"
          data-testid={`task-detail-reopens-${model.task.id}`}
          title={`Reopened ${model.task.reopens?.length} time${model.task.reopens?.length === 1 ? "" : "s"}`}
          className="h-5 gap-1 px-1.5 text-[10px] font-normal leading-4 text-foreground/75"
        >
          <RefreshIcon size={11} />
          {model.task.reopens?.length}
        </Badge>
      )}
      <span data-testid="task-detail-id" title={model.task.id} className="font-mono">
        {shortId(model.task.id)}
      </span>
      <ProjectPicker model={model} />
      {created !== "" && (
        <time
          dateTime={model.task.createdAt}
          data-testid="task-times"
          title={created}
          className="shrink-0 text-foreground/75"
        >
          created {created}
        </time>
      )}
      {closed !== "" && (
        <time
          dateTime={model.task.completedAt ?? undefined}
          title={closed}
          className="shrink-0 text-foreground/75"
        >
          closed {closed}
        </time>
      )}
    </div>
  );
}

function TitleCard({
  model,
  tabs,
  flush = false,
}: {
  model: TaskDetailModel;
  tabs?: ReactNode;
  flush?: boolean;
}) {
  return (
    <header
      data-testid="task-header"
      className={cn(
        "flex flex-col bg-surface",
        flush ? "rounded-t-none rounded-b-[var(--radius)] overflow-hidden" : "theme-radius",
        tabs || flush ? "overflow-hidden" : "gap-2 p-3",
      )}
    >
      <div className={cn("flex flex-col gap-2", (tabs || flush) && "p-3")}>
        <div className="flex min-w-0 items-center gap-1">
          <div className="min-w-0 flex-1">
            <MetaLine model={model} />
          </div>
          <TaskActionsMenu model={model} />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-testid="task-detail-back"
            aria-label="Close"
            onClick={model.onClose}
            className={cn("shrink-0 rounded-md", !model.wide && "min-h-11 min-w-11")}
          >
            <CloseIcon size={18} />
          </Button>
        </div>
        <TitleField model={model} />
      </div>
      {tabs}
    </header>
  );
}

function hasLeftoverMeta(model: TaskDetailModel): boolean {
  const { task, reason, done } = model;
  return (
    (task.reopens !== undefined && task.reopens.length > 0) ||
    task.releaseReason !== undefined ||
    reason !== null ||
    (task.rationale !== undefined && task.rationale.length > 0) ||
    done
  );
}

function PlanSections({ model }: { model: TaskDetailModel }) {
  const attachments = model.task.attachments;
  const hasAttachments = attachments !== undefined && attachments.length > 0;
  const leftoverMeta = hasLeftoverMeta(model);
  return (
    <div
      className={cn(
        "flex min-h-0 flex-col gap-3",
        model.wide ? "min-h-0 flex-1 overflow-hidden" : undefined,
      )}
    >
      <div className="flex shrink-0 flex-col gap-3">
        {model.children.length > 0 && (
          <div data-testid="task-subtasks-card" className={DETAIL_CARD}>
            <Subtasks model={model} />
          </div>
        )}
        {hasAttachments && (
          <div data-testid="task-attachments-card" className={DETAIL_CARD}>
            <Attachments model={model} />
          </div>
        )}
        {leftoverMeta && (
          <div data-testid="task-meta-card" className={DETAIL_CARD}>
            <MetaBlock model={model} />
          </div>
        )}
        {model.notice !== null && <ErrorLine>{model.notice}</ErrorLine>}
      </div>
      <section
        data-testid="task-plan-card"
        className={cn(DETAIL_CARD, "flex min-h-0 flex-col", model.wide && "min-h-0 flex-1")}
      >
        <BodyField model={model} fill={model.wide} />
      </section>
    </div>
  );
}

function TabBar({ tab, onTab }: { tab: "plan" | "chat"; onTab: (tab: "plan" | "chat") => void }) {
  const tabs = [
    { id: "plan" as const, label: "Plan" },
    { id: "chat" as const, label: "Chat" },
  ];
  return (
    <div role="tablist" aria-label="Task sections" className="flex">
      {tabs.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={tab === item.id}
          data-testid={`task-tab-${item.id}`}
          className={cn(
            "min-h-11 flex-1 border-b-2 px-3 text-sm font-medium leading-5",
            tab === item.id
              ? "border-foreground bg-background text-foreground"
              : cn("border-transparent", QUIET),
          )}
          onClick={() => onTab(item.id)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function MobileDetail({ model }: { model: TaskDetailModel }) {
  const [tab, setTab] = useState<"plan" | "chat">("plan");

  return (
    <article
      data-testid="task-detail"
      data-layout="mobile"
      aria-label={model.title}
      className="-mx-4 -mt-4 flex min-h-0 flex-1 flex-col"
    >
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          tab === "plan" ? "overflow-y-auto" : "overflow-hidden",
        )}
      >
        <TitleCard model={model} tabs={<TabBar tab={tab} onTab={setTab} />} flush />
        <div className={cn("flex flex-col gap-3 px-3 pt-3", tab !== "plan" && "hidden")}>
          <PlanSections model={model} />
        </div>
        <div className={cn("flex min-h-0 flex-1 flex-col px-3 pt-3", tab !== "chat" && "hidden")}>
          <TaskAgentChat
            task={model.task}
            projects={model.projects}
            variant="pane"
            composerTarget="dock"
          />
        </div>
      </div>
    </article>
  );
}

function DesktopPlan({ model }: { model: TaskDetailModel }) {
  return (
    <article
      data-testid="task-detail"
      data-layout="desktop"
      aria-label={model.title}
      className="flex h-full min-h-0 flex-col gap-3 overflow-hidden"
    >
      <TitleCard model={model} />
      <PlanSections model={model} />
    </article>
  );
}

export function TaskDetailVariant({ model }: { model: TaskDetailModel }) {
  if (model.wide) return <DesktopPlan model={model} />;
  return <MobileDetail key={model.task.id} model={model} />;
}
