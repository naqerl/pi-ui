import { useCallback, useEffect, useRef } from "react";
import type { Task } from "../shared/types";
import { recentTaskOrder } from "./recent-tasks";

export const CYCLE_BURST_MS = 1500;

export interface TaskCycleHint {
  position: number;
  total: number;
  task: Task;
}

interface TaskCycleOptions {
  tasks: Task[];
  currentId: string | null;
  onOpen: (id: string) => void;
  onHint: (hint: TaskCycleHint) => void;
}

interface CycleBurst {
  order: string[];
  index: number;
  at: number;
}

function cycleStep(event: KeyboardEvent): 1 | -1 | null {
  if (event.key === "Tab") return event.shiftKey ? -1 : 1;
  if (event.shiftKey) return null;
  const key = event.key.toLowerCase();
  if (event.code === "KeyI" || key === "i") return 1;
  if (event.code === "KeyO" || key === "o") return -1;
  return null;
}

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
      if (event.isComposing) return;
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      const step = cycleStep(event);
      if (step === null) return;
      const active = document.activeElement;
      if (active instanceof Element && active.closest('[role="dialog"]') !== null) return;

      const now = Date.now();
      const previous = burst.current;
      let order: string[];
      let index: number;
      let opened: string | null;
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
      if (target === opened) return;

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
