import assert from "node:assert/strict";
import { test } from "node:test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NoticeLine } from "../src/client/NoticeView.js";
import { ChatService } from "../src/server/chat-service.js";
import { buildTranscript, IDLE_NUDGE_ENTRY_KIND } from "../src/server/session.js";
import {
  DEFAULT_IDLE_NUDGE_MS,
  IdleNudge,
  idleNudgeMs,
  idleNudgeText,
  openTaskIds,
} from "../src/shared/idle-nudge.js";
import { parseNotice } from "../src/shared/notices.js";

const nothing = { active: false, queued: 0, openTaskIds: [] as string[] };

test("the idle window defaults to twenty minutes and zero disables it", () => {
  assert.equal(DEFAULT_IDLE_NUDGE_MS, 1_200_000);
  assert.equal(idleNudgeMs({}), DEFAULT_IDLE_NUDGE_MS);
  assert.equal(idleNudgeMs({ PI_IDLE_NUDGE_MS: "" }), DEFAULT_IDLE_NUDGE_MS);
  assert.equal(idleNudgeMs({ PI_IDLE_NUDGE_MS: "2500" }), 2_500);
  assert.equal(idleNudgeMs({ PI_IDLE_NUDGE_MS: "0" }), 0);
  assert.equal(idleNudgeMs({ PI_IDLE_NUDGE_MS: "soon" }), DEFAULT_IDLE_NUDGE_MS);
  assert.equal(idleNudgeMs({ PI_IDLE_NUDGE_MS: "-1" }), DEFAULT_IDLE_NUDGE_MS);

  const disabled = new IdleNudge(0, 0);
  assert.equal(disabled.enabled, false);
  assert.equal(disabled.maybeNudge({ ...nothing, openTaskIds: ["a"] }, 10_000_000), null);
});

test("the prompt names the count and ids, and only open tasks count", () => {
  const tasks = [
    { id: "a1", status: "open" as const },
    { id: "p1", status: "proposed" as const },
    { id: "d1", status: "done" as const },
    { id: "b2", status: "open" as const },
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

test("it fires once after the window, then waits for fresh activity", () => {
  const nudge = new IdleNudge(1_000, 0);
  const work = { ...nothing, openTaskIds: ["a1"] };
  assert.equal(nudge.maybeNudge(work, 999), null);
  assert.equal(
    nudge.maybeNudge(work, 1_000),
    "You have been idle for 20 minutes and 1 task(s) are open: a1. Pick the next one and implement it.",
  );
  assert.equal(nudge.maybeNudge(work, 20_000), null, "the same idle period does not nudge twice");

  nudge.noteActivity(20_000);
  assert.equal(nudge.maybeNudge(work, 20_999), null);
  assert.ok(nudge.maybeNudge(work, 21_000), "a user message, steer or run start re-arms it");
});

test("it never fires while running, queued, or with no open task", () => {
  const nudge = new IdleNudge(1_000, 0);
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

test("the nudge's own run re-arms, so a second idle window fires again", async () => {
  const previous = process.env.PI_IDLE_NUDGE_MS;
  process.env.PI_IDLE_NUDGE_MS = "1000";
  try {
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
      () => ["a1"],
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
    (driven.idleNudge as unknown as { lastActivityAt: number }).lastActivityAt = Date.now() - 1_001;
    await driven.checkIdleNudge();
    assert.equal(seen.length, 2, "a second idle window after the nudge's run fires again");
    assert.match(seen[1]?.text ?? "", /^You have been idle for 20 minutes/);
  } finally {
    if (previous === undefined) delete process.env.PI_IDLE_NUDGE_MS;
    else process.env.PI_IDLE_NUDGE_MS = previous;
  }
});
