import { useEffect, useState } from "react";
import type { ActivityItem } from "../shared/types";
import { activityLabel, formatElapsed } from "./activity-format";

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

interface WorkingIndicatorProps {
  running: boolean;
  startedAt: string | null;
  activity: ActivityItem | undefined;
}

export function WorkingIndicator({ running, startedAt, activity }: WorkingIndicatorProps) {
  const reducedMotion = useReducedMotion();
  const [frame, setFrame] = useState(0);
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    if (!running || reducedMotion) {
      setFrame(0);
      return;
    }
    let animation = 0;
    let last = performance.now();
    const tick = (time: number) => {
      if (time - last >= FRAME_MS) {
        last = time - ((time - last) % FRAME_MS);
        setFrame((current) => (current + 1) % FRAMES.length);
      }
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [running, reducedMotion]);

  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [running]);

  if (!running) return null;

  const parsedStart = startedAt === null ? Number.NaN : Date.parse(startedAt);
  const elapsed = Number.isFinite(parsedStart) ? Math.max(0, now - parsedStart) : 0;
  const label = activity === undefined ? "thinking" : activityLabel(activity);

  return (
    <div className="mx-auto flex h-full w-full max-w-[72ch] items-center gap-2 px-4 font-mono text-xs text-muted-foreground">
      <span aria-hidden="true" className="inline-block w-[1ch] shrink-0 text-center">
        {reducedMotion ? "⠿" : FRAMES[frame]}
      </span>
      <span className="shrink-0 tabular-nums">{formatElapsed(elapsed)}</span>
      <span className="min-w-0 truncate" title={label}>
        {label}
      </span>
    </div>
  );
}
