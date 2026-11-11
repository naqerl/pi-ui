import { useEffect, useId, useRef, useState } from "react";
import { formatDateTime } from "../shared/time";
import type { RunError } from "../shared/types";

/**
 * One static line at the top of the chat. It is absolutely placed so it never
 * pushes the transcript down, and the full multi-line error lives behind a
 * click instead of growing the header.
 */
export function RunErrorHeader({
  error,
  onDismiss,
}: {
  error: RunError;
  onDismiss: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const dateTime = formatDateTime(error.at);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <>
      <div
        role="alert"
        data-testid="run-error-header"
        data-error-class={error.class}
        className="pointer-events-none absolute inset-x-0 z-30 flex justify-center px-3"
        style={{ top: "max(0.5rem, env(safe-area-inset-top))" }}
      >
        <div className="theme-radius pointer-events-auto flex w-full max-w-[72ch] min-w-0 items-center gap-2 border border-destructive/40 bg-surface/95 py-1 pr-1 pl-3 font-mono text-[11px] leading-5 text-destructive shadow-sm backdrop-blur-md">
          <span aria-hidden="true" className="shrink-0">
            ⚠
          </span>
          <button
            type="button"
            data-testid="run-error-open"
            aria-haspopup="dialog"
            onClick={() => setOpen(true)}
            title={`${error.class}: ${error.message}`}
            className="min-w-0 flex-1 truncate text-left underline-offset-2 hover:underline"
          >
            <span data-testid="run-error-class">{error.class}</span>
            <span aria-hidden="true"> · </span>
            <span data-testid="run-error-message">{error.message}</span>
          </button>
          <button
            type="button"
            data-testid="run-error-dismiss"
            aria-label="Dismiss error"
            onClick={() => onDismiss(error.id)}
            className="shrink-0 rounded-md px-2 py-0.5 text-sm text-destructive hover:bg-destructive/10"
          >
            ✕
          </button>
        </div>
      </div>
      {open && (
        // biome-ignore lint/a11y/useKeyWithClickEvents: Esc is handled by the dialog cancel event.
        <dialog
          ref={ref}
          data-testid="run-error-dialog"
          aria-labelledby={titleId}
          onCancel={(event) => {
            event.preventDefault();
            setOpen(false);
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
          className="m-0 mt-auto flex max-h-[85vh] w-full max-w-full flex-col overflow-hidden rounded-t-xl border border-destructive/40 bg-surface p-0 text-foreground shadow-xl backdrop:bg-foreground/40 sm:m-auto sm:w-[min(40rem,calc(100vw-2rem))] sm:rounded-xl"
        >
          <header className="flex items-start gap-3 border-b border-foreground/10 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                {error.class}
                {dateTime !== "" && ` · ${dateTime}`}
              </div>
              <h2 id={titleId} className="mt-0.5 font-mono text-sm [overflow-wrap:anywhere]">
                {error.message}
              </h2>
            </div>
            <button
              type="button"
              data-testid="run-error-dialog-close"
              aria-label="Close"
              onClick={() => setOpen(false)}
              className="-mr-1 shrink-0 rounded-md px-2 py-1 font-mono text-sm text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
            >
              ✕
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
            <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-destructive">
              {error.detail ?? error.message}
            </pre>
          </div>
        </dialog>
      )}
    </>
  );
}
