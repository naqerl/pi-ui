import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NoticeLine } from "../src/client/NoticeView.js";
import { ChatService } from "../src/server/chat-service.js";
import {
  DEFAULT_IDLE_NUDGE_MS,
  IdleNudge,
  idleBlockedNudgeText,
  idleNudgeMs,
  idleNudgeText,
  openTaskIds,
  taskSetHash,
  waitingOn,
} from "../src/server/idle-nudge.js";
import { buildTranscript, IDLE_NUDGE_ENTRY_KIND } from "../src/server/session.js";
import { parseNotice } from "../src/shared/notices.js";
import type { TaskStatus } from "../src/shared/types.js";

const nothing = { active: false, queued: 0, openTaskIds: [] as string[] };
const task = (id: string, status: TaskStatus = "open", blockedBy: string[] = []) => ({
  id,
  status,
  blockedBy,
});

async function temporaryDataDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pi-idle-nudge-"));
}

test("the idle window defaults to twenty minutes and zero disables it", () => {
  assert.equal(DEFAULT_IDLE_NUDGE_MS, 1_200_000);
  assert.equal(idleNudgeMs({}), DEFAULT_IDLE_NUDGE_MS);
  assert.equal(idleNudgeMs({ PI_IDLE_NUDGE_MS: "" }), DEFAULT_IDLE_NUDGE_MS);
  assert.equal(idleNudgeMs({ PI_IDLE_NUDGE_MS: "2500" }), 2_500);
  assert.equal(idleNudgeMs({ PI_IDLE_NUDGE_MS: "0" }), 0);
  assert.equal(idleNudgeMs({ PI_IDLE_NUDGE_MS: "soon" }), DEFAULT_IDLE_NUDGE_MS);
  assert.equal(idleNudgeMs({ PI_IDLE_NUDGE_MS: "-1" }), DEFAULT_IDLE_NUDGE_MS);

  const disabled = new IdleNudge(0, 0, "");
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.maybeNudge({ ...nothing, openTaskIds: ["a"] }, 10_000_000), null);
});

test("the prompt names the count and ids, and only unblocked open tasks count", () => {
  const tasks = [
    task("a1"),
    task("p1", "proposed"),
    task("d1", "done"),
    task("blocked", "open", ["a1"]),
    task("b2"),
  ];
  assert.deepEqual(openTaskIds(tasks), ["a1", "b2"]);
  assert.equal(
    idleNudgeText(["a1", "b2"]),
    "You have been idle for 20 minutes and 2 task(s) are open: a1, b2. Pick the next one and implement it.",
  );
  assert.deepEqual(parseNotice(idleNudgeText(["a1", "b2"])), {
    kind: "idle",
    text: idleNudgeText(["a1", "b2"]),
    taskIds: ["a1", "b2"],
    summary: "idle · 2 task(s) open: a1, b2",
  });
});

test("a task blocked by an open task is not nudged", () => {
  const tasks = [task("simy"), task("fvte", "open", ["simy"])];
  assert.deepEqual(openTaskIds(tasks), ["simy"]);
  assert.deepEqual(waitingOn(tasks), { fvte: ["simy"] });

  const nudge = new IdleNudge(1_000, 0, "");
  const text = nudge.maybeNudge({ ...nothing, openTaskIds: openTaskIds(tasks) }, 1_000);
  assert.match(text ?? "", /open: simy\./);
  assert.doesNotMatch(text ?? "", /fvte/);
});

test("a task whose blocker is done is nudged", () => {
  const tasks = [task("simy", "done"), task("fvte", "open", ["simy"])];
  assert.deepEqual(openTaskIds(tasks), ["fvte"]);
  assert.deepEqual(waitingOn(tasks), {});

  const nudge = new IdleNudge(1_000, 0, "");
  assert.equal(
    nudge.maybeNudge({ ...nothing, openTaskIds: openTaskIds(tasks) }, 1_000),
    "You have been idle for 20 minutes and 1 task(s) are open: fvte. Pick the next one and implement it.",
  );
});

