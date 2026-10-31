import type * as React from "react";
import { cn } from "../../lib/utils";

function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "h-8 w-full min-w-0 rounded-md border border-border bg-background px-2.5 text-sm leading-none text-foreground placeholder:text-muted-foreground outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-foreground disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
