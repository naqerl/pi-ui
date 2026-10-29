import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The package root: `src/server` in development and `dist/server` in the image are both two levels down. */
export const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The longest changelog excerpt handed to the agent. Older sections are dropped first. */
const MAX_CHANGES = 8000;

export interface ChangelogSection {
  version: string;
  /** The section's heading line and body, trimmed. */
  text: string;
}

export interface VersionNotice {
  from: string | undefined;
  to: string;
  changes: string;
  /** The text the agent sees. */
  prompt: string;
  /** The short line shown in the transcript. */
  note: string;
}

/** Splits a changelog into its `## <version>` sections, in file order. */
export function parseChangelog(markdown: string): ChangelogSection[] {
  const sections: ChangelogSection[] = [];
  let current: { version: string; lines: string[] } | undefined;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+\[?v?(\d+\.\d+\.\d+[^\]\s]*)\]?/.exec(line);
    if (heading?.[1] !== undefined) {
      if (current !== undefined) {
        sections.push({ version: current.version, text: current.lines.join("\n").trim() });
      }
      current = { version: heading[1], lines: [line] };
    } else if (/^#\s/.test(line)) {
      // A top-level heading ends the section above it.
    } else if (current !== undefined) {
      current.lines.push(line);
    }
  }
  if (current !== undefined) {
    sections.push({ version: current.version, text: current.lines.join("\n").trim() });
  }
  return sections;
}

/** Compares `major.minor.patch` versions; a prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const parse = (value: string) => {
    const [core = "", pre] = value.replace(/^v/, "").split("-", 2);
    return { parts: core.split(".").map((part) => Number.parseInt(part, 10) || 0), pre };
  };
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < 3; index++) {
    const difference = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === undefined) return 1;
  if (right.pre === undefined) return -1;
  return left.pre < right.pre ? -1 : 1;
}

/**
 * The sections a reader moving from `from` to `to` has not seen: newer than `from`, up to `to`.
 * Without a known `from` (or after a downgrade) only the section for `to` is returned.
 */
export function changesBetween(
  sections: readonly ChangelogSection[],
  from: string | undefined,
  to: string,
): ChangelogSection[] {
  const upgrade = from !== undefined && compareVersions(from, to) < 0;
  const picked = sections.filter((section) =>
    upgrade
      ? compareVersions(section.version, from) > 0 && compareVersions(section.version, to) <= 0
      : compareVersions(section.version, to) === 0,
  );
  return picked.sort((a, b) => compareVersions(b.version, a.version));
}

/** Builds what the agent and the transcript are told about a version change. */
export function buildVersionNotice(
  from: string | undefined,
  to: string,
  changelog: string | undefined,
): VersionNotice {
  const sections =
    changelog === undefined ? [] : changesBetween(parseChangelog(changelog), from, to);
  let changes = "";
  for (const section of sections) {
    const next = changes.length === 0 ? section.text : `${changes}\n\n${section.text}`;
    if (next.length > MAX_CHANGES) break;
    changes = next;
  }
  const moved =
    from === undefined ? `pi-ui is now version ${to}` : `pi-ui was updated from ${from} to ${to}`;
  const prompt = [
    `<pi-ui-update>`,
    `${moved}. This is the web app that runs you; the server restarted on the new version.`,
    changes.length > 0
      ? `What changed, from its CHANGELOG.md:\n\n${changes}`
      : "CHANGELOG.md has no entry for this version.",
    `Mention the update only if it matters to what the user is doing.`,
    `</pi-ui-update>`,
  ].join("\n");
  const note =
    from === undefined
      ? `pi-ui ${to}`
      : `Updated pi-ui from ${from} to ${to}. The agent has the changelog.`;
  return { from, to, changes, prompt, note };
}

interface VersionRecord {
  lastSeen: string;
  updatedAt: string;
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export async function readAppVersion(root = APP_ROOT): Promise<string> {
  const text = await readText(join(root, "package.json"));
  if (text === undefined) return "0.0.0";
  try {
    const parsed = JSON.parse(text) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function readLastSeenVersion(dataDir: string): Promise<string | undefined> {
  const text = await readText(join(dataDir, "version.json"));
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as Partial<VersionRecord>;
    return typeof parsed.lastSeen === "string" ? parsed.lastSeen : undefined;
  } catch {
    return undefined;
  }
}

export async function writeLastSeenVersion(dataDir: string, version: string): Promise<void> {
  const path = join(dataDir, "version.json");
  const record: VersionRecord = { lastSeen: version, updatedAt: new Date().toISOString() };
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
  await rename(temporary, path);
}

/**
 * Decides whether this start needs a notice. A new install (no record and a fresh conversation)
 * only records the version; an existing conversation without a record predates this check and
 * gets the current version's changes.
 */
export async function pendingVersionNotice(options: {
  dataDir: string;
  resumed: boolean;
  root?: string;
}): Promise<{ notice: VersionNotice | undefined; version: string }> {
  const root = options.root ?? APP_ROOT;
  const version = await readAppVersion(root);
  const lastSeen = await readLastSeenVersion(options.dataDir);
  if (lastSeen === version) return { notice: undefined, version };
  if (lastSeen === undefined && !options.resumed) return { notice: undefined, version };
  const changelog = await readText(join(root, "CHANGELOG.md"));
  return { notice: buildVersionNotice(lastSeen, version, changelog), version };
}
