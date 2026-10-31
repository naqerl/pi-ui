import type * as React from "react";
import { cn } from "../../lib/utils";

/** shadcn's native select: the platform picker, styled like the other inputs. */
function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <span className={cn("relative inline-flex min-w-0 shrink-0 items-center", className)}>
      <select
        className="h-8 w-full min-w-0 cursor-pointer appearance-none rounded-md border border-border bg-background py-0 pr-8 pl-2.5 text-sm leading-none text-foreground outline-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-foreground disabled:cursor-not-allowed disabled:opacity-50"
        {...props}
      />
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        className="pointer-events-none absolute right-2.5 size-4 text-muted-foreground"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </span>
  );
}

export { NativeSelect };
