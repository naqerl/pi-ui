import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { buildTranscript } from "../src/server/session.js";
import {
  APP_ROOT,
  buildVersionNotice,
  changesBetween,
  compareVersions,
  parseChangelog,
  pendingVersionNotice,
  readLastSeenVersion,
  writeLastSeenVersion,
} from "../src/server/version-notice.js";

const CHANGELOG = `# Changelog

Intro.

## 1.6.0 - 2026-11-01

- Six.

## [1.5.0] - 2026-10-29

- Five.

## 1.4.3

- Four three.
`;

test("versions compare numerically", () => {
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(compareVersions("v1.5.0", "1.5.0"), 0);
  assert.equal(compareVersions("1.5.0-rc.1", "1.5.0"), -1);
});

test("the changelog splits into version sections", () => {
  const sections = parseChangelog(CHANGELOG);
  assert.deepEqual(
    sections.map((section) => section.version),
    ["1.6.0", "1.5.0", "1.4.3"],
  );
  assert.match(sections[1]?.text ?? "", /Five/);
});

test("an update gets every section after the last seen version", () => {
  const picked = changesBetween(parseChangelog(CHANGELOG), "1.4.3", "1.6.0");
  assert.deepEqual(
    picked.map((section) => section.version),
    ["1.6.0", "1.5.0"],
  );
  const unknown = changesBetween(parseChangelog(CHANGELOG), undefined, "1.5.0");
  assert.deepEqual(
    unknown.map((section) => section.version),
    ["1.5.0"],
  );
});

test("the notice names both versions and carries the changes", () => {
  const notice = buildVersionNotice("1.4.3", "1.6.0", CHANGELOG);
  assert.match(notice.prompt, /updated from 1\.4\.3 to 1\.6\.0/);
  assert.match(notice.prompt, /Six/);
  assert.match(notice.prompt, /Five/);
  assert.doesNotMatch(notice.prompt, /Four three/);
  assert.match(notice.note, /1\.4\.3 to 1\.6\.0/);
});

test("the shipped changelog has a section for the package version", async () => {
  const pkg = JSON.parse(await readFile(join(APP_ROOT, "package.json"), "utf8")) as {
    version: string;
  };
  const changelog = await readFile(join(APP_ROOT, "CHANGELOG.md"), "utf8");
  assert.ok(parseChangelog(changelog).some((section) => section.version === pkg.version));
});

test("the update note keeps its versions for the chat", () => {
  const entry = {
    id: 1,
    conversationId: "version-notice-test",
    kind: "ui.version-update",
    data: {
      from: "1.4.3",
      to: "1.5.0",
      note: "Updated pi-ui from 1.4.3 to 1.5.0. The agent has the changelog.",
      createdAt: "2026-10-30T00:00:00.000Z",
    },
  } as unknown as EntryRecord;
  const { messages } = buildTranscript([entry]);
  assert.equal(messages[0]?.role, "system");
  assert.deepEqual(messages[0]?.version, { from: "1.4.3", to: "1.5.0" });
});

test("a start only notifies when the version moved", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "pi-version-"));
  const root = await mkdtemp(join(tmpdir(), "pi-root-"));
  try {
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "1.6.0" }));
    await writeFile(join(root, "CHANGELOG.md"), CHANGELOG);
    // New install: nothing to tell.
    assert.equal((await pendingVersionNotice({ dataDir, resumed: false, root })).notice, undefined);
    // Existing conversation from before the check: the current section.
    const first = await pendingVersionNotice({ dataDir, resumed: true, root });
    assert.match(first.notice?.changes ?? "", /Six/);
    assert.doesNotMatch(first.notice?.changes ?? "", /Five/);
    await writeLastSeenVersion(dataDir, "1.6.0");
    assert.equal(await readLastSeenVersion(dataDir), "1.6.0");
    assert.equal((await pendingVersionNotice({ dataDir, resumed: true, root })).notice, undefined);
    await writeLastSeenVersion(dataDir, "1.4.3");
    const upgrade = await pendingVersionNotice({ dataDir, resumed: true, root });
    assert.equal(upgrade.notice?.from, "1.4.3");
    assert.match(upgrade.notice?.changes ?? "", /Five/);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
