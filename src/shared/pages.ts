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
