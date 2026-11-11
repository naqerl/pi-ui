import { type KeyboardEvent, type ReactNode, type RefObject, useState } from "react";
import { TASK_BODY_MAX_LENGTH } from "../shared/tasks";
import { formatDateTime } from "../shared/time";
import type { Task, TaskLedger, TaskState, TaskTrace } from "../shared/types";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "./components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./components/ui/collapsible";
import { cn } from "./lib/utils";
import { InlineMarkdown, Markdown, plainInline } from "./markdown";
import { mediaUrl } from "./media-client";
import { type ProjectSuggestion, ProjectSuggestions } from "./ProjectSuggestions";
import { TaskAgentChat } from "./TaskAgentChat";

function shortId(id: string): string {
  return id.slice(0, 4);
}

function TaskIdBadge({ id, testId }: { id: string; testId: string }) {
  return (
    <Badge
      variant="outline"
      data-testid={testId}
      title={id}
      className="font-mono text-[10px] leading-4 text-foreground/75"
    >
      {shortId(id)}
    </Badge>
  );
}

function ReopenBadge({ task, testId }: { task: Task; testId: string }) {
  const count = task.reopens?.length ?? 0;
  if (count === 0) return null;
  return (
    <Badge
      variant="outline"
      data-testid={testId}
      title={`Reopened ${count} time${count === 1 ? "" : "s"}`}
      className="h-4 px-1.5 text-[10px] font-normal leading-4 text-foreground/75"
    >
      {count}
    </Badge>
  );
}

function CreatedTimes({ task }: { task: Task }) {
  const created = formatDateTime(task.createdAt);
  const closed =
    task.status === "done" && typeof task.completedAt === "string"
      ? formatDateTime(task.completedAt)
      : "";
  return (
    <span
      data-testid="task-times"
      className="flex flex-wrap items-center gap-x-3 text-xs leading-4 text-foreground/75"
    >
      <time dateTime={task.createdAt} title={created}>
        Created {created}
      </time>
      {closed !== "" && (
        <time dateTime={task.completedAt ?? undefined} title={closed}>
          Closed {closed}
        </time>
      )}
    </span>
  );
}

const SCROLLBAR_GUTTER = "[scrollbar-gutter:stable]";
const QUIET = "text-foreground/75";
const STACK = "flex min-h-0 flex-col gap-3";

export type TaskDetailVariantId = 1 | 2 | 3 | 4 | 5;

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

function hit(wide: boolean, className?: string) {
  return cn("rounded-md", !wide && "min-h-11", className);
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

function BackRow({ model }: { model: TaskDetailModel }) {
  const { parent, wide, onClose, onOpen } = model;
  if (parent === undefined && wide) return null;
  return (
    <div className={cn("flex items-center gap-2", !wide && "min-h-11")}>
      {!wide && (
        <Button
          variant="ghost"
          size="sm"
          data-testid="task-detail-back"
          aria-label="Back to tasks"
          onClick={onClose}
          className={hit(wide, "-ml-2 shrink-0 px-3")}
        >
          Back
        </Button>
      )}
      <span className={cn("min-w-0 flex-1 truncate text-xs leading-4", QUIET)}>
        {parent !== undefined && (
          <button
            type="button"
            className="underline-offset-4 hover:underline"
            onClick={() => onOpen(parent.id)}
          >
            {plainInline(parent.title)}
          </button>
        )}
      </span>
    </div>
  );
}

function TitleField({ model }: { model: TaskDetailModel }) {
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
          className="block w-full min-w-0 resize-none overflow-hidden border-0 bg-transparent p-0 text-lg font-semibold leading-7 text-foreground outline-none [overflow-wrap:anywhere] focus-visible:ring-1 focus-visible:ring-foreground"
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
        className="min-w-0 cursor-text outline-none focus-visible:ring-1 focus-visible:ring-foreground"
        onFocus={() => {
          setTitleDraft(task.title);
          setTitleError(null);
          setEditingTitle(true);
        }}
      >
        <h2 className="min-w-0 text-lg font-semibold leading-7 [overflow-wrap:anywhere]">
          <InlineMarkdown text={task.title} />
        </h2>
      </div>
      {titleError !== null && <ErrorLine>{titleError}</ErrorLine>}
    </div>
  );
}

