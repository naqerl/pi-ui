import assert from "node:assert/strict";
import { test } from "node:test";
import * as runHealth from "../src/shared/run-health.js";

const { reconcileRunState } = runHealth;

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

test("the working strip has no elapsed-time helpers to feed a clock", () => {
  assert.equal("workingDetails" in runHealth, false);
  assert.equal("clockText" in runHealth, false);
  assert.ok(runHealth.QUIET_AFTER_MS > 0);
});
