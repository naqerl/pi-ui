import { useEffect, useState } from "react";
import { workingWord } from "./working-state";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_MS = 80;
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

export function WorkingIndicator({
  running,
  quiet = false,
  thinking = false,
  word,
  testId = "working-indicator",
  activityTestId = "header-activity",
}: {
  running: boolean;
  quiet?: boolean;
  thinking?: boolean;
  word?: string;
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
