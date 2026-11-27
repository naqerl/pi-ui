import type { TaskCycleHint } from "./use-task-cycle";

export function TaskCycleHud({ hint }: { hint: TaskCycleHint }) {
  const project = hint.task.project?.trim() ?? "";
  return (
    <div
      role="status"
      data-testid="task-cycle-hud"
      className="pointer-events-none flex min-w-0 max-w-[90vw] items-baseline gap-md theme-radius border border-foreground/10 bg-surface/90 px-xl py-md font-mono text-[11px] leading-4 text-foreground shadow-sm backdrop-blur-md"
    >
      <span className="shrink-0 tabular-nums">
        {hint.position}/{hint.total}
      </span>
      <span aria-hidden="true" className="shrink-0 opacity-60">
        ·
      </span>
      <span className="min-w-0 flex-1 truncate">{hint.task.title}</span>
      {project.length > 0 && (
        <>
          <span aria-hidden="true" className="shrink-0 opacity-60">
            ·
          </span>
          <span className="min-w-0 max-w-[40%] truncate">{project}</span>
        </>
      )}
      <span aria-hidden="true" className="shrink-0 opacity-60">
        ·
      </span>
      <span className="shrink-0">{hint.task.id.slice(0, 4)}</span>
    </div>
  );
}
