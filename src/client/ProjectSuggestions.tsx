import { type RefObject, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { matchProjects, normalizeProject, sameProject } from "../shared/project";
import { cn } from "./lib/utils";

const MAX_SUGGESTIONS = 6;

export interface ProjectSuggestion {
  name: string;
  create: boolean;
}

export function projectSuggestions(
  projects: readonly string[],
  query: string,
): ProjectSuggestion[] {
  const items: ProjectSuggestion[] = matchProjects(projects, query)
    .slice(0, MAX_SUGGESTIONS)
    .map((name) => ({ name, create: false }));
  const typed = normalizeProject(query);
  if (typed !== null && !projects.some((name) => sameProject(name, typed))) {
    items.push({ name: typed, create: true });
  }
  return items;
}

export function ProjectSuggestions({
  anchor,
  items,
  active,
  onHover,
  onAccept,
}: {
  anchor: RefObject<HTMLElement | null>;
  items: ProjectSuggestion[];
  active: number;
  onHover: (index: number) => void;
  onAccept: (item: ProjectSuggestion) => void;
}) {
  const [box, setBox] = useState<{ left: number; top: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const element = anchor.current;
      if (element === null) return;
      const rect = element.getBoundingClientRect();
      const width = Math.min(rect.width - 12, 320);
      setBox({ left: rect.left + 6, top: rect.top - 4, width });
    };
    measure();
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [anchor]);

  if (box === null) return null;
  return createPortal(
    <div
      id="project-suggestions"
      role="listbox"
      aria-label="Projects"
      data-testid="project-suggestions"
      className="fixed z-50 -translate-y-full overflow-hidden rounded-md border border-border bg-surface p-sm text-foreground shadow-md"
      style={{ left: box.left, top: box.top, width: box.width }}
    >
      {items.map((item, index) => (
        <button
          key={`${item.create ? "new" : "known"}-${item.name}`}
          type="button"
          id={`project-suggestion-${index}`}
          role="option"
          tabIndex={index === active ? 0 : -1}
          aria-selected={index === active}
          data-testid={`project-suggestion-${item.name}`}
          className={cn(
            "flex min-h-9 w-full cursor-pointer items-center gap-lg rounded-sm px-lg py-md text-left text-sm leading-5 [overflow-wrap:anywhere]",
            index === active && "bg-muted",
          )}
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          onPointerEnter={() => onHover(index)}
          onFocus={() => onHover(index)}
          onClick={() => onAccept(item)}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            const next =
              (index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
            onHover(next);
            document.getElementById(`project-suggestion-${next}`)?.focus();
          }}
        >
          {item.create ? (
            <>
              <span className="text-muted-foreground">New project</span>
              <span className="min-w-0">{item.name}</span>
            </>
          ) : (
            <span className="min-w-0">{item.name}</span>
          )}
        </button>
      ))}
    </div>,
    document.body,
  );
}
