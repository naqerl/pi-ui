import { useEffect, useState } from "react";
import { workingDetails } from "../shared/run-health";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return reduced;
}

function BrailleSpinner({ running }: { running: boolean }) {
  const reducedMotion = useReducedMotion();
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!running || reducedMotion) return;
    const timer = window.setInterval(() => {
      setFrame((current) => (current + 1) % FRAMES.length);
    }, FRAME_MS);
    return () => window.clearInterval(timer);
  }, [reducedMotion, running]);

  return (
    <span aria-hidden="true" className="inline-block w-[1ch] shrink-0 text-center">
      {!running || reducedMotion ? "⠿" : FRAMES[frame]}
    </span>
  );
}

export interface RunClock {
  startedAt: string | null;
  lastEventAt: string | null;
  quietAfterMs?: number;
}

/** Ticks once a second while `running`, so the elapsed time moves. */
function useNow(running: boolean): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  return now;
}

/**
 * The word working, a braille spinner, how long the run has gone, and how long the agent has
 * been quiet once that is long enough to matter. Shown above the composer while a run is active.
 */
export function WorkingIndicator({ running, clock }: { running: boolean; clock?: RunClock }) {
  const now = useNow(running);
  const details =
    running && clock !== undefined
      ? workingDetails(clock.startedAt, clock.lastEventAt, now, clock.quietAfterMs)
      : [];
  return (
    <div className="flex min-w-0 items-center gap-2">
      <BrailleSpinner running={running} />
      <span data-testid="header-activity" className="truncate">
        working
        {details.map((part) => (
          <span key={part} data-testid="working-detail" className="whitespace-nowrap">
            {" · "}
            {part}
          </span>
        ))}
      </span>
    </div>
  );
}
