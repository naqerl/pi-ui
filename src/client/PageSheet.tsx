import { type ReactNode, useEffect, useRef } from "react";
import { cn } from "./lib/utils";

/**
 * The one native page-sheet shell: modal focus, scroll lock and backdrop close.
 * Both the activity view and the background-work sheet mount inside it.
 */
export function PageSheet({
  testId,
  titleId,
  onClose,
  className,
  children,
}: {
  testId: string;
  titleId: string;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    const bodyOverflow = document.body.style.overflow;
    const htmlOverflow = document.documentElement.style.overflow;
    // The transcript behind the sheet must not move while it is open.
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    if (dialog !== null && !dialog.open) dialog.showModal();
    return () => {
      dialog?.close();
      document.body.style.overflow = bodyOverflow;
      document.documentElement.style.overflow = htmlOverflow;
    };
  }, []);

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc is handled by the dialog cancel event.
    <dialog
      ref={ref}
      data-testid={testId}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // Clicks on the backdrop land on the dialog itself; the panel fills the rest.
        if (event.target === event.currentTarget) onClose();
      }}
      className={cn(
        "m-0 mt-auto flex w-full max-w-full flex-col overflow-hidden rounded-t-xl border border-foreground/15 bg-surface p-0 text-foreground shadow-xl backdrop:bg-foreground/30 sm:m-auto sm:w-[min(48rem,calc(100vw-2rem))] sm:rounded-xl",
        className,
      )}
    >
      {children}
    </dialog>
  );
}
