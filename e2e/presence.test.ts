import assert from "node:assert/strict";
import { test } from "node:test";
import { presenceExitMs, presenceReducer, unmountPresence } from "../src/client/use-presence.js";

test("a present dock switch mounts open", () => {
  assert.deepEqual(presenceReducer({ mounted: false, open: false }, true), {
    mounted: true,
    open: true,
  });
});

test("an absent switch keeps its node mounted while it closes", () => {
  const closed = presenceReducer({ mounted: true, open: true }, false);
  assert.deepEqual(closed, { mounted: true, open: false });
  assert.equal(presenceReducer(closed, false), closed);
});

test("the exit timer is the only step that unmounts the closed node", () => {
  const closed = presenceReducer({ mounted: true, open: true }, false);
  assert.deepEqual(unmountPresence(closed), { mounted: false, open: false });
  assert.deepEqual(unmountPresence({ mounted: true, open: true }), {
    mounted: true,
    open: true,
  });
});

test("reduced motion removes the exit wait instead of shortening it", () => {
  assert.equal(presenceExitMs(160, false), 160);
  assert.equal(presenceExitMs(160, true), 0);
});
