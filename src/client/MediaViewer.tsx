import { useEffect, useId, useRef } from "react";
import { CloseIcon } from "./icons";
import { mediaUrl } from "./media-client";

/**
 * The full-screen image surface. It is a native modal dialog, so focus stays on
 * the image, Escape closes it and the task behind it keeps its scroll position.
 */
export function MediaViewer({
  id,
  alt,
  onClose,
}: {
  id: string;
  alt: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    const bodyOverflow = document.body.style.overflow;
    const htmlOverflow = document.documentElement.style.overflow;
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
      ref={dialogRef}
      data-testid="media-viewer"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className="m-0 h-dvh max-h-dvh w-screen max-w-screen overflow-hidden bg-black/85 p-0 text-white backdrop:bg-black/60"
    >
      <div className="relative flex h-full min-h-0 items-center justify-center p-3 sm:p-6">
        <h2 id={titleId} className="sr-only">
          {alt}
        </h2>
        <img
          src={mediaUrl(id)}
          alt={alt}
          draggable={false}
          className="block max-h-full max-w-full object-contain"
        />
        <button
          type="button"
          data-testid="media-viewer-close"
          aria-label="Close image"
          onClick={onClose}
          className="absolute top-3 right-3 grid size-11 place-items-center rounded-full bg-surface text-foreground shadow-md"
        >
          <CloseIcon size={18} />
        </button>
      </div>
    </dialog>
  );
}
