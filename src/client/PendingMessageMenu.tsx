import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "./lib/utils";
import type { ContextMenuPoint } from "./use-context-menu";

/** The delete gesture for one pending bubble, rendered at the pointer or long-press point. */
export function PendingMessageMenu({
  point,
  steerId,
  queueId,
  queueIds,
  onDeleteSteer,
  onCancelQueued,
  onClose,
}: {
  point: ContextMenuPoint;
  steerId?: string;
  queueId?: string;
  /** Every submission a grouped queued chip removes with one delete. */
  queueIds?: string[];
  onDeleteSteer?: (steerId: string) => Promise<boolean>;
  onCancelQueued?: (queueId: string) => unknown;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const width = 208;
  const height = 44;
  const left = Math.max(8, Math.min(point.x, window.innerWidth - width - 8));
  const below = point.y + height + 8 <= window.innerHeight;
  const top = below ? point.y : Math.max(8, point.y - height - 8);
  const item =
    "flex min-h-9 w-full items-center rounded-sm px-3 text-left text-sm leading-5 hover:bg-muted";
  const queuedIds = queueIds ?? (queueId === undefined ? [] : [queueId]);

  useEffect(() => {
    const dismiss = (event: Event) => {
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        event.preventDefault();
        onClose();
        return;
      }
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss, true);
      document.removeEventListener("keydown", dismiss);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      data-testid="pending-message-menu"
      role="menu"
      className={cn(
        "fixed z-40 w-52 rounded-md border border-border bg-surface p-1 text-foreground shadow-md",
      )}
      style={{ left, top }}
    >
      {steerId !== undefined && onDeleteSteer !== undefined && (
        <button
          type="button"
          role="menuitem"
          data-testid="pending-menu-delete-steer"
          className={item}
          onClick={() => {
            onClose();
            void onDeleteSteer(steerId);
          }}
        >
          Delete steer
        </button>
      )}
      {queuedIds.length > 0 && onCancelQueued !== undefined && (
        <button
          type="button"
          role="menuitem"
          data-testid="pending-menu-delete-queue"
          className={item}
          onClick={() => {
            onClose();
            for (const id of queuedIds) void onCancelQueued(id);
          }}
        >
          Delete queued message
        </button>
      )}
    </div>,
    document.body,
  );
}
