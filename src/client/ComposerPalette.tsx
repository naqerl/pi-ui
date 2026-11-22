import { Fragment, forwardRef } from "react";
import type { ComposerCommandMatch } from "./composer-commands";
import { cn } from "./lib/utils";

export interface ComposerPaletteProps {
  value: string;
  matches: readonly ComposerCommandMatch[];
  active: number;
}

export const ComposerPalette = forwardRef<HTMLDivElement, ComposerPaletteProps>(
  function ComposerPalette({ value, matches, active }, ref) {
    const selected: ComposerCommandMatch | undefined = matches[active];
    let selection = "";
    if (selected !== undefined) {
      const detail = selected.command.unavailable ?? selected.command.summary;
      selection = `/${selected.command.name} — ${detail}`;
    }
    return (
      <>
        <div
          ref={ref}
          aria-hidden="true"
          data-testid="composer-palette"
          className="pointer-events-none absolute inset-0 overflow-hidden px-xl py-lg text-sm leading-5 whitespace-pre-wrap text-muted-foreground"
        >
          <span className="opacity-0">{value}</span>
          {matches.map((match, index) => {
            const available = match.command.unavailable === null;
            const isSelected = index === active;
            const detail = match.command.unavailable ?? match.command.summary;
            let detailText = "";
            if (!available) detailText = ` — ${detail}`;
            else if (isSelected) detailText = ` ${detail}`;
            return (
              <Fragment key={match.command.name}>
                {index > 0 ? "  " : null}
                <span
                  data-testid={`composer-command-${match.command.name}`}
                  data-command={match.command.name}
                  data-active={isSelected ? "true" : undefined}
                  data-available={available ? "true" : "false"}
                  className={cn(
                    available && isSelected && "rounded-sm bg-accent/10 text-accent",
                    (!available || !isSelected) && "text-muted-foreground",
                  )}
                >
                  {index === 0 ? match.suffix : `/${match.command.name}`}
                </span>
                <span className="text-muted-foreground">{detailText}</span>
              </Fragment>
            );
          })}
        </div>
        <span role="status" data-testid="composer-palette-status" className="sr-only">
          {selection}
        </span>
      </>
    );
  },
);
