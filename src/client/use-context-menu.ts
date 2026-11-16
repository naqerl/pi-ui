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

/** A viewport position for a portal menu, in client coordinates. */
export interface ContextMenuPoint {
  x: number;
  y: number;
}

/** The pointer and keyboard gestures a card owns for its context menu. */
export interface ContextMenuHandlers {
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
}

const LONG_PRESS_MS = 550;
const MOVE_CANCEL_PX = 10;

/**
 * One gesture set for a row's context menu: right click or Shift+F10 on a desktop,
 * and a 550 ms hold on a touch screen. Copied from the task card and stats widget
 * precedents instead of inventing a second interaction model.
 */
export function useContextMenu(): {
  point: ContextMenuPoint | null;
  open: (point: ContextMenuPoint) => void;
  close: () => void;
  handlers: ContextMenuHandlers;
} {
  const [point, setPoint] = useState<ContextMenuPoint | null>(null);
  const press = useRef<{ timer: number; x: number; y: number } | null>(null);

  const clearPress = useCallback(() => {
    if (press.current === null) return;
    window.clearTimeout(press.current.timer);
    press.current = null;
  }, []);

  const open = useCallback((next: ContextMenuPoint) => {
    setPoint(next);
  }, []);

  const close = useCallback(() => {
    clearPress();
    setPoint(null);
  }, [clearPress]);

  useEffect(
    () => () => {
      if (press.current !== null) window.clearTimeout(press.current.timer);
    },
    [],
  );

  const handlers: ContextMenuHandlers = {
    onContextMenu: (event) => {
      event.preventDefault();
      clearPress();
      open({ x: event.clientX, y: event.clientY });
    },
    onPointerDown: (event) => {
      if (event.pointerType === "mouse") return;
      clearPress();
      const x = event.clientX;
      const y = event.clientY;
      const timer = window.setTimeout(() => {
        press.current = null;
        haptic(10);
        open({ x, y });
      }, LONG_PRESS_MS);
      press.current = { timer, x, y };
    },
    onPointerMove: (event) => {
      const start = press.current;
      if (
        start !== null &&
        Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_CANCEL_PX
      ) {
        clearPress();
      }
    },
    onPointerUp: clearPress,
    onPointerCancel: clearPress,
    onKeyDown: (event) => {
      if (event.target !== event.currentTarget) return;
      if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
      event.preventDefault();
      const box = event.currentTarget.getBoundingClientRect();
      open({ x: box.left + 16, y: box.top + box.height / 2 });
    },
  };

  return { point, open, close, handlers };
}
