export interface ComposerCommandContext {
  /** The task this composer speaks for; null off the tasks page or with no detail open. */
  task: { id: string; title: string } | null;
  /** `useWide()` for the caller: the desktop-only commands read it, not the window. */
  desktop: boolean;
  /** The tasks page is showing the body at full width. */
  fullscreen: boolean;
  remove: (id: string) => Promise<string | null>;
  toggleFullscreen: () => void;
}

export interface ComposerCommand {
  name: string;
  summary: string;
  unavailable: string | null;
  run: () => Promise<string | null>;
}

export interface ComposerCommandMatch {
  command: ComposerCommand;
  suffix: string;
}

export interface ComposerCommandMatches {
  matches: ComposerCommandMatch[];
  index: number;
}

export function composerCommands(context: ComposerCommandContext): ComposerCommand[] {
  const unavailable = !context.desktop
    ? "desktop only"
    : context.task === null
      ? "no task open"
      : null;
  return [
    {
      name: "remove",
      summary: "delete the open task",
      unavailable: context.task === null ? "no task open" : null,
      run: async () => {
        if (context.task === null) return null;
        return context.remove(context.task.id);
      },
    },
    {
      name: "fullscreen",
      summary: context.fullscreen
        ? "show the list and chat again"
        : "read the task body at full width",
      unavailable,
      run: async () => {
        if (unavailable !== null) return null;
        context.toggleFullscreen();
        return null;
      },
    },
  ];
}

export function commandQuery(value: string): string | null {
  const match = /^\/(\S*)$/.exec(value);
  return match === null || match[0] !== value ? null : (match[1] ?? "");
}

export function matchCommands(
  commands: readonly ComposerCommand[],
  query: string,
): ComposerCommandMatches {
  const wanted = query.toLowerCase();
  const matches = commands
    .filter((command) => command.name.toLowerCase().startsWith(wanted))
    .map((command) => ({ command, suffix: command.name.slice(query.length) }));
  const available = matches.findIndex((match) => match.command.unavailable === null);
  return {
    matches,
    index: available >= 0 ? available : matches.length > 0 ? 0 : -1,
  };
}
