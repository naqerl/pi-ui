/**
 * Ordered scope rules for memory topics. The first matching rule wins; a section
 * that matches none belongs to `misc`. Keep the patterns structural rather than
 * tied to one operator's project names, so an invented fixture routes predictably.
 */
export const SCOPE_RULES: ReadonlyArray<readonly [scope: string, pattern: RegExp]> = [
  ["core", /^(Standing rules|Who the user is|Operating role|Rules that always apply)\b/i],
  ["harness", /^(Pi|Skills|Harness)\b|\bpi MCP\b|\bqmd\b|skill discovery/i],
  [
    "forge",
    /Git forge|Gitea|GitHub|Forgejo|\bgh (CLI|pr)\b|Authorship|^Never merge|stacked PR|delivery lane/i,
  ],
  ["machines", /^(Machine:|Where the code lives)(?=[\s:—]|$)/i],
  ["prefs", /^Contact note|preference|^Working style|End-of-turn|tmux status bar/i],
  ["projects", /^Project[: ]|^[A-Z][\w .-]*\b(service|app|project)\b/i],
];

export const SCOPE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  core: "who the user is, how to work",
  projects: "project knowledge",
  machines: "operator infrastructure",
  forge: "delivery lanes",
  harness: "agent harness",
  prefs: "operator preferences",
  misc: "unclassified",
};

export function scopeOf(title: string): string {
  for (const [scope, pattern] of SCOPE_RULES) {
    if (pattern.test(title)) return scope;
  }
  return "misc";
}

export function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/`/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 58) || "topic"
  );
}

export function describeScope(scope: string): string {
  return SCOPE_DESCRIPTIONS[scope] ?? "topics";
}
