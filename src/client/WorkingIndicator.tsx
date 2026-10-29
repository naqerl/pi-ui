import { useEffect, useState } from "react";
import { formatElapsed } from "./activity-format";

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

interface WorkingIndicatorProps {
  running: boolean;
  startedAt: string | null;
}

/** Braille spinner and elapsed time. Rendered under the header controls while a run is active. */
export function WorkingIndicator({ running, startedAt }: WorkingIndicatorProps) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [running]);

  if (!running) return null;

  const parsedStart = startedAt === null ? Number.NaN : Date.parse(startedAt);
  const elapsed = Number.isFinite(parsedStart) ? Math.max(0, now - parsedStart) : 0;

  return (
    <div className="flex shrink-0 items-center gap-2">
      <BrailleSpinner running={running} />
      <span className="shrink-0 tabular-nums">{formatElapsed(elapsed)}</span>
    </div>
  );
}
