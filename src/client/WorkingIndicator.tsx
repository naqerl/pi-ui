import { useEffect, useState } from "react";
import { workingWord } from "./working-state";

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

/**
 * The run's one word and a braille spinner. Shown above the composer while a run is active.
 * The strip deliberately carries no elapsed time or quiet counter: neither is actionable, and
 * a per-second clock made the composer dock re-render forever for no benefit.
 */
export function WorkingIndicator({ running, thinking }: { running: boolean; thinking: boolean }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <BrailleSpinner running={running} />
      <span data-testid="header-activity" className="truncate">
        {workingWord(thinking)}
      </span>
    </div>
  );
}