test("all blocked keeps the nudge quiet and armed", () => {
  const tasks = [task("a", "open", ["b"]), task("b", "open", ["a"])];
  assert.deepEqual(openTaskIds(tasks), []);
  assert.deepEqual(waitingOn(tasks), { a: ["b"], b: ["a"] });

  const nudge = new IdleNudge(1_000, 0, "");
  assert.equal(nudge.maybeNudge({ ...nothing, openTaskIds: openTaskIds(tasks) }, 5_000), null);
  assert.equal(nudge.armed, true);

  const unblocked = [...tasks, task("c")];
  assert.ok(nudge.maybeNudge({ ...nothing, openTaskIds: openTaskIds(unblocked) }, 5_001));
});

test("the blocked notice names the blockers", () => {
  const tasks = [task("simy"), task("fvte", "open", ["simy"])];
  assert.equal(
    idleBlockedNudgeText(waitingOn(tasks)),
    "You have been idle for 20 minutes. Nothing is unblocked: fvte waits on simy.",
  );
  const parsed = parseNotice(idleBlockedNudgeText(waitingOn(tasks)));
  assert.equal(parsed?.kind, "idle");
  assert.deepEqual(parsed?.taskIds, ["fvte"]);
});

test("an unknown blocker id does not block", () => {
  const tasks = [task("fvte", "open", ["missing"])];
  assert.deepEqual(openTaskIds(tasks), ["fvte"]);
  assert.deepEqual(waitingOn(tasks), {});
});

test("the same task set nudges only once", () => {
  const nudge = new IdleNudge(1_000, 0, "");
  const work = { ...nothing, openTaskIds: ["a1"] };
  assert.ok(nudge.maybeNudge(work, 1_000));
  nudge.noteActivity(2_000);
  assert.equal(nudge.maybeNudge(work, 3_000), null, "the same task set stays quiet");
});

test("a new task nudges again", () => {
  const nudge = new IdleNudge(1_000, 0, "");
  assert.ok(nudge.maybeNudge({ ...nothing, openTaskIds: ["a1"] }, 1_000));
  nudge.noteActivity(2_000);
  assert.ok(
    nudge.maybeNudge({ ...nothing, openTaskIds: ["a1", "a2"] }, 3_000),
    "a new task changes the set and nudges once",
  );
  nudge.noteActivity(4_000);
  assert.equal(nudge.maybeNudge({ ...nothing, openTaskIds: ["a1", "a2"] }, 5_000), null);
});

