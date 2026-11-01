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
  IDLE_STATUS_INTERVAL_MS,
  IdleNudge,
  type IdleTaskStatus,
  idleBlockedNudgeText,
  idleNudgeMs,
  idleNudgeText,
  openTaskIds,
  staleWorkedTasks,
  taskSetHash,
  waitingOn,
  workingTaskIds,
} from "../src/server/idle-nudge.js";
import { buildTranscript, IDLE_NUDGE_ENTRY_KIND } from "../src/server/session.js";
import { parseNotice } from "../src/shared/notices.js";
import { isQueuedNotice } from "../src/shared/queue.js";

const nothing = { active: false, queued: 0, openTaskIds: [] as string[] };
const task = (id: string, status: IdleTaskStatus = "open", blockedBy: string[] = []) => ({
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
    "You have been idle for 20 minutes and 2 task(s) are open: a1, b2. Mark a task working with task_working before starting it; it sets the task to working and records when the work began. If it cannot be done now, mark it blocked and propose_task the task that would unblock it; if other tasks are already in progress, leave it alone — ignoring it is a valid answer.",
  );
  assert.deepEqual(parseNotice(idleNudgeText(["a1", "b2"])), {
    kind: "idle",
    text: idleNudgeText(["a1", "b2"]),
    taskIds: ["a1", "b2"],
    summary: "idle · 2 task(s) open: a1, b2",
  });
});

test("the nudge names stale working tasks and repeats only when the set changes", () => {
  const now = Date.parse("2026-10-31T12:00:00.000Z");
  const hour = 60 * 60_000;
  const stale = {
    id: "a1",
    title: "Ship the stale badge",
    status: "open" as const,
    blockedBy: [],
    lastWorkedAt: new Date(now - 2 * hour).toISOString(),
  };
  const fresh = {
    id: "b2",
    title: "Fresh work",
    status: "open" as const,
    blockedBy: [],
    lastWorkedAt: new Date(now - 60_000).toISOString(),
  };
  assert.deepEqual(
    staleWorkedTasks([stale, fresh], now).map((task) => task.id),
    ["a1"],
  );
  assert.deepEqual(
    staleWorkedTasks([{ ...stale, lastWorkedAt: new Date(now - hour).toISOString() }], now),
    [],
  );

  const nudge = new IdleNudge(1_000, 0, "");
  const text = nudge.maybeNudge(
    { ...nothing, tasks: [stale, fresh], openTaskIds: ["a1", "b2"] },
    now,
  );
  assert.match(
    text ?? "",
    /These tasks were marked as working, but nothing has touched them for over an hour: a1 — Ship the stale badge\./,
  );
  assert.match(text ?? "", /call a tool with its id as piuiTaskId/);
  assert.equal(parseNotice(text ?? "")?.kind, "idle");

  nudge.noteActivity(now + 1);
  assert.equal(
    nudge.maybeNudge({ ...nothing, tasks: [stale, fresh], openTaskIds: ["a1", "b2"] }, now + 2_000),
    null,
    "the same set is silenced by the existing hash",
  );
  const changed = nudge.maybeNudge(
    { ...nothing, tasks: [stale, fresh], openTaskIds: ["a1", "b2", "c3"] },
    now + 3_000,
  );
  assert.match(changed ?? "", /over an hour: a1 — Ship the stale badge\./);
  assert.doesNotMatch(changed ?? "", /b2 —/);
});

