import { useEffect, useState } from "react";
import { workingWord } from "./working-state";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;
/**
 * A silent run is still a live run. Staleness is the server watchdog's call, so the dock
 * slows the wheel to a quarter speed (operator's decision of 2026-11-21) instead of
 * stopping it: the animation is the one statement that work continues.
 */
const QUIET_FRAME_MS = 320;

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

function BrailleSpinner({ running, quiet }: { running: boolean; quiet: boolean }) {
  const reducedMotion = useReducedMotion();
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!running || reducedMotion) return;
    const timer = window.setInterval(
      () => {
        setFrame((current) => (current + 1) % FRAMES.length);
      },
      quiet ? QUIET_FRAME_MS : FRAME_MS,
    );
    return () => window.clearInterval(timer);
  }, [reducedMotion, running, quiet]);

  // `reduced` is the reader's preference, `quiet` a silent live run, and `frame` a live run
  // with fresh output. An unchanging `data-frame` in either live mode means nothing is live.
  const motion = reducedMotion ? "reduced" : running && quiet ? "quiet" : "frame";
  return (
    <span
      aria-hidden="true"
      data-testid="working-spinner"
      data-motion={motion}
      data-frame={frame}
      className="inline-block w-[1ch] shrink-0 text-center"
    >
      {reducedMotion ? "⠿" : FRAMES[frame]}
    </span>
  );
}

/**
 * The run's one word and a braille spinner. Shown above the composer while a run is active.
 * The wheel never stops while the run is live: it slows to a quarter speed once the run goes
 * quiet. The strip deliberately carries no elapsed time or quiet counter: neither is
 * actionable, and a per-second clock made the composer dock re-render forever for no benefit.
 */
export function WorkingIndicator({
  running,
  quiet = false,
  thinking = false,
  word,
  testId = "working-indicator",
  activityTestId = "header-activity",
}: {
  running: boolean;
  /** The live run has sent no frame within the retry budget: slow the wheel, do not stop it. */
  quiet?: boolean;
  thinking?: boolean;
  /** The surface's own word: the chat's run word or the tasks page's plan word. */
  word?: string;
  /** Two composers can be on screen at once, so each surface names its own node. */
  testId?: string;
  activityTestId?: string;
}) {
  return (
    <div data-testid={testId} className="flex min-w-0 items-center gap-lg">
      <BrailleSpinner running={running} quiet={quiet} />
      <span data-testid={activityTestId} className="truncate">
        {word ?? workingWord(thinking)}
      </span>
    </div>
  );
}
