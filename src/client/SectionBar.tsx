import type { ElementType, ReactNode } from "react";
import { cn } from "./lib/utils";

/** Shared chrome for a stats-page section heading and the desktop task-details bar. */
export const SECTION_BAR =
  "relative theme-radius flex items-center border border-border/70 bg-surface px-2 py-1";

export const SECTION_BAR_LABEL =
  "min-w-0 flex-1 bg-transparent font-mono text-xs font-semibold text-foreground outline-none [overflow-wrap:anywhere]";

export const SECTION_BAR_ICON_BUTTON =
  "theme-radius border border-border/70 bg-surface px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-40";

export const SECTION_BAR_ACTIONS = "absolute top-1 right-1 z-10 flex items-center gap-1";

export function SectionBar({
  children,
  actions,
  as: Tag = "div",
  className,
  testId,
  heading = false,
}: {
  children: ReactNode;
  actions?: ReactNode;
  as?: ElementType;
  className?: string;
  testId?: string;
  heading?: boolean;
}) {
  return (
    <Tag
      className={cn(SECTION_BAR, actions !== undefined ? "pr-20" : undefined, className)}
      data-testid={testId}
      data-section-heading={heading ? "" : undefined}
    >
      {children}
      {actions !== undefined && <div className={SECTION_BAR_ACTIONS}>{actions}</div>}
    </Tag>
  );
}
