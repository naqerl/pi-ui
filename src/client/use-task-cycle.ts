import { useCallback, useEffect, useRef } from "react";
import type { Task } from "../shared/types";
import { recentTaskOrder } from "./recent-tasks";

/** A gap this long starts a new cycle burst instead of continuing the snapshot. */
export const CYCLE_BURST_MS = 1500;

/** Where the ring landed, for the HUD. `position` is one-based. */
export interface TaskCycleHint {
  position: number;
  total: number;
  task: Task;
}

interface TaskCycleOptions {
  tasks: Task[];
  /** The task the operator is looking at, or null when none is open. */
  currentId: string | null;
  onOpen: (id: string) => void;
  onHint: (hint: TaskCycleHint) => void;
}

interface CycleBurst {
  order: string[];
  index: number;
  at: number;
}

/** Ctrl+Tab / Ctrl+Shift+Tab move through the recent ring, with Ctrl+I / Ctrl+O aliases. */
function cycleStep(event: KeyboardEvent): 1 | -1 | null {
  if (event.key === "Tab") return event.shiftKey ? -1 : 1;
  // Ctrl+Shift+I and Ctrl+Shift+O belong to the browser, not the ring.
  if (event.shiftKey) return null;
  const key = event.key.toLowerCase();
  if (event.code === "KeyI" || key === "i") return 1;
  if (event.code === "KeyO" || key === "o") return -1;
  return null;
}

/**
 * The editor-style recent-task switcher. Every press commits at once; the burst snapshot
 * keeps opening the next ring entry from reordering the ring under the operator's fingers.
 * Returns a reset for an open the operator made by hand.
 */
export function useTaskCycle({ tasks, currentId, onOpen, onHint }: TaskCycleOptions): () => void {
  const burst = useRef<CycleBurst | null>(null);

  const reset = useCallback(() => {
    burst.current = null;
  }, []);

  useEffect(() => {
    const onManualOpen = (event: Event) => {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("[data-task-card], [data-task-chip], [data-task-open]") !== null
      ) {
        burst.current = null;
      }
    };

    const onKey = (event: KeyboardEvent) => {
      // IME candidate keys are text, not shortcuts.
      if (event.isComposing) return;
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      const step = cycleStep(event);
      if (step === null) return;
      // A dialog owns the keyboard while it is open, including its own text fields.
      const active = document.activeElement;
      if (active instanceof Element && active.closest('[role="dialog"]') !== null) return;

      const now = Date.now();
      const previous = burst.current;
      let order: string[];
      let index: number;
      let opened: string | null;
      // Reading the ring again after an open would bounce between two tasks, so a burst
      // keeps its own order and index until a gap or a hand-picked task clears it. The task
      // already open is the one the burst last landed on, not a prop that may still describe
      // the render before this keypress.
      if (previous === null || now - previous.at > CYCLE_BURST_MS) {
        order = recentTaskOrder(tasks);
        index = currentId === null ? -1 : order.indexOf(currentId);
        opened = currentId;
      } else {
        order = previous.order;
        index = previous.index;
        opened = order[previous.index] ?? currentId;
      }
      if (order.length < 2) {
        burst.current = null;
        return;
      }
      index = (index + step + order.length) % order.length;
      const target = order[index];
      const task = target === undefined ? undefined : tasks.find((item) => item.id === target);
      if (target === undefined || task === undefined) {
        burst.current = null;
        return;
      }
      // A ring of one and the wrap back to the open task stay the browser's keys.
      if (target === opened) return;

      // Claim the key only now; every earlier return leaves the browser's Ctrl+Tab alone.
      event.preventDefault();
      burst.current = { order, index, at: now };
      onOpen(target);
      onHint({ position: index + 1, total: order.length, task });
    };

    window.addEventListener("pointerdown", onManualOpen, true);
    window.addEventListener("click", onManualOpen, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onManualOpen, true);
      window.removeEventListener("click", onManualOpen, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [currentId, onHint, onOpen, tasks]);

  return reset;
}
