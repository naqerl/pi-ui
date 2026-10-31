import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { computeTestEnv } from "../scripts/run-tests.mjs";
import { liveDataDirInTestError } from "../src/server/test-mode.js";

test("the test runner isolates DATA_DIR", () => {
  const root = join(tmpdir(), "pi-ui-tests-fixture");
  const env = computeTestEnv(root, {
    DATA_DIR: "/workspace/data",
    PI_MEMORY_DIR: "/home/pi/.pi/agent/memory",
    XDG_DATA_HOME: "/home/pi/.local/share",
    NODE_ENV: "production",
  });

  assert.equal(env.NODE_ENV, "test");
  assert.equal(env.DATA_DIR, join(root, "data"));
  assert.equal(env.PI_MEMORY_DIR, join(root, "memory"));
  for (const key of [
    "DATA_DIR",
    "PI_MEMORY_DIR",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "XDG_CONFIG_HOME",
  ]) {
    assert.ok(env[key]?.startsWith(`${root}/`), `${key} is under the run root`);
  }
});

test("the server refuses a live data dir in test mode", () => {
  const live = "/workspace/data";
  const message = liveDataDirInTestError(live, { NODE_ENV: "test" });
  assert.ok(message !== null);
  assert.match(message, /\/workspace\/data/);
  assert.equal(
    liveDataDirInTestError(join(tmpdir(), "pi-ui-tests-ok"), { NODE_ENV: "test" }),
    null,
  );
  assert.equal(liveDataDirInTestError(live, { NODE_ENV: "production" }), null);
});
