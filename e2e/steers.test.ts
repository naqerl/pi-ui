import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contentText,
  PENDING_STEER_ORDER,
  pendingSteerMessage,
  settledSteerIds,
} from "../src/shared/steers.js";

test("a pending steer renders after the run's live work, marked pending", () => {
  const message = pendingSteerMessage({
    id: "7",
    text: "look at the tests too",
    createdAt: "2026-10-30T03:00:00.000Z",
    attachments: ["abc.png"],
  });
  assert.equal(message.id, "steer-pending-7");
  assert.equal(message.role, "user");
  assert.equal(message.steer, true);
  assert.equal(message.pendingSteer, true);
  assert.equal(message.order, PENDING_STEER_ORDER);
  // Drafts sit at MAX_SAFE_INTEGER - 2 and - 3; a pending steer must not land above them.
  assert.ok(message.order > Number.MAX_SAFE_INTEGER - 2);
  assert.deepEqual(message.attachments, [{ id: "abc.png", mimeType: "image/*" }]);
  assert.equal(pendingSteerMessage({ id: "8", text: "x", createdAt: "" }).attachments, undefined);
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
