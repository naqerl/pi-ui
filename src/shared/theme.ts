import type { ThemeColors, ThemePalette } from "./types.js";

export function mixed(background: string, foreground: string, weight: number): string {
  return `color-mix(in srgb, ${background} ${weight}%, ${foreground})`;
}

function sameColor(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Fill missing ANSI colors deterministically from the page colors. */
export function themePalette(
  background: string,
  foreground: string,
  values: Partial<Record<keyof ThemePalette, string>>,
): ThemePalette {
  return {
    red: values.red ?? mixed(background, foreground, 40),
    green: values.green ?? mixed(background, foreground, 40),
    yellow: values.yellow ?? mixed(background, foreground, 40),
    blue: values.blue ?? mixed(background, foreground, 40),
    magenta: values.magenta ?? mixed(background, foreground, 40),
    cyan: values.cyan ?? mixed(background, foreground, 40),
    orange: values.orange ?? mixed(background, foreground, 40),
    brown: values.brown ?? mixed(background, foreground, 40),
  };
}

function readable(background: string, foreground: string, value: string): string {
  return sameColor(value, background) ? mixed(background, foreground, 40) : value;
}

const CHART_PALETTE = ["blue", "magenta", "green", "orange", "cyan", "yellow"] as const;

/** The semantic tokens plots and status pills read, painted from the palette. */
export function themeTokens(colors: ThemeColors): Array<[string, string]> {
  const token = (value: string) => readable(colors.background, colors.foreground, value);
  return [
    ...CHART_PALETTE.map(
      (key, index) => [`--chart-${index + 1}`, token(colors.palette[key])] as [string, string],
    ),
    ["--status-ok", token(colors.palette.green)],
    ["--status-warn", token(colors.palette.yellow)],
    ["--status-bad", token(colors.palette.red)],
    ["--status-idle", token(colors.mutedForeground)],
    ["--status-info", token(colors.palette.blue)],
  ];
}
