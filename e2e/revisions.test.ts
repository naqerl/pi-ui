import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptDeltaRevision,
  adoptSnapshotRevision,
  resetStreamRevisions,
} from "../src/shared/revisions.js";

test("a restarted server's lower snapshot counter lets its deltas through", () => {
  const restarted = resetStreamRevisions();
  assert.deepEqual(restarted, { draft: 0, tools: 0 });

  // The page held 9000 from the previous process; the snapshot says 2.
  const adopted = adoptSnapshotRevision(9000, 2);
  assert.equal(adopted, 2);
  assert.equal(acceptDeltaRevision(adopted, 3), 3);
  assert.equal(acceptDeltaRevision(adopted, undefined), 2);
});

test("matching counters still enforce delta ordering", () => {
  const current = adoptSnapshotRevision(2, 2);
  assert.equal(current, 2);
  assert.equal(acceptDeltaRevision(current, 2), 2);
  assert.equal(acceptDeltaRevision(current, 3), 3);
  assert.equal(acceptDeltaRevision(current, 1), null);
});
