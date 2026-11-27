import { useEffect, useReducer, useRef } from "react";

export const DOCK_SCAN_STAGGER_MS = 12;
export const DOCK_SCAN_OUT_MS = 90;
export const DOCK_SCAN_IN_MS = 110;
export const DOCK_SCAN_SWAP_MS = DOCK_SCAN_OUT_MS + DOCK_SCAN_STAGGER_MS * 3;
export const DOCK_SCAN_ENTER_MS = DOCK_SCAN_IN_MS + DOCK_SCAN_STAGGER_MS * 3;

export type DockView = {
  surface: string;
  plan: boolean;
  word: string | null;
  running: boolean;
  quiet: boolean;
  jobs: boolean;
  hidden: boolean;
};

export type DockPhase = "settled" | "exit" | "enter";

export type DockScanState = {
  view: DockView;
  phase: DockPhase;
  revision: number;
};

export type DockScan = Pick<DockScanState, "view" | "phase">;

export type DockScanAction =
  | { type: "exit"; view: DockView }
  | { type: "swap"; view: DockView }
  | { type: "settle" }
  | { type: "snap"; view: DockView };

export function dockScanKey(view: DockView): string {
  return `${view.surface}:${view.hidden ? "hidden" : "shown"}`;
}

export function dockViewsEqual(a: DockView, b: DockView): boolean {
  return (
    a.surface === b.surface &&
    a.plan === b.plan &&
    a.word === b.word &&
    a.running === b.running &&
    a.quiet === b.quiet &&
    a.jobs === b.jobs &&
    a.hidden === b.hidden
  );
}

function transition(state: DockScanState, view: DockView, phase: DockPhase): DockScanState {
  return { view, phase, revision: state.revision + 1 };
}

export function dockScanReducer(state: DockScanState, action: DockScanAction): DockScanState {
  switch (action.type) {
    case "exit":
      return state.phase === "exit" ? state : transition(state, action.view, "exit");
    case "swap":
      return dockViewsEqual(state.view, action.view)
        ? transition(state, state.view, "settled")
        : transition(state, action.view, "enter");
    case "settle":
      return state.phase === "settled" ? state : transition(state, state.view, "settled");
    case "snap":
      return state.phase === "settled" && dockViewsEqual(state.view, action.view)
        ? state
        : transition(state, action.view, "settled");
  }
}

export function useDockScan(view: DockView, enabled: boolean): DockScan {
  const [state, dispatch] = useReducer(dockScanReducer, view, (initial) => ({
    view: initial,
    phase: "settled" as DockPhase,
    revision: 0,
  }));
  const shown = useRef(view);
  const pending = useRef(view);
  const key = dockScanKey(view);

  useEffect(() => {
    if (!enabled) return;
    if (state.phase === "exit") {
      const timer = window.setTimeout(() => {
        dispatch({ type: "swap", view: pending.current });
      }, DOCK_SCAN_SWAP_MS);
      return () => window.clearTimeout(timer);
    }
    if (state.phase === "enter") {
      const timer = window.setTimeout(() => {
        dispatch({ type: "settle" });
      }, DOCK_SCAN_ENTER_MS);
      return () => window.clearTimeout(timer);
    }
  }, [enabled, state]);

  if (!enabled) {
    shown.current = view;
    pending.current = view;
    if (state.phase !== "settled") {
      dispatch({ type: "snap", view });
      return { view, phase: "settled" };
    }
    return { view, phase: "settled" };
  }

  if (state.phase === "settled") {
    const frozen = shown.current;
    if (dockScanKey(frozen) !== key) {
      pending.current = view;
      dispatch({ type: "exit", view: frozen });
      return { view: frozen, phase: "exit" };
    }
    shown.current = view;
    pending.current = view;
    return { view, phase: "settled" };
  }

  shown.current = state.view;

  if (state.phase === "enter" && dockScanKey(shown.current) !== key) {
    pending.current = view;
    dispatch({ type: "exit", view: shown.current });
    return { view: shown.current, phase: "exit" };
  }

  if (state.phase === "exit") pending.current = view;
  return state;
}
