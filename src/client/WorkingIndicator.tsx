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
export function WorkingIndicator({
  running,
  thinking = false,
  word,
  testId = "working-indicator",
  activityTestId = "header-activity",
}: {
  running: boolean;
  thinking?: boolean;
  /** The surface's own word: the chat's run word or the tasks page's plan word. */
  word?: string;
  /** Two composers can be on screen at once, so each surface names its own node. */
  testId?: string;
  activityTestId?: string;
}) {
  return (
    <div data-testid={testId} className="flex min-w-0 items-center gap-2">
      <BrailleSpinner running={running} />
      <span data-testid={activityTestId} className="truncate">
        {word ?? workingWord(thinking)}
      </span>
    </div>
  );
}
