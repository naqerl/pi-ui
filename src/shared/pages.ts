/**
 * The page routes the client owns. The server serves the app shell for these
 * paths so a push, bookmark or deep link boots the SPA instead of a 404.
 */
export const PAGE_PATHS = {
  stats: "/stats",
  chat: "/chat",
  tasks: "/tasks",
} as const;

export type PageId = keyof typeof PAGE_PATHS;

/** Pager order, left to right. */
export const PAGE_IDS = ["stats", "chat", "tasks"] as const satisfies readonly PageId[];

/** The page a document pathname belongs to, ignoring a trailing slash. */
export function pageIdFromPath(pathname: string): PageId | undefined {
  const path = pathname.replace(/\/+$/, "") || "/";
  return PAGE_IDS.find((id) => PAGE_PATHS[id] === path);
}

/** The task detail view a push or a bookmark may point at. */
export interface TaskDeepLink {
  readonly id: string;
  /** `plan` is the planning chat; `chat` is kept as an alias for the same pane. */
  readonly tab: "plan" | "chat" | null;
}

/** The canonical task-plan route: the task's planning chat is the target. */
export function taskPlanUrl(id: string): string {
  return `/#/tasks/${encodeURIComponent(id)}?tab=plan`;
}

/** A path-based alias the server also serves, for clients without hash routing. */
export function taskPlanPath(id: string): string {
  return `${PAGE_PATHS.tasks}/${encodeURIComponent(id)}?tab=plan`;
}

function decodeSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function taskLinkFrom(pathname: string, search: URLSearchParams): TaskDeepLink | null {
  const match = /^\/tasks\/([^/]+)\/?$/.exec(pathname);
  const id = match?.[1] === undefined ? null : decodeSegment(match[1]);
  if (id === null || id.length === 0) return null;
  const tab = search.get("tab");
  return { id, tab: tab === "plan" || tab === "chat" ? tab : null };
}

/**
 * Reads the task and tab a location selects. Both the hash route used by push
 * payloads and the path alias are accepted, so old and new links open the same
 * task chat.
 */
export function taskDeepLinkFromLocation(
  href: string,
  base = "http://pi.local",
): TaskDeepLink | null {
  const url = new URL(href, base);
  const hash = url.hash.startsWith("#/") ? url.hash.slice(1) : "";
  if (hash.length > 0) {
    const question = hash.indexOf("?");
    const pathname = question < 0 ? hash : hash.slice(0, question);
    const search = new URLSearchParams(question < 0 ? "" : hash.slice(question + 1));
    const linked = taskLinkFrom(pathname, search);
    if (linked !== null) return linked;
  }
  const linked = taskLinkFrom(url.pathname, url.searchParams);
  if (linked !== null) return linked;
  const id = url.searchParams.get("task");
  if (id === null || id.length === 0) return null;
  const tab = url.searchParams.get("tab");
  return { id, tab: tab === "plan" || tab === "chat" ? tab : null };
}
