import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import {
  IdleNudge,
  idleNudgeText,
  staleWorkedTasks,
  taskSetHash,
} from "../src/server/idle-nudge.js";
import { TaskActivityTracker } from "../src/server/task-activity.js";
import { parseNotice } from "../src/shared/notices.js";

const nothing = { active: false, queued: 0, openTaskIds: [] as string[] };
const now = Date.parse("2026-10-31T12:00:00.000Z");
const hour = 60 * 60_000;
const old = new Date(now - 2 * hour).toISOString();
const recent = new Date(now - 60_000).toISOString();

function workingTask(
  id: string,
  title: string,
  patch: Partial<{ lastWorkedAt: string; workingSince: string }> = {},
) {
  return {
    id,
    title,
    status: "working" as const,
    blockedBy: [],
    workingSince: old,
    lastWorkedAt: old,
    ...patch,
  };
}

test("a stale working task is actualized while a freshly worked one is not", () => {
  const stale = workingTask("w1", "Long-running badge");
  const fresh = workingTask("w2", "Fresh work", { lastWorkedAt: recent });
  expect(staleWorkedTasks([stale, fresh], now).map((task) => task.id)).toEqual(["w1"]);

  const nudge = new IdleNudge(1_000, 0, "");
  const text = nudge.maybeNudge({ ...nothing, tasks: [stale, fresh] }, now) ?? "";
  const actualize = text.split("\n\n").find((part) => part.startsWith("Actualize these tasks"));
  expect(actualize).toContain("w1 — Long-running badge");
  expect(actualize).not.toContain("w2 —");
  expect(actualize).toContain("confirm it is still being worked on");
  expect(actualize).toContain("task_done and evidence");
  expect(parseNotice(text)?.kind).toBe("idle");
});

test("a stale working task nudges even when there is no new work", () => {
  const stale = workingTask("w1", "Still marked working");
  const nudge = new IdleNudge(1_000, 0, "");
  const text =
    nudge.maybeNudge(
      { ...nothing, openTaskIds: [], workingTaskIds: [], staleTasks: [stale] },
      now,
    ) ?? "";
  expect(text.startsWith("You have been idle for 20 minutes. Actualize these tasks.")).toBe(true);
  expect(text).toContain("w1 — Still marked working");
  const notice = parseNotice(text);
  expect(notice?.kind).toBe("idle");
  expect(notice?.kind === "idle" ? notice.taskIds.join(",") : "").toBe("w1");
});

test("an unchanged new-work and actualize set stays silent", () => {
  const open = { id: "o1", title: "New work", status: "open" as const, blockedBy: [] };
  const stale = workingTask("w1", "Still marked working");
  const state = { ...nothing, tasks: [open, stale] };
  const nudge = new IdleNudge(1_000, 0, "");

  const first = nudge.maybeNudge(state, now) ?? "";
  expect(first).toContain("open: o1");
  expect(first).toContain("Actualize these tasks");
  expect(nudge.nudgedHash).toBe(taskSetHash(["o1", "w1"]));

  nudge.noteActivity(now + 1);
  expect(nudge.maybeNudge(state, now + 2_000)).toBeNull();
});

test("no tasks at all still means no nudge", () => {
  const quiet = new IdleNudge(1_000, 0, "");
  expect(quiet.maybeNudge({ ...nothing }, now)).toBeNull();
  expect(
    quiet.maybeNudge({ ...nothing, tasks: [{ id: "d1", status: "done" as const }] }, now),
  ).toBeNull();
});

test("the protocol still names new work and stays empty without tasks", () => {
  expect(idleNudgeText(["a1"])).toContain("task(s) are open: a1");
  expect(idleNudgeText([])).toContain("0 task(s) are open");
});

function closedTask(id: string, title: string, at: string) {
  return {
    id,
    title,
    status: "done" as const,
    blockedBy: [],
    completedAt: at,
    lastWorkedAt: null,
  };
}