function Badges({ model }: { model: TaskDetailModel }) {
  const { task, state, badge } = model;
  return (
    <span className="mt-1 flex shrink-0 flex-wrap items-center justify-end gap-1.5">
      <ReopenBadge task={task} testId={`task-detail-reopens-${task.id}`} />
      <TaskIdBadge id={task.id} testId="task-detail-id" />
      <Badge
        data-testid="task-state"
        variant={state === "working" || state === "failed" ? "default" : "outline"}
      >
        {badge}
      </Badge>
    </span>
  );
}

function ProjectField({ model }: { model: TaskDetailModel }) {
  const {
    task,
    wide,
    projectDraft,
    projectError,
    projectMatches,
    activeProject,
    projectAnchor,
    setProjectDraft,
    setProjectError,
    setProjectActive,
    setProjectOpen,
    acceptProject,
    saveProject,
  } = model;
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="task-project-line">
      <div className="flex min-w-0 items-center gap-3">
        <span className={cn("shrink-0 text-xs leading-4", QUIET)}>Project</span>
        <div ref={projectAnchor} className="min-w-0 flex-1">
          {projectMatches.length > 0 && (
            <ProjectSuggestions
              anchor={projectAnchor}
              items={projectMatches}
              active={activeProject}
              onHover={setProjectActive}
              onAccept={(item) => acceptProject(item.name)}
            />
          )}
          <input
            type="text"
            aria-label="Task project"
            data-testid="task-project-input"
            value={projectDraft}
            placeholder="No project"
            aria-autocomplete="list"
            aria-controls={projectMatches.length > 0 ? "project-suggestions" : undefined}
            aria-activedescendant={
              projectMatches.length > 0 ? `project-suggestion-${activeProject}` : undefined
            }
            onChange={(event) => {
              setProjectDraft(event.target.value);
              setProjectError(null);
              setProjectActive(0);
              setProjectOpen(true);
            }}
            onFocus={() => setProjectActive(0)}
            onBlur={() => {
              setProjectOpen(false);
              void saveProject();
            }}
            onKeyDown={(event) => {
              if (projectMatches.length > 0) {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  const count = projectMatches.length;
                  setProjectActive(
                    (activeProject + (event.key === "ArrowDown" ? 1 : count - 1)) % count,
                  );
                  return;
                }
                if (event.key === "Enter" || event.key === "Tab") {
                  event.preventDefault();
                  const item = projectMatches[activeProject];
                  if (item !== undefined) acceptProject(item.name);
                  return;
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setProjectOpen(false);
                  return;
                }
              }
              if (event.key === "Enter") {
                event.preventDefault();
                setProjectOpen(false);
                void saveProject();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setProjectDraft(task.project ?? "");
                setProjectError(null);
                setProjectOpen(false);
              }
            }}
            className={cn(
              "w-full min-w-0 rounded-md border border-border bg-background px-2 text-sm leading-5 text-foreground outline-none placeholder:text-foreground/50 focus-visible:ring-1 focus-visible:ring-foreground",
              wide ? "h-8" : "h-11",
            )}
          />
        </div>
      </div>
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
        className={cn("flex min-w-0 flex-col gap-1", grow && "min-h-0 flex-1")}
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
        grow && "min-h-0 flex-1",
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
                grow ? "min-h-0 flex-1" : "max-h-[min(60vh,40rem)]",
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
      <CreatedTimes task={task} />
      {task.releaseReason !== undefined && (
        <p
          data-testid={`task-released-${task.id}`}
          className={cn("text-xs leading-4 [overflow-wrap:anywhere]", QUIET)}
        >
          {`released${task.releasedAt === undefined ? "" : ` ${task.releasedAt}`} · ${task.releaseReason}`}
        </p>
      )}
      {task.createdBy !== undefined && (
        <p data-testid="task-created-by" className={cn("font-mono text-xs leading-4", QUIET)}>
          {task.createdBy === "agent" ? "Created by the agent" : "Created by the operator"}
        </p>
      )}
      {reason !== null && (
        <p data-testid="task-failure" className={cn("text-sm leading-5", QUIET)}>
          {reason}
        </p>
      )}
      {task.rationale !== undefined && task.rationale.length > 0 && (
        <div data-testid="task-rationale" className="min-w-0">
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

function Blockers({ model, heading = true }: { model: TaskDetailModel; heading?: boolean }) {
  if (model.blockers.length === 0) return null;
  return (
    <section className="flex flex-col gap-1">
      {heading ? <SectionLabel>Blocked by</SectionLabel> : null}
      <ul className="flex flex-col gap-1">
        {model.blockers.map((blocker) => (
          <li
            key={blocker.id}
            className={cn(
              "flex items-center gap-2 text-sm leading-5 [overflow-wrap:anywhere]",
              model.wide ? "min-h-8" : "min-h-11",
            )}
          >
            <span className="min-w-0 flex-1">{blocker.title}</span>
            {blocker.done && <Badge variant="outline">Done</Badge>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function Subtasks({ model, heading = true }: { model: TaskDetailModel; heading?: boolean }) {
  if (model.children.length === 0) return null;
  return (
    <section className="flex flex-col gap-1">
      {heading ? <SectionLabel>Subtasks</SectionLabel> : null}
      <ul className="flex flex-col gap-1">
        {model.children.map((child) => (
          <li
            key={child.id}
            className={cn("flex items-center gap-2", model.wide ? "min-h-8" : "min-h-11")}
          >
            <button
              type="button"
              onClick={() => model.onOpen(child.id)}
              className="min-w-0 flex-1 text-left text-sm leading-5 underline-offset-4 hover:underline"
            >
              <InlineMarkdown text={child.title} />
            </button>
            {child.status === "done" && <Badge variant="outline">Done</Badge>}
          </li>
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

function ActionButtons({ model }: { model: TaskDetailModel }) {
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
  const btn = hit(wide, "shrink-0");
  if (proposed) {
    return (
      <>
        <Button
          variant="outline"
          size="sm"
          className={btn}
          onClick={onDismiss}
          aria-label={`Dismiss ${title} proposal`}
        >
          Dismiss
        </Button>
        <Button
          variant="outline"
          size="sm"
          data-testid="task-detail-backlog"
          className={btn}
          disabled={statusPending}
          onClick={() => onStatus(task, parked ? "open" : "backlog")}
        >
          {backlogLabel}
        </Button>
        <span className="flex-1" />
        <Button
          size="sm"
          className={btn}
          onClick={onApprove}
          aria-label={`Approve ${title} proposal`}
        >
          Approve
        </Button>
      </>
    );
  }
  return (
    <>
      {!done && (
        <Button
          variant="outline"
          size="sm"
          data-testid="task-detail-backlog"
          className={btn}
          disabled={statusPending}
          onClick={() => onStatus(task, parked ? "open" : "backlog")}
        >
          {backlogLabel}
        </Button>
      )}
      <Button
        variant="outline"
        size="sm"
        className={btn}
        onClick={onRemove}
        aria-label={`Remove ${title} task`}
      >
        Remove
      </Button>
      <span className="flex-1" />
      <Button
        size="sm"
        variant={done ? "outline" : "default"}
        data-testid="task-detail-status"
        aria-disabled={openChildren}
        title={openChildren ? "Finish open subtasks first" : undefined}
        className={cn(btn, "aria-disabled:opacity-50")}
        onClick={() => {
          if (openChildren) return;
          onStatus(task, done ? "open" : "done");
        }}
      >
        {done ? "Reopen…" : "Mark done"}
      </Button>
    </>
  );
}

function ActionsCard({ model }: { model: TaskDetailModel }) {
  return (
    <Card>
      <CardFooter
        className={cn("flex flex-wrap gap-2 p-3", model.wide && "shrink-0")}
        data-testid="task-detail-actions"
      >
        <ActionButtons model={model} />
      </CardFooter>
      {model.notice !== null && (
        <CardContent className="px-3 pb-3">
          <ErrorLine>{model.notice}</ErrorLine>
        </CardContent>
      )}
    </Card>
  );
}

function ChatCard({ model, fill }: { model: TaskDetailModel; fill?: boolean }) {
  return (
    <Card
      className={cn(fill === true && "min-h-0 flex-1 overflow-hidden")}
      data-testid="task-chat-card"
    >
      <CardHeader
        className={cn("gap-1 p-3 pb-2", fill === true && "min-h-0 flex-1 overflow-hidden")}
      >
        <h3 className="text-sm font-medium leading-5">Planning chat</h3>
        <div
          className={cn("flex min-h-0 min-w-0 flex-col", fill === true && "flex-1 overflow-hidden")}
        >
          <TaskAgentChat task={model.task} projects={model.projects} />
        </div>
      </CardHeader>
    </Card>
  );
}

function HeaderCard({ model, compact }: { model: TaskDetailModel; compact?: boolean }) {
  return (
    <Card>
      <CardHeader className={cn("p-4", compact === true && "gap-2 p-3")}>
        <BackRow model={model} />
        <div className={cn("flex gap-3", compact === true ? "items-center" : "items-start")}>
          <div className="min-w-0 flex-1">
            <TitleField model={model} />
          </div>
          <Badges model={model} />
        </div>
        <ProjectField model={model} />
      </CardHeader>
    </Card>
  );
}

function PlanCard({ model, fill }: { model: TaskDetailModel; fill?: boolean }) {
  return (
    <Card className={cn(fill === true && "min-h-0 flex-1 overflow-hidden")}>
      <CardHeader className={cn("p-4", fill === true && "min-h-0 flex-1 overflow-hidden")}>
        <SectionLabel>Plan</SectionLabel>
        <BodyField model={model} fill={fill} />
      </CardHeader>
    </Card>
  );
}

function RelationsCard({ model }: { model: TaskDetailModel }) {
  return (
    <Card>
      <CardHeader className="p-4">
        <MetaBlock model={model} />
        <div className="flex flex-col gap-3 pt-1">
          <Blockers model={model} />
          <Subtasks model={model} />
          <Attachments model={model} />
        </div>
      </CardHeader>
    </Card>
  );
}

function VariantStacked({ model }: { model: TaskDetailModel }) {
  return (
    <article
      data-testid="task-detail"
      data-variant="1"
      aria-label={model.title}
      className={cn(STACK, model.wide && "h-full min-h-0 overflow-y-auto", SCROLLBAR_GUTTER)}
    >
      <HeaderCard model={model} />
      <PlanCard model={model} />
      <RelationsCard model={model} />
      <ActionsCard model={model} />
      <ChatCard model={model} fill={model.wide} />
    </article>
  );
}

function VariantTabs({ model }: { model: TaskDetailModel }) {
  const [tab, setTab] = useState<"overview" | "plan" | "chat">("plan");
  const tabs = [
    { id: "overview" as const, label: "Overview" },
    { id: "plan" as const, label: "Plan" },
    { id: "chat" as const, label: "Chat" },
  ];
  return (
    <article
      data-testid="task-detail"
      data-variant="2"
      aria-label={model.title}
      className={cn(STACK, model.wide && "h-full min-h-0")}
    >
      <HeaderCard model={model} />
      <ActionsCard model={model} />
      <Card className={cn("min-h-0", model.wide && "flex-1 overflow-hidden")}>
        <CardHeader className={cn("gap-3 p-3", model.wide && "min-h-0 flex-1 overflow-hidden")}>
          <div
            role="tablist"
            aria-label="Task sections"
            className="flex gap-1 border-b border-border"
          >
            {tabs.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={tab === item.id}
                data-testid={`task-tab-${item.id}`}
                className={cn(
                  "min-h-11 flex-1 px-3 text-sm font-medium leading-5",
                  tab === item.id
                    ? "border-b-2 border-foreground text-foreground"
                    : cn("border-b-2 border-transparent", QUIET),
                )}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className={cn("min-h-0", model.wide && "flex-1 overflow-hidden")}>
            {tab === "overview" && (
              <div
                className={cn(
                  "flex flex-col gap-3",
                  model.wide && cn("h-full overflow-y-auto", SCROLLBAR_GUTTER),
                )}
              >
                <MetaBlock model={model} />
                <Blockers model={model} />
                <Subtasks model={model} />
                <Attachments model={model} />
              </div>
            )}
            {tab === "plan" && <BodyField model={model} fill={model.wide} />}
            {tab === "chat" && (
              <div className={cn("flex min-h-0 flex-col", model.wide && "h-full overflow-hidden")}>
                <TaskAgentChat task={model.task} projects={model.projects} />
              </div>
            )}
          </div>
        </CardHeader>
      </Card>
    </article>
  );
}

function VariantChatFirst({ model }: { model: TaskDetailModel }) {
  return (
    <article
      data-testid="task-detail"
      data-variant="3"
      aria-label={model.title}
      className={cn(STACK, model.wide && "h-full min-h-0")}
    >
      <HeaderCard model={model} compact />
      <Collapsible
        defaultOpen
        className={cn("min-h-0 overflow-hidden", model.wide ? "max-h-[42%]" : "max-h-[48vh]")}
      >
        <Card className="max-h-full overflow-hidden">
          <CardHeader className="p-3">
            <CollapsibleTrigger
              data-testid="task-details-toggle"
              className={cn(
                "flex w-full items-center justify-between text-left text-sm font-medium leading-5",
                !model.wide && "min-h-11",
              )}
            >
              Task details
              <span className={cn("text-xs", QUIET)}>Title, plan, and links</span>
            </CollapsibleTrigger>
            <CollapsibleContent
              className={cn("flex flex-col gap-3 overflow-y-auto pt-3", SCROLLBAR_GUTTER)}
            >
              <BodyField model={model} />
              <MetaBlock model={model} />
              <Blockers model={model} />
              <Subtasks model={model} />
              <Attachments model={model} />
              <div className="flex flex-wrap gap-2" data-testid="task-detail-actions">
                <ActionButtons model={model} />
              </div>
              {model.notice !== null && <ErrorLine>{model.notice}</ErrorLine>}
            </CollapsibleContent>
          </CardHeader>
        </Card>
      </Collapsible>
      <ChatCard model={model} fill />
    </article>
  );
}

function DetailColumn({ model }: { model: TaskDetailModel }) {
  return (
    <div className={cn(STACK, "h-full min-h-0")}>
      <div
        className={cn("min-h-0 flex-1 overflow-y-auto", SCROLLBAR_GUTTER, "flex flex-col gap-3")}
      >
        <HeaderCard model={model} />
        <PlanCard model={model} />
        <RelationsCard model={model} />
      </div>
      <ActionsCard model={model} />
    </div>
  );
}

function VariantSplit({ model }: { model: TaskDetailModel }) {
  if (!model.wide) {
    return (
      <article
        data-testid="task-detail"
        data-variant="4"
        aria-label={model.title}
        className={STACK}
      >
        <HeaderCard model={model} />
        <PlanCard model={model} />
        <RelationsCard model={model} />
        <ActionsCard model={model} />
        <ChatCard model={model} />
      </article>
    );
  }
  return (
    <div data-testid="task-detail" data-variant="4" className="contents">
      <DetailColumn model={model} />
      <ChatCard model={model} fill />
    </div>
  );
}

function AccordionSection({
  title,
  testId,
  defaultOpen,
  wide,
  children,
}: {
  title: string;
  testId: string;
  defaultOpen?: boolean;
  wide: boolean;
  children: ReactNode;
}) {
  return (
    <Collapsible defaultOpen={defaultOpen} className="border-b border-border last:border-b-0">
      <CollapsibleTrigger
        data-testid={testId}
        className={cn(
          "flex w-full items-center justify-between px-4 py-3 text-left text-sm font-medium leading-5",
          !wide && "min-h-11",
        )}
      >
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent className="px-4 pb-4">{children}</CollapsibleContent>
    </Collapsible>
  );
}

function VariantAccordion({ model }: { model: TaskDetailModel }) {
  return (
    <article
      data-testid="task-detail"
      data-variant="5"
      aria-label={model.title}
      className={cn(STACK, model.wide && "h-full min-h-0")}
    >
      <HeaderCard model={model} compact />
      <ActionsCard model={model} />
      <Card className="overflow-hidden py-0">
        <AccordionSection title="Plan" testId="task-acc-plan" defaultOpen wide={model.wide}>
          <BodyField model={model} />
        </AccordionSection>
        <AccordionSection
          title="Blocked by"
          testId="task-acc-blockers"
          defaultOpen
          wide={model.wide}
        >
          {model.blockers.length > 0 ? (
            <Blockers model={model} heading={false} />
          ) : (
            <p className={cn("text-sm leading-5", QUIET)}>No blockers</p>
          )}
        </AccordionSection>
        <AccordionSection title="Subtasks" testId="task-acc-subtasks" defaultOpen wide={model.wide}>
          {model.children.length > 0 ? (
            <Subtasks model={model} heading={false} />
          ) : (
            <p className={cn("text-sm leading-5", QUIET)}>No subtasks</p>
          )}
        </AccordionSection>
        <AccordionSection title="Activity" testId="task-acc-meta" defaultOpen wide={model.wide}>
          <MetaBlock model={model} />
          <div className="pt-3">
            <Attachments model={model} />
          </div>
        </AccordionSection>
      </Card>
      <ChatCard model={model} fill={model.wide} />
    </article>
  );
}

export function TaskDetailVariant({
  variant,
  model,
}: {
  variant: TaskDetailVariantId;
  model: TaskDetailModel;
}) {
  if (variant === 2) return <VariantTabs model={model} />;
  if (variant === 3) return <VariantChatFirst model={model} />;
  if (variant === 4) return <VariantSplit model={model} />;
  if (variant === 5) return <VariantAccordion model={model} />;
  return <VariantStacked model={model} />;
}

export function TasksComposerDock({ variant, wide }: { variant: number; wide: boolean }) {
  if (!wide || variant < 1) return null;
  const slot = (
    <div id="tasks-composer-slot" data-testid="tasks-composer-slot" className="min-h-0 min-w-0" />
  );
  if (variant === 5) {
    return (
      <Card className="mt-3 shrink-0 p-3" data-testid="tasks-composer-chrome">
        <p className={cn("mb-2 text-xs font-medium leading-4", QUIET)}>Add a task</p>
        {slot}
      </Card>
    );
  }
  if (variant === 2) {
    return (
      <div
        className="mt-3 shrink-0 rounded-md border border-border bg-surface p-3"
        data-testid="tasks-composer-chrome"
      >
        <p className={cn("mb-2 text-xs font-medium leading-4", QUIET)}>New task</p>
        {slot}
      </div>
    );
  }
  if (variant === 3) {
    return (
      <div
        className="mt-2 shrink-0 border-t border-border pt-2"
        data-testid="tasks-composer-chrome"
      >
        {slot}
      </div>
    );
  }
  return (
    <div className="mt-3 shrink-0 border-t border-border pt-3" data-testid="tasks-composer-chrome">
      {slot}
    </div>
  );
}
