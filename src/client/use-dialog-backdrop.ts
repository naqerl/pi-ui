import { type RefObject, useEffect } from "react";

export function useDialogBackdrop(
  ref: RefObject<HTMLDialogElement | null>,
  onClose: () => void,
): void {
  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    const close = (event: MouseEvent) => {
      if (event.target === dialog) onClose();
    };
    dialog.addEventListener("click", close);
    return () => dialog.removeEventListener("click", close);
  }, [ref, onClose]);
}
