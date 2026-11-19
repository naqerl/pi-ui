const NAME = "[\\p{L}\\p{N}][\\p{L}\\p{N}._-]*";
const NAME_PATTERN = new RegExp(`^${NAME}$`, "u");
const TOKEN_PATTERN = new RegExp(`(^|\\s)@(${NAME})(?=\\s|$)`, "gu");

export const PROJECT_MAX_LENGTH = 40;

export function normalizeProject(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/^@/, "");
  if (name.length === 0 || name.length > PROJECT_MAX_LENGTH) return null;
  const clean = name.replace(/[._-]+$/u, "");
  return NAME_PATTERN.test(clean) ? clean : null;
}

export function sameProject(a: string | null | undefined, b: string | null | undefined): boolean {
  return (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
}

export function parseProjectToken(
  text: string,
  known: readonly string[] = [],
): { title: string; project: string | null } {
  let project: string | null = null;
  const title = text
    .replace(TOKEN_PATTERN, (whole, lead: string, name: string) => {
      const clean = normalizeProject(name);
      if (clean === null) return whole;
      project = known.find((item) => sameProject(item, clean)) ?? clean;
      return lead;
    })
    .replace(/[ \t]{2,}/g, " ")
    .trim();
  return { title, project };
}

export function mentionAt(
  text: string,
  caret: number,
): { start: number; end: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([\p{L}\p{N}._-]*)$/u.exec(before);
  if (match === null) return null;
  const start = caret - match[2].length - 1;
  const rest = /^[\p{L}\p{N}._-]*/u.exec(text.slice(caret));
  return { start, end: caret + (rest?.[0].length ?? 0), query: match[2] };
}

export function acceptMention(
  text: string,
  mention: { start: number; end: number },
  name: string,
): { text: string; caret: number } {
  const after = text.slice(mention.end).replace(/^ /, "");
  const inserted = `@${name} `;
  return {
    text: text.slice(0, mention.start) + inserted + after,
    caret: mention.start + inserted.length,
  };
}

export function matchProjects(projects: readonly string[], query: string): string[] {
  const q = query.toLowerCase();
  const sorted = [...projects].sort((a, b) => a.localeCompare(b));
  const prefix = sorted.filter((name) => name.toLowerCase().startsWith(q));
  const inner = sorted.filter(
    (name) => !name.toLowerCase().startsWith(q) && name.toLowerCase().includes(q),
  );
  return [...prefix, ...inner];
}

export function projectsOf(tasks: readonly { project?: string }[]): string[] {
  const seen = new Map<string, string>();
  for (const task of tasks) {
    if (task.project === undefined) continue;
    const key = task.project.toLowerCase();
    if (!seen.has(key)) seen.set(key, task.project);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}
