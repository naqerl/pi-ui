import { normalizeProject, type ProjectFilter } from "../shared/project";

const LAST_KEY = "pi-ui.tasks.last-project";
const FILTER_KEY = "pi-ui.tasks.project-filter";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private mode or a full quota: the default just falls back next time.
  }
}

/** The project the last task was added to, or null for none. */
export function readLastProject(): string | null {
  return normalizeProject(read(LAST_KEY));
}

export function writeLastProject(project: string | null) {
  write(LAST_KEY, project);
}

export function readProjectFilter(): ProjectFilter {
  const raw = read(FILTER_KEY);
  if (raw === "none") return { kind: "none" };
  const name = raw?.startsWith("project:") ? normalizeProject(raw.slice(8)) : null;
  return name === null ? { kind: "all" } : { kind: "project", name };
}

export function writeProjectFilter(filter: ProjectFilter) {
  write(
    FILTER_KEY,
    filter.kind === "all" ? null : filter.kind === "none" ? "none" : `project:${filter.name}`,
  );
}
