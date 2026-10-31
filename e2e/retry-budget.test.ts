import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RETRY_BASE_DELAY_MS,
  RETRY_BUDGET_MS,
  RETRY_MAX,
  RETRY_MAX_DELAY_MS,
  retryBudgetExhausted,
  retryBudgetMs,
  retryGiveUpMessage,
  retrySettings,
  retrySpentMs,
} from "../src/server/retry.js";

test("the policy is three attempts with a short capped backoff", () => {
  assert.deepEqual(retrySettings({}), {
    enabled: true,
    maxRetries: RETRY_MAX,
    baseDelayMs: RETRY_BASE_DELAY_MS,
    maxAgentDelayMs: RETRY_MAX_DELAY_MS,
  });
  assert.equal(RETRY_MAX, 2, "maxRetries counts retries after the first attempt");
  assert.ok(RETRY_MAX_DELAY_MS <= 5_000, "a retry wait must not reach a minute");
});

test("environment variables override the policy, and junk keeps the default", () => {
  const custom = retrySettings({
    PI_RETRY_MAX: "5",
    PI_RETRY_BASE_MS: "250",
    PI_RETRY_MAX_DELAY_MS: "1000",
  });
  assert.deepEqual(custom, {
    enabled: true,
    maxRetries: 5,
    baseDelayMs: 250,
    maxAgentDelayMs: 1_000,
  });

  for (const junk of ["", "0", "-3", "abc", "1.5"]) {
    const settings = retrySettings({ PI_RETRY_MAX: junk, PI_RETRY_BASE_MS: junk });
    assert.equal(settings.maxRetries, RETRY_MAX, `PI_RETRY_MAX=${JSON.stringify(junk)}`);
    assert.equal(settings.baseDelayMs, RETRY_BASE_DELAY_MS);
  }
});

test("the retry budget defaults to two and a half minutes", () => {
  assert.equal(retryBudgetMs({}), RETRY_BUDGET_MS);
  assert.equal(RETRY_BUDGET_MS, 150_000);
  assert.equal(retryBudgetMs({ PI_RETRY_BUDGET_MS: "5000" }), 5_000);
  assert.equal(retryBudgetMs({ PI_RETRY_BUDGET_MS: "soon" }), RETRY_BUDGET_MS);
});

test("an episode with no retry yet has spent nothing", () => {
  assert.equal(retrySpentMs(undefined, 1_000), 0);
  assert.equal(retryBudgetExhausted(undefined, 10_000_000), false);
});

test("the budget trips at the boundary, not before", () => {
  const start = 1_000;
  assert.equal(retrySpentMs(start, 31_000), 30_000);
  assert.equal(retryBudgetExhausted(start, start + 149_999, 150_000), false);
  assert.equal(retryBudgetExhausted(start, start + 150_000, 150_000), true);
  assert.equal(retryBudgetExhausted(start, start + 400_000, 150_000), true);
});

test("a clock that moves backwards spends nothing, not a negative budget", () => {
  assert.equal(retrySpentMs(5_000, 1_000), 0);
});

test("the chat line names the retries and says the queue moves on", () => {
  const one = retryGiveUpMessage(1, 4_400);
  assert.match(one, /1 retry over 4s/);
  assert.match(one, /next queued message runs now/);

  const many = retryGiveUpMessage(3, 150_000);
  assert.match(many, /3 retries over 150s/);
  assert.match(retryGiveUpMessage(2, 200), /over 1s/, "a sub-second spend still reads as 1s");
});
