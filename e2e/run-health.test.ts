import assert from "node:assert/strict";
import { test } from "node:test";
import { clockText, reconcileRunState, workingDetails } from "../src/shared/run-health.js";

const none = { run: false, inbox: 0, submitting: 0 };

test("a run durable finished becomes idle", () => {
  assert.equal(reconcileRunState("running", none), "idle");
});

test("a live run, queued input, or an unrecorded submission keeps running", () => {
  assert.equal(reconcileRunState("running", { ...none, run: true }), "running");
  assert.equal(reconcileRunState("running", { ...none, inbox: 1 }), "running");
  assert.equal(reconcileRunState("running", { ...none, submitting: 1 }), "running");
});

test("a live run the server missed shows as running", () => {
  assert.equal(reconcileRunState("idle", { ...none, run: true }), "running");
  assert.equal(reconcileRunState("interrupted", { ...none, run: true }), "running");
});

test("idle and interrupted stay put without a live run", () => {
  assert.equal(reconcileRunState("idle", { ...none, inbox: 2 }), "idle");
  assert.equal(reconcileRunState("interrupted", none), "interrupted");
});

test("clock text", () => {
  assert.equal(clockText(0), "0s");
  assert.equal(clockText(12_400), "12s");
  assert.equal(clockText(65_000), "1m 05s");
  assert.equal(clockText(3_720_000), "1h 02m");
});

test("working details show elapsed time, and quiet time past the threshold", () => {
  const start = "2026-10-30T00:00:00.000Z";
  const at = (seconds: number) => Date.parse(start) + seconds * 1_000;
  assert.deepEqual(workingDetails(start, start, at(12)), ["12s"]);
  assert.deepEqual(workingDetails(start, start, at(29)), ["29s"]);
  assert.deepEqual(workingDetails(start, start, at(95)), ["1m 35s", "no output for 1m 35s"]);
  assert.deepEqual(workingDetails(null, null, at(5)), []);
});
