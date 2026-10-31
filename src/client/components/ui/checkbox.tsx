import type * as React from "react";
import { cn } from "../../lib/utils";

/**
 * A shadcn-style checkbox drawn as a toggle button, so it can sit inside a clickable row and
 * keep a plain "Done X" / "Reopen X" name.
 */
function Checkbox({
  checked,
  className,
  ...props
}: Omit<React.ComponentProps<"button">, "type"> & { checked: boolean }) {
  return (
    <button
      type="button"
      data-slot="checkbox"
      data-state={checked ? "checked" : "unchecked"}
      className={cn(
        "peer grid size-4 shrink-0 place-items-center rounded-sm border border-foreground/60 text-background focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-foreground aria-disabled:opacity-50 data-[state=checked]:border-foreground data-[state=checked]:bg-foreground",
        className,
      )}
      {...props}
    >
      {checked && <CheckIcon />}
    </button>
  );
}

function CheckIcon() {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="size-3"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export { Checkbox };
