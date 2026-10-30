import type { DashboardState } from "../shared/dashboard";

// The latest dashboard frame. use-chat writes it from the event stream; the
// dashboard page reads it with useSyncExternalStore.
let current: DashboardState | null = null;
const listeners = new Set<() => void>();

export function setDashboard(state: DashboardState): void {
  current = state;
  for (const listener of listeners) listener();
}

export function getDashboard(): DashboardState | null {
  return current;
}

export function subscribeDashboard(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
