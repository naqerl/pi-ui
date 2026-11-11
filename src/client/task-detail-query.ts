import { useEffect, useState } from "react";

/** 0 means the post-composer-restore layout; 1–5 are design proposals. */
export function readTaskDetailVariant(): number {
  if (typeof window === "undefined") return 0;
  const value = Number(new URLSearchParams(window.location.search).get("variant"));
  return Number.isInteger(value) && value >= 1 && value <= 5 ? value : 0;
}

export function readTaskDetailFixture(): boolean {
  return (
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("fixture") === "1"
  );
}

export function useTaskDetailVariant(): number {
  const [variant, setVariant] = useState(readTaskDetailVariant);
  useEffect(() => {
    const sync = () => setVariant(readTaskDetailVariant());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  return variant;
}

export function useTaskDetailFixture(): boolean {
  const [on, setOn] = useState(readTaskDetailFixture);
  useEffect(() => {
    const sync = () => setOn(readTaskDetailFixture());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  return on;
}

/** 1–5 are mobile title-card proposals; 0 falls back to the default pick. */
export const DEFAULT_TITLE_CARD = 2;

export function readTitleCardVariant(): number {
  if (typeof window === "undefined") return DEFAULT_TITLE_CARD;
  const value = Number(new URLSearchParams(window.location.search).get("titlecard"));
  return Number.isInteger(value) && value >= 1 && value <= 5 ? value : DEFAULT_TITLE_CARD;
}

export function useTitleCardVariant(): number {
  const [variant, setVariant] = useState(readTitleCardVariant);
  useEffect(() => {
    const sync = () => setVariant(readTitleCardVariant());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);
  return variant;
}
