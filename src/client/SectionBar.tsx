import type { ElementType, ReactNode } from "react";
import { cn } from "./lib/utils";

export const SECTION_BAR =
  "relative theme-radius flex items-center justify-between gap-xl border border-border/70 bg-surface px-lg py-sm";

export const SECTION_BAR_LABEL =
  "min-w-0 flex-1 bg-transparent font-mono text-xs font-semibold text-foreground outline-none [overflow-wrap:anywhere]";

export const SECTION_BAR_ICON_BUTTON =
  "theme-radius border border-border/70 bg-surface px-md py-xs font-mono text-[10px] text-muted-foreground hover:bg-foreground/10 hover:text-foreground disabled:opacity-40";

export const SECTION_BAR_ACTIONS = "flex shrink-0 items-center gap-sm";

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
      className={cn(SECTION_BAR, className)}
      data-testid={testId}
      data-section-heading={heading ? "" : undefined}
    >
      {children}
      {actions !== undefined && <div className={SECTION_BAR_ACTIONS}>{actions}</div>}
    </Tag>
  );
}
