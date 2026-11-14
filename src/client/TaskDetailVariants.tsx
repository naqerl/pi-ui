import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { taskDeepLinkFromLocation } from "../shared/pages";
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
import { CloseIcon, MoreIcon, MoreVerticalIcon, PlusIcon, RefreshIcon } from "./icons";
import { cn } from "./lib/utils";
import { MediaViewer } from "./MediaViewer";
import { InlineMarkdown, Markdown } from "./markdown";
import { mediaUrl } from "./media-client";
import type { ProjectSuggestion } from "./ProjectSuggestions";
import { SECTION_BAR_ICON_BUTTON, SECTION_BAR_LABEL, SectionBar } from "./SectionBar";
import { TaskAgentChat } from "./TaskAgentChat";
import { TaskPlanningBadge } from "./TaskPlanningBadge";
import type { TaskMedia } from "./use-task-media";

function shortId(id: string): string {
  return id.slice(0, 4);
}

const SCROLLBAR_GUTTER = "[scrollbar-gutter:stable]";
const QUIET = "text-foreground/75";
const DETAIL_CARD = "bg-surface theme-radius p-3";

export interface TaskDetailModel {
  task: Task;
  tasks: Task[];
  media: TaskMedia;
  state: TaskState;
  trace: TaskTrace | undefined;
  wide: boolean;
  /** This task's plan agent currently has a live run. */
  planning: boolean;
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
  draft: boolean;
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

function ProjectPicker({
  model,
  startOpen = false,
  onClose,
}: {
  model: TaskDetailModel;
  startOpen?: boolean;
  onClose?: () => void;
}) {
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
  const [open, setOpen] = useState(startOpen);
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
    } else {
      onClose?.();
    }
  };

  useEffect(() => {
    if (!startOpen) return;
    setProjectOpen(true);
    setProjectDraft(current);
    setProjectError(null);
    setProjectActive(0);
  }, [startOpen, current, setProjectOpen, setProjectDraft, setProjectError, setProjectActive]);

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
          <Badge
            variant="outline"
            data-testid={`task-detail-reopens-${task.id}`}
            title={`Reopened ${task.reopens.length} time${task.reopens.length === 1 ? "" : "s"}`}
            className="h-5 w-fit gap-1 px-1.5 text-[10px] font-normal leading-4 text-foreground/75"
          >
            <RefreshIcon size={11} />
            {task.reopens.length}
          </Badge>
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
  const { media } = model;
  const count = media.attachments.length + media.pending.length;
  if (count === 0) return null;
  return (
    <section className="flex flex-wrap gap-2" data-testid="task-attachments">
      {media.attachments.map((id, index) => (
        <div key={id} className="relative shrink-0">
          <button
            type="button"
            aria-label={`Open image ${index + 1}`}
            aria-haspopup="dialog"
            data-testid={`task-attachment-open-${index + 1}`}
            onClick={() => media.setViewer({ id, alt: `Task image ${index + 1}` })}
            className="block size-16 overflow-hidden rounded-md border border-border bg-background focus-visible:ring-1 focus-visible:ring-foreground"
          >
            <img
              src={mediaUrl(id)}
              alt={`Task attachment ${index + 1}`}
              loading="lazy"
              draggable={false}
              className="block size-16 object-cover"
            />
          </button>
          <button
            type="button"
            aria-label={`Remove image ${index + 1}`}
            data-testid={`task-attachment-remove-${index + 1}`}
            disabled={media.busy}
            onClick={() => void media.remove(id)}
            className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-foreground font-mono text-[11px] leading-none text-background disabled:opacity-50"
          >
            <CloseIcon size={12} />
          </button>
        </div>
      ))}
      {media.pending.map((item, index) => (
        <div
          key={item.key}
          data-status="uploading"
          className="relative size-16 shrink-0 overflow-hidden rounded-md border border-border opacity-60"
        >
          <img
            src={item.preview}
            alt={`Uploading attachment ${media.attachments.length + index + 1}`}
            draggable={false}
            className="block size-16 animate-pulse object-cover"
          />
        </div>
      ))}
      <button
        type="button"
        aria-label="Add image"
        data-testid="task-media-add"
        disabled={media.busy || media.atLimit}
        onClick={media.open}
        className="grid size-16 place-items-center rounded-md border border-dashed border-border text-muted-foreground disabled:opacity-50"
      >
        <PlusIcon size={18} />
      </button>
    </section>
  );
}

