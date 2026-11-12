import { useEffect, useState } from "react";

export function readTaskDetailFixture(): boolean {
  return (
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).get("fixture") === "1"
  );
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
