export interface ComposerCommandContext {
  task: { id: string; title: string } | null;
  remove: (id: string) => Promise<string | null>;
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