test("a closure since the last nudge asks for a memory write", () => {
  const closed = closedTask("d1", "Ship the ledger", new Date(now - 30 * 60_000).toISOString());
  const nudge = new IdleNudge(1_000, now - 2 * hour, "");
  const text = nudge.maybeNudge({ ...nothing, tasks: [closed] }, now) ?? "";

  expect(text).toContain(
    'You closed d1 "Ship the ledger" since the last nudge and have not written anything durable about it.',
  );
  expect(text).toContain("memory_write (long_term for the topic, daily for the log)");
  const notice = parseNotice(text);
  expect(notice?.kind).toBe("idle");
  expect(notice?.kind === "idle" ? notice.taskIds : []).toEqual(["d1"]);
  expect(notice?.kind === "idle" ? notice.closed : false).toBe(true);
  expect(nudge.nudgedHash).toBe(taskSetHash(["d1"]));
});

test("the same closure on the next tick stays silent", () => {
  const open = { id: "o1", title: "New work", status: "open" as const, blockedBy: [] };
  const closed = closedTask("d1", "Ship the ledger", new Date(now - 30 * 60_000).toISOString());
  const state = { ...nothing, tasks: [open, closed] };
  const nudge = new IdleNudge(1_000, now - 2 * hour, "");

  const first = nudge.maybeNudge(state, now) ?? "";
  expect(first).toContain("open: o1");
  expect(first).toContain('You closed d1 "Ship the ledger"');

  nudge.noteActivity(now + 1);
  expect(nudge.maybeNudge(state, now + 2_000)).toBeNull();
});

test("a failed closure-only submission is retried after re-arming", () => {
  const closed = closedTask("d1", "Ship the ledger", new Date(now - 30 * 60_000).toISOString());
  const state = { ...nothing, tasks: [closed] };
  const nudge = new IdleNudge(1_000, now - 2 * hour, "");

  expect(nudge.maybeNudge(state, now)).toContain('You closed d1 "Ship the ledger"');
  nudge.forgetNudge();
  nudge.noteActivity(now);

  const retry = nudge.maybeNudge(state, now + 2_000) ?? "";
  expect(retry).toContain('You closed d1 "Ship the ledger"');
  expect(nudge.nudgedHash).toBe(taskSetHash(["d1"]));
});

test("a closure during a run is asked after the run even without an earlier nudge", () => {
  const closed = closedTask("d1", "Ship the ledger", new Date(now - hour).toISOString());
  const nudge = new IdleNudge(1_000, now - 2 * hour, "");

  // The run ends after the closure and re-arms the nudge; the closure stays behind
  // the stable watermark instead of being lost with the activity timestamp.
  nudge.noteActivity(now);
  const text = nudge.maybeNudge({ ...nothing, tasks: [closed] }, now + 2_000) ?? "";

  expect(text).toContain('You closed d1 "Ship the ledger"');
});

test("a memory write after the closure drops the memory paragraph", () => {
  const open = { id: "o1", title: "New work", status: "open" as const, blockedBy: [] };
  const closed = closedTask("d1", "Ship the ledger", new Date(now - hour).toISOString());
  const tracker = new TaskActivityTracker(undefined, () => now);
  tracker.toolStarted("memory_write", { target: "daily", body: "the ledger closes cleanly" });

  const nudge = new IdleNudge(1_000, now - 2 * hour, "");
  const text =
    nudge.maybeNudge({ ...nothing, tasks: [open, closed], activity: tracker.view() }, now) ?? "";

  expect(text).toContain("open: o1");
  expect(text).not.toContain("You closed");
  expect(text).not.toContain("memory_write (long_term");
});

test("without a closure the memory paragraph never appears", () => {
  const open = { id: "o1", title: "New work", status: "open" as const, blockedBy: [] };
  const stale = workingTask("w1", "Still marked working");
  const nudge = new IdleNudge(1_000, now - 2 * hour, "");
  const text = nudge.maybeNudge({ ...nothing, tasks: [open, stale] }, now) ?? "";

  expect(text).toContain("open: o1");
  expect(text).toContain("Actualize these tasks");
  expect(text).not.toContain("You closed");
  expect(text).not.toContain("memory_write (long_term");
});