test("the recorded hash survives a restart", async () => {
  const directory = await temporaryDataDir();
  try {
    const work = { ...nothing, openTaskIds: ["a1", "b2"] };
    const first = new IdleNudge(1_000, 0, directory);
    assert.ok(first.maybeNudge(work, 1_000));
    const record = JSON.parse(await readFile(join(directory, "idle-nudge.json"), "utf8")) as {
      hash: string;
      nudgedAt: string;
    };
    assert.equal(record.hash, taskSetHash(["b2", "a1"]));
    assert.equal(record.nudgedAt, new Date(1_000).toISOString());

    const restarted = new IdleNudge(1_000, 0, directory);
    assert.equal(restarted.nudgedHash, record.hash);
    assert.equal(restarted.maybeNudge(work, 5_000), null, "a restart does not repeat the nudge");

    restarted.noteActivity(6_000);
    assert.ok(restarted.maybeNudge({ ...nothing, openTaskIds: ["a1"] }, 7_000));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a missing or corrupt record is tolerated", async () => {
  const directory = await temporaryDataDir();
  try {
    const missing = new IdleNudge(1_000, 0, directory);
    assert.equal(missing.nudgedHash, undefined);
    await writeFile(join(directory, "idle-nudge.json"), "{not json", "utf8");
    const corrupt = new IdleNudge(1_000, 0, directory);
    assert.equal(corrupt.nudgedHash, undefined);
    await writeFile(
      join(directory, "idle-nudge.json"),
      JSON.stringify({ hash: taskSetHash(["a1"]), nudgedAt: 1e20 }),
      "utf8",
    );
    const corruptTimestamp = new IdleNudge(1_000, 0, directory);
    assert.equal(corruptTimestamp.nudgedHash, undefined);
    await writeFile(
      join(directory, "idle-nudge.json"),
      JSON.stringify({ hash: taskSetHash(["a1"]), nudgedAt: "not a date" }),
      "utf8",
    );
    const corruptTimestampText = new IdleNudge(1_000, 0, directory);
    assert.equal(corruptTimestampText.nudgedHash, undefined);
    assert.ok(corruptTimestampText.maybeNudge({ ...nothing, openTaskIds: ["a1"] }, 1_000));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("it fires once after the window, then waits for fresh activity and a new task set", () => {
  const nudge = new IdleNudge(1_000, 0, "");
  const work = { ...nothing, openTaskIds: ["a1"] };
  assert.equal(nudge.maybeNudge(work, 999), null);
  assert.equal(
    nudge.maybeNudge(work, 1_000),
    "You have been idle for 20 minutes and 1 task(s) are open: a1. Pick the next one and implement it.",
  );
  assert.equal(nudge.maybeNudge(work, 20_000), null, "the same idle period does not nudge twice");

  nudge.noteActivity(20_000);
  assert.equal(nudge.maybeNudge(work, 20_999), null);
  assert.equal(nudge.maybeNudge(work, 21_000), null, "the same task set stays quiet");
  assert.ok(
    nudge.maybeNudge({ ...work, openTaskIds: ["a1", "a2"] }, 21_001),
    "a user message, steer or run start re-arms it for a new task set",
  );
});

test("it never fires while running, queued, or with no open task", () => {
  const nudge = new IdleNudge(1_000, 0, "");
  const work = { ...nothing, openTaskIds: ["a1"] };
  assert.equal(nudge.maybeNudge({ ...work, active: true }, 5_000), null);
  assert.equal(nudge.maybeNudge({ ...work, queued: 1 }, 5_000), null);
  assert.equal(nudge.maybeNudge({ ...work, openTaskIds: [] }, 5_000), null);

  nudge.noteActivity(5_000);
  assert.equal(nudge.maybeNudge({ ...work, active: true }, 10_000), null);
  // The run end starts a fresh window; the active check above did not consume one.
  nudge.noteActivity(10_000);
  assert.equal(nudge.maybeNudge(work, 10_999), null);
  assert.ok(nudge.maybeNudge(work, 11_000), "an idle window starts after the run ends");
});

test("the nudge is a notice chip with a distinct transcript kind", () => {
  const taskIds = ["a1", "b2"];
  const text = idleNudgeText(taskIds);
  const entries = [
    {
      id: 7,
      kind: IDLE_NUDGE_ENTRY_KIND,
      data: { text, taskIds, createdAt: "2026-10-30T10:00:00.000Z" },
    },
  ] as unknown as EntryRecord[];
  assert.equal(IDLE_NUDGE_ENTRY_KIND, "ui.idle-nudge");
  const message = buildTranscript(entries).messages[0];
  assert.equal(message?.role, "system");
  assert.equal(message?.text, text);
  assert.deepEqual(message?.notice, parseNotice(text));
  assert.notEqual(entries[0]?.kind, "user");

  assert.ok(message?.notice !== undefined);
  const markup = renderToStaticMarkup(
    createElement(NoticeLine, { message, notice: message.notice }),
  );
  assert.match(markup, /data-notice-kind="idle"/);
  assert.match(markup, /idle · 2 task\(s\) open: a1, b2/);
  assert.match(markup, /◷/);
  assert.match(markup, /class="[^"]*\bbackdrop-blur-md\b/);
  assert.match(markup, /class="[^"]*\bbg-surface\/90\b/);
  assert.doesNotMatch(markup, /data-role="user"/);
});

test("a failed nudge submission retries the same task set", async () => {
  const previous = process.env.PI_IDLE_NUDGE_MS;
  process.env.PI_IDLE_NUDGE_MS = "1000";
  const directory = await temporaryDataDir();
  try {
    const tasks = ["a1"];
    const chat = new ChatService(
      {} as never,
      {} as never,
      { broadcast() {} } as never,
      undefined,
      false,
      { clear: async () => undefined, write: async () => undefined } as never,
      undefined,
      { servers: [], unavailable: [] },
      {} as never,
      undefined,
      {} as never,
      {} as never,
      async () => undefined,
      () => undefined,
      () => tasks,
      directory,
    );
    const driven = chat as unknown as {
      idleNudge: IdleNudge;
      checkIdleNudge(): Promise<void>;
      setRunState(state: "idle" | "running"): void;
      submit(
        text: string,
        mode: "queue" | "steer",
        options?: { entry?: { kind: string } },
      ): Promise<unknown>;
    };
    const recordPath = join(directory, "idle-nudge.json");
    let attempts = 0;
    const delivered: string[] = [];
    driven.submit = async (text) => {
      attempts += 1;
      if (attempts === 1) throw new Error("durable is offline");
      delivered.push(text);
      driven.setRunState("running");
      driven.setRunState("idle");
      return {};
    };

    driven.idleNudge.noteActivity(0);
    await driven.checkIdleNudge();
    assert.equal(attempts, 1);
    assert.equal(delivered.length, 0);
    assert.equal(driven.idleNudge.nudgedHash, undefined, "the failed hash is forgotten");
    assert.equal(existsSync(recordPath), false, "the failed attempt leaves no record");

    (driven.idleNudge as unknown as { lastActivityAt: number }).lastActivityAt = Date.now() - 1_001;
    await driven.checkIdleNudge();
    assert.equal(attempts, 2, "the same task set is retried");
    assert.equal(delivered.length, 1);
    assert.equal(driven.idleNudge.nudgedHash, taskSetHash(["a1"]));
    assert.equal(existsSync(recordPath), true);
  } finally {
    if (previous === undefined) delete process.env.PI_IDLE_NUDGE_MS;
    else process.env.PI_IDLE_NUDGE_MS = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("the nudge's own run re-arms, so a new task set fires again", async () => {
  const previous = process.env.PI_IDLE_NUDGE_MS;
  process.env.PI_IDLE_NUDGE_MS = "1000";
  const directory = await temporaryDataDir();
  try {
    const tasks = ["a1"];
    const chat = new ChatService(
      {} as never,
      {} as never,
      { broadcast() {} } as never,
      undefined,
      false,
      { clear: async () => undefined, write: async () => undefined } as never,
      undefined,
      { servers: [], unavailable: [] },
      {} as never,
      undefined,
      {} as never,
      {} as never,
      async () => undefined,
      () => undefined,
      () => tasks,
      directory,
    );
    const driven = chat as unknown as {
      idleNudge: IdleNudge;
      checkIdleNudge(): Promise<void>;
      setRunState(state: "idle" | "running"): void;
      submit(
        text: string,
        mode: "queue" | "steer",
        options?: { entry?: { kind: string } },
      ): Promise<unknown>;
    };
    const seen: { text: string; mode: string; kind: string | undefined }[] = [];
    driven.submit = async (text, mode, options) => {
      seen.push({ text, mode, kind: options?.entry?.kind });
      driven.setRunState("running");
      driven.setRunState("idle");
      return {};
    };

    driven.idleNudge.noteActivity(0);
    await driven.checkIdleNudge();
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.mode, "queue");
    assert.equal(seen[0]?.kind, IDLE_NUDGE_ENTRY_KIND);
    assert.equal(driven.idleNudge.armed, true, "the nudge's own run end re-arms");

    // Move the clock past a second window without counting it as new user activity.
    tasks.push("a2");
    (driven.idleNudge as unknown as { lastActivityAt: number }).lastActivityAt = Date.now() - 1_001;
    await driven.checkIdleNudge();
    assert.equal(seen.length, 2, "a new task set after the nudge's run fires again");
    assert.match(seen[1]?.text ?? "", /^You have been idle for 20 minutes/);
  } finally {
    if (previous === undefined) delete process.env.PI_IDLE_NUDGE_MS;
    else process.env.PI_IDLE_NUDGE_MS = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