export function TaskActionsMenu({
  model,
  bar = false,
  onRename,
  onChangeProject,
}: {
  model: TaskDetailModel;
  bar?: boolean;
  onRename?: () => void;
  onChangeProject?: () => void;
}) {
  const {
    task,
    title,
    wide,
    statusPending,
    done,
    proposed,
    draft,
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
        {bar ? (
          <button
            type="button"
            className={SECTION_BAR_ICON_BUTTON}
            data-testid="task-detail-menu"
            aria-label={`Actions for ${title}`}
          >
            <MoreIcon size={12} />
          </button>
        ) : (
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
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" data-testid="task-detail-menu-content">
        {onRename !== undefined && (
          <DropdownMenuItem data-testid="task-detail-rename" onSelect={onRename}>
            Rename…
          </DropdownMenuItem>
        )}
        {onChangeProject !== undefined && (
          <DropdownMenuItem data-testid="task-change-project" onSelect={onChangeProject}>
            Change project…
          </DropdownMenuItem>
        )}
        <DropdownMenuItem
          data-testid="task-detail-add-image"
          disabled={model.media.busy || model.media.atLimit}
          onSelect={() => model.media.open()}
        >
          Add image…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {draft ? (
          <>
            <DropdownMenuItem
              data-testid="task-detail-approve"
              onSelect={onApprove}
              aria-label={`Approve ${title} draft`}
            >
              Approve draft
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              data-testid="task-detail-remove"
              onSelect={onRemove}
              aria-label={`Remove ${title} draft`}
            >
              Remove
            </DropdownMenuItem>
          </>
        ) : proposed ? (
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
      {model.planning && (
        <TaskPlanningBadge testId={`task-detail-planning-${model.task.id}`} className="h-5" />
      )}
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
  const [projectPanel, setProjectPanel] = useState(false);

  if (model.wide) {
    return (
      <header
        data-testid="task-header"
        className="col-start-2 col-span-2 flex min-w-0 flex-col gap-2"
      >
        <SectionBar
          testId="task-details-bar"
          actions={
            <>
              <TaskActionsMenu
                model={model}
                bar
                onRename={() => {
                  model.setTitleDraft(model.task.title);
                  model.setTitleError(null);
                  model.setEditingTitle(true);
                }}
                onChangeProject={() => {
                  model.setProjectDraft(model.task.project ?? "");
                  model.setProjectError(null);
                  setProjectPanel(true);
                }}
              />
              <button
                type="button"
                className={SECTION_BAR_ICON_BUTTON}
                data-testid="task-detail-back"
                aria-label="Close"
                onClick={model.onClose}
              >
                <CloseIcon size={12} />
              </button>
            </>
          }
        >
          <h2 className={SECTION_BAR_LABEL}>Task details</h2>
          {model.planning && (
            <TaskPlanningBadge
              testId={`task-detail-planning-${model.task.id}`}
              className="h-5 shrink-0"
            />
          )}
        </SectionBar>
        {(model.editingTitle || model.titleError !== null) && (
          <div className="bg-surface theme-radius p-3">
            <TitleField model={model} />
          </div>
        )}
        {projectPanel && (
          <div className="bg-surface theme-radius p-3" data-testid="task-project-panel">
            <ProjectPicker model={model} startOpen onClose={() => setProjectPanel(false)} />
          </div>
        )}
      </header>
    );
  }

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
  const hasAttachments = model.media.attachments.length + model.media.pending.length > 0;
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
        {model.media.error !== null && <ErrorLine>{model.media.error}</ErrorLine>}
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

function linkedTab(taskId: string): "plan" | "chat" {
  const link =
    typeof window === "undefined" ? null : taskDeepLinkFromLocation(window.location.href);
  return link !== null && link.id === taskId && link.tab !== null ? "chat" : "plan";
}

function MobileDetail({ model }: { model: TaskDetailModel }) {
  const [tab, setTab] = useState<"plan" | "chat">(() => linkedTab(model.task.id));

  useEffect(() => {
    const sync = () => setTab(linkedTab(model.task.id));
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [model.task.id]);

  return (
    <article
      data-testid="task-detail"
      data-layout="mobile"
      aria-label={model.title}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <TitleCard model={model} tabs={<TabBar tab={tab} onTab={setTab} />} flush />
      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col",
          tab === "plan" ? "overflow-y-auto" : "overflow-hidden",
        )}
      >
        <div className={cn("flex flex-col gap-3 px-3 pt-3", tab !== "plan" && "hidden")}>
          <PlanSections model={model} />
        </div>
        <div className={cn("flex min-h-0 flex-1 flex-col px-3", tab !== "chat" && "hidden")}>
          <TaskAgentChat
            key={model.task.id}
            task={model.task}
            projects={model.projects}
            variant="pane"
            composerTarget="dock"
            active={tab === "chat"}
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
      className="flex h-full min-h-0 min-w-0 flex-col gap-3 overflow-hidden"
    >
      <PlanSections model={model} />
    </article>
  );
}

export function TaskDetailVariant({ model }: { model: TaskDetailModel }) {
  return (
    <>
      {model.wide ? (
        <>
          <TitleCard key={model.task.id} model={model} />
          <div
            data-col="mid"
            data-testid="tasks-mid-col"
            className="flex h-full min-h-0 min-w-0 flex-col"
          >
            <DesktopPlan model={model} />
          </div>
        </>
      ) : (
        <MobileDetail key={model.task.id} model={model} />
      )}
      {model.media.input}
      {model.media.viewer !== null && (
        <MediaViewer
          id={model.media.viewer.id}
          alt={model.media.viewer.alt}
          onClose={() => model.media.setViewer(null)}
        />
      )}
    </>
  );
}
