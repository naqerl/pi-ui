import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cancelSteer,
  consumeSteer,
  consumeSteersInMessages,
  contentText,
  droppedSteerMessage,
  dropSteer,
  mergeLiveSteers,
  PENDING_STEER_ORDER,
  type PendingSteer,
  pendingSteerMessage,
  rebuildSteersFromSnapshot,
  settledSteerIds,
  steerDropReason,
  steerFromInboxItem,
  steerKeyFromEntryData,
} from "../src/shared/steers.js";
import type { ChatMessage } from "../src/shared/types.js";

const steer = (id: string, key = `key-${id}`): PendingSteer => ({
  id,
  key,
  text: `steer ${id}`,
  createdAt: "2026-10-30T03:00:00.000Z",
});

test("a pending steer renders after the run's live work, marked pending", () => {
  const message = pendingSteerMessage({
    ...steer("7"),
    attachments: ["abc.png"],
  });
  assert.equal(message.id, "steer-pending-7");
  assert.equal(message.role, "user");
  assert.equal(message.steer, true);
  assert.equal(message.pendingSteer, true);
  assert.equal(message.steerKey, "key-7");
  assert.equal(message.order, PENDING_STEER_ORDER);
  // Drafts sit at MAX_SAFE_INTEGER - 2 and - 3; a pending steer must not land above them.
  assert.ok(message.order > Number.MAX_SAFE_INTEGER - 2);
  assert.deepEqual(message.attachments, [{ id: "abc.png", mimeType: "image/*" }]);
  assert.equal(pendingSteerMessage({ id: "8", text: "x", createdAt: "" }).attachments, undefined);
});

test("pending becomes consumed when the transcript entry with its key arrives", () => {
  const before = [steer("1"), steer("2")];
  const after = consumeSteer(before, "key-1", "1");
  assert.deepEqual(
    after.map((item) => item.id),
    ["2"],
  );
  // The real entry carries the same key, so the same update can append it.
  assert.equal(steerKeyFromEntryData({ key: "key-1" }), "key-1");
  assert.equal(steerKeyFromEntryData({}), undefined);
  assert.equal(steerKeyFromEntryData(undefined), undefined);
});

test("pending becomes dropped with a visible reason, and stays failed across live updates", () => {
  const reason = steerDropReason("aborted");
  const dropped = dropSteer([steer("1")], "1", reason);
  assert.equal(dropped[0]?.dropped, "The run stopped before the steer was delivered.");

  const failed = droppedSteerMessage(dropped[0] as PendingSteer, reason);
  assert.equal(failed.id, "steer-dropped-1");
  assert.equal(failed.steer, true);
  assert.equal(failed.isError, true);
  assert.equal(failed.pendingSteer, undefined);
  assert.equal(failed.steerError, reason);

  // A run-state update no longer lists it; the failed bubble must not disappear.
  const live = mergeLiveSteers(dropped, []);
  assert.equal(live.length, 1);
  assert.equal(live[0]?.dropped, reason);
  // A later snapshot without it keeps the reported failure until reload.
  const reloaded = rebuildSteersFromSnapshot(live, []);
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0]?.dropped, reason);
});

test("a cancelled pending steer leaves no residue", () => {
  const before = [steer("1"), steer("2")];
  assert.deepEqual(
    cancelSteer(before, "2").map((item) => item.id),
    ["1"],
  );
  assert.deepEqual(cancelSteer([steer("1")], "1"), []);
  // The server's next run-state update is authoritative for a cancellation made elsewhere.
  assert.deepEqual(
    mergeLiveSteers(before, [steer("1")]).map((item) => item.id),
    ["1"],
  );
});

test("a restart restores a pending steer from the inbox entry data", () => {
  const now = new Date("2026-10-30T04:00:00.000Z");
  const restored = steerFromInboxItem(
    {
      id: 12,
      mode: "steer",
      content: "look at the tests too",
      entry: {
        kind: "ui.steer",
        data: { key: "restored-key", createdAt: "2026-10-30T03:59:00.000Z" },
      },
    },
    now,
  );
  assert.deepEqual(restored, {
    id: "12",
    text: "look at the tests too",
    createdAt: "2026-10-30T03:59:00.000Z",
    key: "restored-key",
  });
  assert.equal(steerFromInboxItem({ id: 13, mode: "followUp", content: "x" }, now), undefined);
  assert.equal(
    steerFromInboxItem({ id: 14, mode: "steer", content: "x", entry: { data: {} } }, now)
      ?.createdAt,
    now.toISOString(),
  );
});

test("a snapshot message clears a failed steer that was actually delivered", () => {
  const failed = { ...steer("1"), dropped: "The connection closed." };
  const messages: ChatMessage[] = [
    {
      id: "m-1",
      role: "user",
      text: "steer 1",
      timestamp: "2026-10-30T03:00:00.000Z",
      order: 10_000,
      steer: true,
      steerKey: "key-1",
    },
  ];
  const remaining = consumeSteersInMessages([failed, steer("2")], messages);
  assert.deepEqual(
    remaining.map((item) => item.id),
    ["2"],
  );
});

test("a reload rebuilds the pending list from the server snapshot", () => {
  const current = [steer("1"), { ...steer("2"), dropped: "The run stopped." }];
  const snapshot = [steer("3"), steer("4")];
  const rebuilt = rebuildSteersFromSnapshot(current, snapshot);
  assert.deepEqual(
    rebuilt.map((item) => [item.id, item.dropped]),
    [
      ["3", undefined],
      ["4", undefined],
      ["2", "The run stopped."],
    ],
  );

  // A live update adds a steer from another tab without dropping one still waiting here.
  const live = mergeLiveSteers([steer("5")], [steer("5"), steer("6")]);
  assert.deepEqual(
    live.map((item) => item.id),
    ["5", "6"],
  );
});

test("steers durable no longer holds are settled; follow-ups do not keep a steer", () => {
  const inbox = [
    { id: 2, mode: "steer" },
    { id: 3, mode: "followUp" },
  ];
  assert.deepEqual(settledSteerIds(["1", "2", "3"], inbox), ["1", "3"]);
  assert.deepEqual(settledSteerIds(["2"], inbox), []);
  assert.deepEqual(settledSteerIds([], []), []);
});

test("content text reads strings and text parts", () => {
  assert.equal(contentText("hi"), "hi");
  assert.equal(
    contentText([
      { type: "text", text: "a" },
      { type: "image", data: "…" },
      { type: "text", text: "b" },
    ]),
    "a\nb",
  );
  assert.equal(contentText(undefined), "");
});