test("a persisted working task is stale only when nothing newer touched it", () => {
  const now = Date.parse("2026-10-31T12:00:00.000Z");
  const hour = 60 * 60_000;
  const old = new Date(now - 2 * hour).toISOString();
  const recent = new Date(now - 60_000).toISOString();
  const touchedRecently = {
    id: "w1",
    title: "Recently tagged",
    status: "working" as const,
    blockedBy: [],
    workingSince: old,
    lastWorkedAt: recent,
  };
  const tracedRecently = {
    ...touchedRecently,
    id: "w2",
    lastWorkedAt: undefined,
    lastActivityAt: recent,
  };
  const untouchedSince = {
    ...touchedRecently,
    id: "w3",
    lastWorkedAt: undefined,
  };
  assert.deepEqual(
    staleWorkedTasks([touchedRecently, tracedRecently, untouchedSince], now).map((task) => task.id),
    ["w3"],
  );
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
    idleNudgeText(["fvte"]),
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

test("a nudge names at most twenty task ids", () => {
  const ids = Array.from({ length: 25 }, (_, index) => `t${index + 1}`);
  const text = idleNudgeText(ids);
  assert.match(text, /t20/);
  assert.doesNotMatch(text, /t21/);
});

test("an ignored task returns after three silent nudges", async () => {
  const directory = await temporaryDataDir();
  try {
    const nudge = new IdleNudge(1_000, 0, directory);
    const firstTasks = ["a1", "a2", "a3", "a4", "a5"].map((id) => task(id));
    assert.equal(openTaskIds(firstTasks).length, 5);
    const first = nudge.maybeNudge({ ...nothing, tasks: firstTasks }, 1_000);
    for (const id of ["a1", "a2", "a3", "a4", "a5"]) assert.match(first ?? "", new RegExp(id));

    // Three tasks were answered by starting them; two were silently ignored.
    const tasks = [
      task("a1", "working"),
      task("a2", "working"),
      task("a3", "working"),
      task("a4"),
      task("a5"),
    ];
    assert.deepEqual(workingTaskIds(tasks), ["a1", "a2", "a3"]);
    assert.deepEqual(openTaskIds(tasks), ["a4", "a5"]);

    for (let index = 1; index <= 3; index++) {
      const at = 1_000 + index * IDLE_STATUS_INTERVAL_MS;
      nudge.noteActivity(at - 1_000);
      const text = nudge.maybeNudge({ ...nothing, tasks }, at);
      assert.ok(text, `silent nudge ${index} still asks the working tasks`);
      for (const id of ["a1", "a2", "a3"]) assert.match(text, new RegExp(id));
      assert.doesNotMatch(text, /a4|a5/);
      assert.match(text, /Status check/);
    }

    const record = JSON.parse(await readFile(join(directory, "idle-nudge.json"), "utf8")) as {
      tasks: Record<string, { named: number; lastNamedAt: string; state: string; silent: number }>;
    };
    assert.equal(record.tasks.a1?.named, 4);
    assert.equal(record.tasks.a1?.state, "working");
    assert.equal(
      record.tasks.a1?.lastNamedAt,
      new Date(3 * IDLE_STATUS_INTERVAL_MS + 1_000).toISOString(),
    );
    assert.equal(record.tasks.a4?.silent, 3);

    const fourthAt = 1_000 + 4 * IDLE_STATUS_INTERVAL_MS;
    nudge.noteActivity(fourthAt - 1_000);
    const fourth = nudge.maybeNudge({ ...nothing, tasks }, fourthAt);
    assert.match(fourth ?? "", /a4, a5/, "the ignored tasks come back together");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a single ignored task comes back on the fourth quiet idle window", async () => {
  const directory = await temporaryDataDir();
  try {
    const nudge = new IdleNudge(1_000, 0, directory);
    const tasks = [task("a1")];
    assert.ok(nudge.maybeNudge({ ...nothing, tasks }, 1_000));
    nudge.noteActivity(2_000);

    for (let index = 1; index <= 3; index++) {
      const at = 2_000 + index * 1_000;
      assert.equal(nudge.maybeNudge({ ...nothing, tasks }, at), null);
      const record = JSON.parse(await readFile(join(directory, "idle-nudge.json"), "utf8")) as {
        tasks: Record<string, { silent: number }>;
      };
      assert.equal(record.tasks.a1?.silent, index, "each quiet window is remembered");
      // The timer may poll again immediately; that must not burn another window.
      assert.equal(nudge.maybeNudge({ ...nothing, tasks }, at + 1), null);
    }

    const fourth = nudge.maybeNudge({ ...nothing, tasks }, 6_000);
    assert.match(fourth ?? "", /open: a1\./);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("all ignored tasks return after three quiet idle windows", async () => {
  const directory = await temporaryDataDir();
  try {
    const nudge = new IdleNudge(1_000, 0, directory);
    const tasks = ["a1", "a2", "a3", "a4", "a5"].map((id) => task(id));
    const first = nudge.maybeNudge({ ...nothing, tasks }, 1_000);
    assert.match(first ?? "", /a1, a2, a3, a4, a5/);
    nudge.noteActivity(2_000);

    for (let index = 1; index <= 3; index++) {
      assert.equal(nudge.maybeNudge({ ...nothing, tasks }, 2_000 + index * 1_000), null);
    }
    const fourth = nudge.maybeNudge({ ...nothing, tasks }, 6_000);
    assert.match(fourth ?? "", /a1, a2, a3, a4, a5/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("only the ids shown in the capped text are remembered as named", async () => {
  const directory = await temporaryDataDir();
  try {
    const nudge = new IdleNudge(1_000, 0, directory);
    const tasks = Array.from({ length: 25 }, (_, index) => task(`t${index + 1}`));
    const first = nudge.maybeNudge({ ...nothing, tasks }, 1_000);
    assert.match(first ?? "", /t20/);
    assert.doesNotMatch(first ?? "", /t21/);

    const record = JSON.parse(await readFile(join(directory, "idle-nudge.json"), "utf8")) as {
      tasks: Record<string, { named: number }>;
    };
    assert.equal(record.tasks.t20?.named, 1);
    assert.equal(record.tasks.t21, undefined, "a task the text never named is still new");

    nudge.noteActivity(2_000);
    const second = nudge.maybeNudge({ ...nothing, tasks }, 3_000);
    assert.match(second ?? "", /t21, t22, t23, t24, t25/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a working task is asked for a status at most hourly", () => {
  const nudge = new IdleNudge(1_000, 0, "");
  const tasks = [task("a1", "working")];
  const first = nudge.maybeNudge({ ...nothing, tasks }, 1_000);
  assert.match(first ?? "", /Status check for tasks marked working: a1/);
  assert.doesNotMatch(first ?? "", /task\(s\) are open/);

  const tooSoon = 1_000 + IDLE_STATUS_INTERVAL_MS - 1;
  nudge.noteActivity(tooSoon - 1_000);
  assert.equal(nudge.maybeNudge({ ...nothing, tasks }, tooSoon), null);

  const hourly = 1_000 + IDLE_STATUS_INTERVAL_MS;
  nudge.noteActivity(hourly - 1_000);
  assert.match(
    nudge.maybeNudge({ ...nothing, tasks }, hourly) ?? "",
    /Status check for tasks marked working: a1/,
  );
});

test("an old hash-only record is read and upgraded on the next write", async () => {
  const directory = await temporaryDataDir();
  try {
    const file = join(directory, "idle-nudge.json");
    await writeFile(
      file,
      JSON.stringify({ hash: taskSetHash(["a1"]), nudgedAt: new Date(1_000).toISOString() }),
      "utf8",
    );
    const nudge = new IdleNudge(1_000, 0, directory);
    assert.equal(nudge.nudgedHash, taskSetHash(["a1"]));
    assert.equal(nudge.maybeNudge({ ...nothing, openTaskIds: ["a1"] }, 5_000), null);

    assert.ok(nudge.maybeNudge({ ...nothing, openTaskIds: ["a2"] }, 6_000));
    const record = JSON.parse(await readFile(file, "utf8")) as {
      tasks: Record<string, { named: number }>;
    };
    assert.equal(record.tasks.a2?.named, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
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
    assert.equal(restarted.nudgedTasks.a1?.named, 1);
    assert.equal(
      restarted.maybeNudge(work, 5_000),
      null,
      "an unacted task is not repeated at once",
    );

    restarted.noteActivity(6_000);
    assert.ok(restarted.maybeNudge({ ...nothing, openTaskIds: ["a1", "c3"] }, 7_000));
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
  assert.equal(nudge.maybeNudge(work, 1_000), idleNudgeText(["a1"]));
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

  const notice = message?.notice;
  assert.ok(notice !== undefined && !isQueuedNotice(notice));
  const markup = renderToStaticMarkup(createElement(NoticeLine, { message, notice }));
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
