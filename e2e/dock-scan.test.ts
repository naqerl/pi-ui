import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DOCK_SCAN_ENTER_MS,
  DOCK_SCAN_IN_MS,
  DOCK_SCAN_OUT_MS,
  DOCK_SCAN_STAGGER_MS,
  DOCK_SCAN_SWAP_MS,
  type DockView,
  dockScanKey,
  dockScanReducer,
} from "../src/client/use-dock-scan.js";

const view = (patch: Partial<DockView> = {}): DockView => ({
  surface: "tasks",
  plan: true,
  word: null,
  running: false,
  quiet: true,
  jobs: false,
  hidden: false,
  ...patch,
});

test("the sweep constants match the 12 ms stagger", () => {
  assert.equal(DOCK_SCAN_STAGGER_MS, 12);
  assert.equal(DOCK_SCAN_OUT_MS, 90);
  assert.equal(DOCK_SCAN_IN_MS, 110);
  assert.equal(DOCK_SCAN_SWAP_MS, 126);
  assert.equal(DOCK_SCAN_ENTER_MS, 146);
});

test("only a surface or collapse change starts a sweep", () => {
  const base = view();
  assert.equal(dockScanKey(base), "tasks:shown");
  assert.equal(dockScanKey(view({ word: "working", running: true })), "tasks:shown");
  assert.equal(dockScanKey(view({ quiet: false })), "tasks:shown");
  assert.equal(dockScanKey(view({ jobs: true })), "tasks:shown");
  assert.equal(dockScanKey(view({ plan: false })), "tasks:shown");
  assert.equal(dockScanKey(view({ surface: "chat" })), "chat:shown");
  assert.equal(dockScanKey(view({ hidden: true })), "tasks:hidden");
});

test("a swipe back before the swap settles without ever entering", () => {
  const frozen = dockScanReducer(
    { view: view(), phase: "settled", revision: 0 },
    {
      type: "exit",
      view: view(),
    },
  );
  assert.equal(frozen.phase, "exit");
  const back = dockScanReducer(frozen, { type: "swap", view: view() });
  assert.deepEqual(back, { view: view(), phase: "settled", revision: 2 });
});

test("a key change during the enter leg restarts the exit", () => {
  const exiting = dockScanReducer(
    { view: view(), phase: "settled", revision: 0 },
    {
      type: "exit",
      view: view(),
    },
  );
  const entering = dockScanReducer(exiting, {
    type: "swap",
    view: view({ surface: "chat" }),
  });
  assert.equal(entering.phase, "enter");
  const restarted = dockScanReducer(entering, {
    type: "exit",
    view: entering.view,
  });
  assert.deepEqual(restarted, {
    view: view({ surface: "chat" }),
    phase: "exit",
    revision: entering.revision + 1,
  });
});

test("the enter leg settles on the swapped view", () => {
  const entering = {
    view: view({ surface: "chat" }),
    phase: "enter" as const,
    revision: 5,
  };
  assert.deepEqual(dockScanReducer(entering, { type: "settle" }), {
    view: entering.view,
    phase: "settled",
    revision: entering.revision + 1,
  });
  const settled = { view: entering.view, phase: "settled" as const, revision: 6 };
  assert.equal(dockScanReducer(settled, { type: "settle" }), settled);
});

test("a snap is only a no-op when it is already settled on the same view", () => {
  const settled = { view: view(), phase: "settled" as const, revision: 0 };
  assert.equal(dockScanReducer(settled, { type: "snap", view: view() }), settled);
  const next = view({ hidden: true });
  assert.deepEqual(dockScanReducer(settled, { type: "snap", view: next }), {
    view: next,
    phase: "settled",
    revision: 1,
  });
});
