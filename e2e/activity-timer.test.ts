import assert from "node:assert/strict";
import { test } from "node:test";
import { activitySummary, groupElapsedMs, groupSummary } from "../src/client/activity-format.js";
import type { ToolActivity } from "../src/shared/types.js";

const START = Date.parse("2026-11-01T12:00:00.000Z");

function at(offsetMs: number): string {
  return new Date(START + offsetMs).toISOString();
}

function tool(patch: Partial<ToolActivity> = {}): ToolActivity {
  return {
    kind: "tool",
    id: "live-call-1",
    name: "bash",
    arguments: '{"command":"sleep 16"}',
    isError: false,
    timestamp: at(0),
    order: 10_000,
    ...patch,
  };
}

test("a tool result replacing its live row does not reset the group clock", () => {
  const live = tool({ pending: true });
  assert.equal(groupSummary([live], true, START + 16_000), "1 tool call · 16.0s");

  // The result's timestamp is when the call ended, so its duration recovers the start.
  const result = tool({
    id: "a-1",
    timestamp: at(16_200),
    durationMs: 16_200,
    pending: false,
  });
  assert.equal(groupSummary([result], true, START + 16_400), "1 tool call · 16.4s");
  assert.equal(activitySummary(result), "bash · 16.2s · ok");
});

test("a reconnect repeating a row cannot move a running group's clock backwards", () => {
  let shown = groupElapsedMs([tool({ pending: true })], true, START + 16_000);
  assert.equal(shown, 16_000);

  // The replayed live row starts its timestamp over at the reconnect instant. Its raw
  // elapsed would be 0.1s; the clock keeps the highest value it already showed.
  const replayed = tool({ pending: true, timestamp: at(16_400) });
  const next = groupElapsedMs([replayed], true, START + 16_500, shown);
  assert.equal(next, shown);
  shown = next;

  // A later duplicate is anchored by the oldest known start, not the newest row.
  const withResult = [tool({ pending: true }), tool({ id: "a-1", timestamp: at(16_400) })];
  assert.equal(groupElapsedMs(withResult, true, START + 16_600, shown), 16_600);
});

test("a finished group settles on its real span and each row keeps its own duration", () => {
  const result = tool({ id: "a-1", timestamp: at(16_200), durationMs: 16_200 });
  assert.equal(groupElapsedMs([result], false, START + 30_000), 16_200);
  assert.equal(groupSummary([result], false, START + 30_000), "1 tool call · 16.2s");
  assert.equal(activitySummary(result), "bash · 16.2s · ok");
});
