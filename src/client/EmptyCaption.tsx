import type { ReactNode } from "react";
import { cn } from "./lib/utils";

/** Glass card for empty-state / helper text over the animated background. */
export function EmptyCaption({
  children,
  className,
  testId,
  mono = false,
}: {
  children: ReactNode;
  className?: string;
  testId?: string;
  mono?: boolean;
}) {
  return (
    <p
      data-testid={testId}
      className={cn(
        "glass-caption px-3 py-2 text-center text-muted-foreground",
        mono ? "font-mono text-xs leading-5" : "text-sm leading-5",
        className,
      )}
    >
      {children}
    </p>
  );
}
