import { useEffect, useReducer, useState } from "react";

/** What the renderer needs to know about a node that may be leaving. */
export type PresenceState = { mounted: boolean; open: boolean };

/**
 * A switch that is absent on first paint must not ghost in: the initial state is
 * exactly the requested presence. A present node opens in place; an absent one
 * keeps its mounted node long enough to paint the exit.
 */
export function presenceReducer(state: PresenceState, present: boolean): PresenceState {
  if (present) {
    return state.mounted && state.open ? state : { mounted: true, open: true };
  }
  if (!state.mounted || !state.open) return state;
  return { mounted: true, open: false };
}

/** Removes the node after the exit frame has painted. */
export function unmountPresence(state: PresenceState): PresenceState {
  if (!state.mounted || state.open) return state;
  return { mounted: false, open: false };
}

/** Reduced motion removes the wait entirely instead of shortening it. */
export function presenceExitMs(exitMs: number, reducedMotion: boolean): number {
  return reducedMotion ? 0 : Math.max(0, exitMs);
}

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window === "undefined" || typeof window.matchMedia !== "function"
      ? false
      : window.matchMedia(REDUCED_MOTION_QUERY).matches,
  );

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(REDUCED_MOTION_QUERY);
    const onChange = () => setReduced(media.matches);
    setReduced(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return reduced;
}

type PresenceAction = { type: "present"; present: boolean } | { type: "unmount" };

function reducePresence(state: PresenceState, action: PresenceAction): PresenceState {
  return action.type === "present"
    ? presenceReducer(state, action.present)
    : unmountPresence(state);
}

/**
 * Keeps a switching node mounted until its 160 ms exit finishes. The caller owns
 * the opacity/transform; this hook only owns identity. Under reduced motion the
 * closed node is dropped in the same render, so there is no transition to wait for.
 */
export function usePresence(present: boolean, exitMs: number): PresenceState {
  const reducedMotion = useReducedMotion();
  const [state, dispatch] = useReducer(reducePresence, {
    mounted: present,
    open: present,
  });
  const delay = presenceExitMs(exitMs, reducedMotion);
  const instantExit = delay === 0;

  useEffect(() => {
    dispatch({ type: "present", present });
  }, [present]);

  useEffect(() => {
    if (!state.mounted || state.open) return;
    if (delay === 0) {
      dispatch({ type: "unmount" });
      return;
    }
    const timer = window.setTimeout(() => dispatch({ type: "unmount" }), delay);
    return () => window.clearTimeout(timer);
  }, [state.mounted, state.open, delay]);

  // The effect above lands after paint; a zero-length exit must not paint a ghost.
  return instantExit && !present ? { mounted: false, open: false } : state;
}
