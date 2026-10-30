import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { manifestColor } from "../shared/color.js";
import type { OmarchyTheme, OmarchyThemes, ThemeColors } from "../shared/types.js";

/** Colors and lengths that can sit in an HTML style attribute. */
const SAFE_CSS = /^[#%(),.\s\w/+-]+$/;

/** Stock Omarchy themes. The image copies the vendored catalog to this path. */
const STOCK_THEMES = "/usr/share/omarchy/themes";

/** Page theme when the desktop has no current name and nothing is saved. */
const FALLBACK_SLUG = "vantablack";

function displayName(slug: string): string {
  return slug
    .split("-")
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseRounding(text: string): number {
  const match = text.match(/\brounding\s*=\s*(\d+(?:\.\d+)?)/);
  if (match === null) return 0;
  const value = Number(match[1]);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function sameColor(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** First candidate that is not the page and not one of the colors already used. */
function firstDifferent(
  background: string,
  skip: readonly string[],
  candidates: Array<string | undefined>,
): string | null {
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    if (sameColor(candidate, background)) continue;
    if (skip.some((item) => sameColor(item, candidate))) continue;
    return candidate;
  }
  return null;
}

function mixed(background: string, foreground: string, weight: number): string {
  return `color-mix(in srgb, ${background} ${weight}%, ${foreground})`;
}

function parseColors(text: string): Omit<ThemeColors, "radius"> | null {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"\s*$/);
    const bare = trimmed.match(/^([A-Za-z0-9_]+)\s*=\s*([^\s#]+)\s*$/);
    const found = match ?? bare;
    if (found === null) continue;
    values[found[1]] = found[2];
  }
  const background = values.background;
  const foreground = values.foreground;
  if (background === undefined || foreground === undefined) return null;
  const mode = values.mode === "light" ? "light" : "dark";
  const lighter = values.lighter_background;
  const dark = values.dark_background;
  const darker = values.darker_background;
  // Prefer a raised panel. Themes like Solitude set lighter equal to the page,
  // so the chrome steps down to dark_background instead of matching the transcript.
  const surface =
    firstDifferent(background, [], [lighter, dark, darker]) ?? mixed(background, foreground, 86);
  const muted =
    firstDifferent(background, [surface], [dark, darker, lighter]) ??
    mixed(background, foreground, 93);
  return {
    mode,
    background,
    surface,
    foreground,
    muted,
    mutedForeground: values.dark_foreground ?? values.muted ?? foreground,
    border: values.lighter_background ?? values.selection ?? foreground,
    accent: values.accent ?? values.blue ?? foreground,
    destructive: values.red ?? "#c24040",
    selection: values.selection ?? values.lighter_background ?? background,
  };
}

async function readColors(dir: string, slug: string): Promise<Omit<ThemeColors, "radius"> | null> {
  try {
    return parseColors(await readFile(join(dir, slug, "colors.toml"), "utf8"));
  } catch {
    return null;
  }
}

/** User `hyprland.lua` wins. A theme with no `rounding` stays square, like Vantablack. */
async function readRounding(userDir: string, stockDir: string, slug: string): Promise<number> {
  for (const dir of [userDir, stockDir]) {
    try {
      return parseRounding(await readFile(join(dir, slug, "hyprland.lua"), "utf8"));
    } catch {
      // Missing file: try the stock theme, then square corners.
    }
  }
  return 0;
}

async function slugsIn(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function currentSlug(): Promise<string | null> {
  try {
    const text = await readFile(join(homedir(), ".local/state/omarchy/current/theme.name"), "utf8");
    const slug = text.trim();
    if (slug.length > 0) return slug;
  } catch {
    // No desktop theme. Vantablack is in the image catalog.
  }
  return FALLBACK_SLUG;
}

/** Stock themes plus any user theme of the same slug, which wins. */
export async function listThemes(): Promise<OmarchyThemes> {
  const stock = STOCK_THEMES;
  const user = join(homedir(), ".config/omarchy/themes");
  const slugs = [...new Set([...(await slugsIn(stock)), ...(await slugsIn(user))])].sort();
  const themes: OmarchyTheme[] = [];
  for (const slug of slugs) {
    const colors = (await readColors(user, slug)) ?? (await readColors(stock, slug));
    if (colors === null) continue;
    themes.push({
      slug,
      name: displayName(slug),
      colors: { ...colors, radius: await readRounding(user, stock, slug) },
    });
  }
  const current = await currentSlug();
  return {
    current: themes.some((theme) => theme.slug === current) ? current : null,
    selected: null,
    themes,
  };
}

export async function readThemeSlug(file: string): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || !("slug" in parsed)) return null;
    const slug = parsed.slug;
    if (typeof slug !== "string" || slug.length === 0 || slug.length > 200) return null;
    if (slug.includes("/") || slug.includes("\\") || slug.includes("\0")) return null;
    return slug;
  } catch {
    return null;
  }
}

export async function writeThemeSlug(file: string, slug: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ slug })}\n`, "utf8");
  await rename(temporary, file);
}

/** Saved slug when it is still installed, otherwise the desktop theme. */
export async function resolveTheme(file: string): Promise<{
  themes: OmarchyThemes;
  active: OmarchyTheme | null;
}> {
  const listed = await listThemes();
  const stored = await readThemeSlug(file);
  const selected =
    stored !== null && listed.themes.some((theme) => theme.slug === stored) ? stored : null;
  const slug = selected ?? listed.current;
  const active = listed.themes.find((theme) => theme.slug === slug) ?? null;
  return { themes: { ...listed, selected }, active };
}

/**
 * Declarations for the document element. Inline on `<html>` so they win over
 * the stylesheet's default `:root` colors and the first paint is the theme.
 * Returns null when a value is not safe to embed.
 */
export function themeStyle(colors: ThemeColors): string | null {
  const declarations: Array<[string, string]> = [
    ["--background", colors.background],
    ["--surface", colors.surface],
    ["--foreground", colors.foreground],
    ["--muted", colors.muted],
    ["--muted-foreground", colors.mutedForeground],
    ["--border", colors.border],
    ["--accent", colors.accent],
    ["--destructive", colors.destructive],
    ["--radius", `${colors.radius}px`],
    ["color-scheme", colors.mode],
    ["background-color", colors.background],
    ["color", colors.foreground],
  ];
  const parts: string[] = [];
  for (const [name, value] of declarations) {
    if (!SAFE_CSS.test(value)) return null;
    parts.push(`${name}:${value}`);
  }
  return parts.join(";");
}

/** Put the active theme on `<html>` and replace the default `color-scheme` and `theme-color` metas. */
export function injectTheme(html: string, theme: OmarchyTheme | null): string {
  if (theme === null) return html;
  const style = themeStyle(theme.colors);
  if (style === null) return html;
  const opened = html.replace(/<html\b([^>]*)>/i, (_match, attrs: string) => {
    const cleaned = attrs.replace(/\sstyle="[^"]*"/i, "");
    return `<html${cleaned} style="${style}">`;
  });
  // `\b` after the closing quote never matches: `"` and the following space are both non-words.
  const withoutThemeColor = opened.replace(
    /[ \t]*<meta\b[^>]*\bname="theme-color"[^>]*>\r?\n?/gi,
    "",
  );
  // The UA paints its own surfaces (form controls, scrollbars, overscroll) in the
  // theme's scheme before any stylesheet loads.
  const withoutScheme = withoutThemeColor.replace(
    /[ \t]*<meta\b[^>]*\bname="color-scheme"[^>]*>\r?\n?/gi,
    "",
  );
  const chromeColor = manifestColor(theme.colors.background) ?? theme.colors.background;
  const metas = [
    `<meta name="color-scheme" content="${theme.colors.mode}" />`,
    `<meta name="theme-color" content="${chromeColor}" />`,
  ];
  if (!withoutScheme.includes("</head>")) return withoutScheme;
  return withoutScheme.replace(
    "</head>",
    `${metas.map((meta) => `    ${meta}\n`).join("")}  </head>`,
  );
}

/**
 * The web app manifest painted with the active theme. An installed app reads
 * `theme_color` and `background_color` for its splash screen and system bars
 * (status bar, and the navigation bar with the home button on Android) before
 * the page sets its own `theme-color`. Both follow the page background so the
 * bars blend into the app. Unknown or unsafe colors leave the file as it is.
 */
export function themeManifest(manifest: string, theme: OmarchyTheme | null): string {
  if (theme === null) return manifest;
  const color = manifestColor(theme.colors.background);
  if (color === null) return manifest;
  try {
    const parsed = JSON.parse(manifest) as Record<string, unknown>;
    return `${JSON.stringify({ ...parsed, theme_color: color, background_color: color }, null, 2)}\n`;
  } catch {
    return manifest;
  }
}
