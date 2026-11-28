import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { haptic } from "./haptics";

/** The hold that opens a message menu; the task card uses the same two numbers. */
export const MESSAGE_LONG_PRESS_MS = 500;
/** Movement past this many pixels is a scroll or drag, not a hold. */
export const MESSAGE_LONG_PRESS_SLOP = 10;

const IGNORE_GESTURE =
  'a, button, input, textarea, select, [contenteditable="true"], [data-task-chip], [data-testid="task-chip-preview"]';

export interface MessageMenuPoint {
  x: number;
  y: number;
}

export interface MessageContextMenu {
  menu: MessageMenuPoint | null;
  /** The pointer is down and its hold timer may still open the menu. */
  armed: boolean;
  close: () => void;
  handlers: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
    onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
    onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  };
}

function ignoredTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(IGNORE_GESTURE) !== null;
}

/**
 * The one message gesture: hold for 500 ms, right-click, or ContextMenu/Shift+F10 on a
 * focused row. A scroll's pointercancel disarms the hold instead of leaving it behind.
 */
export function useMessageContextMenu(): MessageContextMenu {
  const [menu, setMenu] = useState<MessageMenuPoint | null>(null);
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | null>(null);
  const origin = useRef({ x: 0, y: 0 });

  const clearHold = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setArmed(false);
  }, []);

  const openMenu = useCallback(
    (x: number, y: number) => {
      clearHold();
      haptic();
      setMenu({ x, y });
    },
    [clearHold],
  );

  const close = useCallback(() => setMenu(null), []);

  useEffect(() => {
    return () => {
      if (timer.current === null) return;
      window.clearTimeout(timer.current);
      timer.current = null;
    };
  }, []);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button > 0 || ignoredTarget(event.target)) return;
      clearHold();
      origin.current = { x: event.clientX, y: event.clientY };
      if (event.pointerType === "mouse") return;
      setArmed(true);
      timer.current = window.setTimeout(() => {
        timer.current = null;
        openMenu(origin.current.x, origin.current.y);
      }, MESSAGE_LONG_PRESS_MS);
    },
    [clearHold, openMenu],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (timer.current === null) return;
      const distance = Math.hypot(
        event.clientX - origin.current.x,
        event.clientY - origin.current.y,
      );
      if (distance <= MESSAGE_LONG_PRESS_SLOP) return;
      clearHold();
    },
    [clearHold],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (timer.current !== null) event.preventDefault();
      clearHold();
    },
    [clearHold],
  );

  const onContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      if (ignoredTarget(event.target)) return;
      event.preventDefault();
      openMenu(event.clientX, event.clientY);
    },
    [openMenu],
  );

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      const box = event.currentTarget.getBoundingClientRect();
      openMenu(box.left + 16, box.top + box.height / 2);
    },
    [openMenu],
  );

  return {
    menu,
    armed,
    close,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: clearHold,
      onContextMenu,
      onKeyDown,
    },
  };
}
