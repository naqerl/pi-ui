import { manifestColor } from "../shared/color";
import type { ThemeColors } from "../shared/types";

/** The document's runtime paint, chrome metas and installed-app manifest. */
export function applyTheme(colors: ThemeColors): void {
  const root = document.documentElement;
  const pairs: Array<[string, string]> = [
    ["--background", colors.background],
    ["--surface", colors.surface],
    ["--foreground", colors.foreground],
    ["--muted", colors.muted],
    ["--muted-foreground", colors.mutedForeground],
    ["--border", colors.border],
    ["--accent", colors.accent],
    ["--destructive", colors.destructive],
  ];
  for (const [name, value] of pairs) root.style.setProperty(name, value);
  root.style.setProperty("--radius", `${colors.radius}px`);
  root.style.colorScheme = colors.mode;
  root.style.backgroundColor = colors.background;
  root.style.color = colors.foreground;
  const chromeColor = manifestColor(colors.background) ?? colors.background;
  // One unscoped theme-color drives the browser chrome and, in an installed app,
  // the system status and navigation bars, so they repaint with every theme change.
  const metas = [...document.querySelectorAll('meta[name="theme-color"]')];
  const meta = metas[0] ?? document.head.appendChild(document.createElement("meta"));
  for (const extra of metas.slice(1)) extra.remove();
  meta.setAttribute("name", "theme-color");
  meta.removeAttribute("media");
  meta.setAttribute("content", chromeColor);
  const scheme =
    document.querySelector('meta[name="color-scheme"]') ??
    document.head.appendChild(document.createElement("meta"));
  scheme.setAttribute("name", "color-scheme");
  scheme.setAttribute("content", colors.mode);
  paintManifest(colors);
}

let manifestRevision = 0;

function manifestLink(): HTMLLinkElement | null {
  return document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
}

/** A cache-busting server URL, so the manifest's relative members stay relative to the app. */
export function manifestHref(href: string, revision: number, base = "http://localhost/"): string {
  const url = new URL(href, base);
  url.searchParams.set("rev", String(revision));
  return url.toString();
}

function paintManifest(colors: ThemeColors): void {
  const link = manifestLink();
  if (link === null) return;
  if (manifestColor(colors.background) === null) return;
  // Keep the server URL: a blob URL makes Chrome ignore start_url, scope, icons
  // and share_target.action because those members are relative to the blob.
  link.href = manifestHref(link.href, ++manifestRevision, window.location.href);
}
