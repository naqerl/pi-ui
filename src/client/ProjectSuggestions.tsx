import { type RefObject, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { matchProjects, normalizeProject, sameProject } from "../shared/project";
import { cn } from "./lib/utils";

const MAX_SUGGESTIONS = 6;

export interface ProjectSuggestion {
  name: string;
  /** True for a name no task uses yet: accepting it starts a new project. */
  create: boolean;
}

/** Known projects matching what follows `@`, then "Create" for a new valid name. */
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

/** The `@` autocomplete: a listbox floating just above the composer row. */
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
      className="fixed z-50 -translate-y-full overflow-hidden rounded-md border border-border bg-surface p-1 text-foreground shadow-md"
      style={{ left: box.left, top: box.top, width: box.width }}
    >
      {items.map((item, index) => (
        // biome-ignore lint/a11y/useFocusableInteractive lint/a11y/useKeyWithClickEvents: focus stays in the composer; it points here with aria-activedescendant.
        <div
          key={`${item.create ? "new" : "known"}-${item.name}`}
          id={`project-suggestion-${index}`}
          role="option"
          aria-selected={index === active}
          data-testid={`project-suggestion-${item.name}`}
          className={cn(
            "flex min-h-9 cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm leading-5 [overflow-wrap:anywhere]",
            index === active && "bg-muted",
          )}
          // Keep focus (and the phone keyboard) in the composer while tapping a suggestion.
          onPointerDown={(event) => event.preventDefault()}
          onMouseDown={(event) => event.preventDefault()}
          onPointerEnter={() => onHover(index)}
          onClick={() => onAccept(item)}
        >
          {item.create ? (
            <>
              <span className="text-muted-foreground">New project</span>
              <span className="min-w-0">{item.name}</span>
            </>
          ) : (
            <span className="min-w-0">{item.name}</span>
          )}
        </div>
      ))}
    </div>,
    document.body,
  );
}
