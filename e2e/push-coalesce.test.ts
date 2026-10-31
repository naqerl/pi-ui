import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ALLOW_REAL_PUSH_ENV,
  type PushNotification,
  TEST_PUSH_HOSTS,
  testPushGuardError,
} from "../src/server/push.js";
import { TaskStore } from "../src/server/tasks.js";

const RATIONALE = "This is worth doing because it removes repeated manual cleanup work.";

async function temporaryStore(
  t: { after: (fn: () => Promise<void>) => void },
  options: {
    readonly windowMs?: number;
    readonly notify?: (notification: PushNotification) => void;
  } = {},
): Promise<{ store: TaskStore; sent: PushNotification[] }> {
  const directory = await mkdtemp(join(tmpdir(), "pi-ui-push-coalesce-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const sent: PushNotification[] = [];
  const store = new TaskStore(join(directory, "tasks.json"), {
    notify: (notification) => {
      sent.push(notification);
      options.notify?.(notification);
    },
    pushWindowMs: options.windowMs ?? 150,
  });
  await store.load();
  return { store, sent };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("one task change pushes immediately", async (t) => {
  const { store, sent } = await temporaryStore(t);
  const task = (await store.create("Ship the modal", null)).tasks[0];
  assert.ok(task);

  const ledger = await store.update(task.id, { status: "done" });
  assert.equal(ledger.tasks.find((item) => item.id === task.id)?.status, "done");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.title, "Task done");
  assert.equal(sent[0]?.body, "Ship the modal");
  assert.equal(sent[0]?.tag, task.id);
});

test("three changes in one burst push once", async (t) => {
  const { store, sent } = await temporaryStore(t);
  await Promise.all([
    store.propose("Alpha", RATIONALE),
    store.propose("Beta", RATIONALE),
    store.propose("Gamma", RATIONALE),
  ]);

  await wait(250);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.title, "3 tasks updated");
  assert.equal(sent[0]?.tag, "ledger");
  assert.match(sent[0]?.body ?? "", /New proposal: Alpha/);
  assert.match(sent[0]?.body ?? "", /New proposal: Gamma/);
});

test("a burst summary lists each task once with its final status", async (t) => {
  const { store, sent } = await temporaryStore(t);
  const [otherLedger, tidyLedger] = await Promise.all([
    store.propose("Other work", RATIONALE),
    store.propose("Tidy the ledger", RATIONALE),
  ]);
  assert.ok(otherLedger.tasks.some((task) => task.title === "Other work"));
  const tidy = tidyLedger.tasks.find((task) => task.title === "Tidy the ledger");
  assert.ok(tidy);

  await store.update(tidy.id, { status: "open" });
  await store.update(tidy.id, { status: "done" });
  await wait(250);

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.title, "2 tasks updated");
  const body = sent[0]?.body ?? "";
  assert.equal(body.match(/Tidy the ledger/g)?.length, 1);
  assert.match(body, /Task done: Tidy the ledger/);
  assert.doesNotMatch(body, /New proposal: Tidy the ledger/);
  assert.match(body, /New proposal: Other work/);
});

test("a failing push does not fail the task write", async (t) => {
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    const { store } = await temporaryStore(t, {
      notify: () => {
        throw new Error("push endpoint unavailable");
      },
    });
    const task = (await store.create("Close despite the push", null)).tasks[0];
    assert.ok(task);

    const ledger = await store.update(task.id, { status: "done" });
    assert.equal(ledger.tasks.find((item) => item.id === task.id)?.status, "done");
    assert.equal(errors.length, 1);
    assert.match(String(errors[0]?.[0]), /\[pi\] task push failed for/);
  } finally {
    console.error = original;
  }
});

test("a queued burst does not keep the process alive", async (t) => {
  const { store, sent } = await temporaryStore(t, { windowMs: 5_000 });
  await Promise.all([
    store.propose("Queued one", RATIONALE),
    store.propose("Queued two", RATIONALE),
  ]);

  const timer = (store as unknown as { flushTimer?: NodeJS.Timeout }).flushTimer;
  assert.ok(timer);
  assert.equal(timer.hasRef(), false);
  assert.equal(sent.length, 0);

  await store.close();
  assert.equal(sent.length, 1);
});

test("test mode still refuses a real push endpoint", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousAllow = process.env[ALLOW_REAL_PUSH_ENV];
  process.env.NODE_ENV = "test";
  delete process.env[ALLOW_REAL_PUSH_ENV];
  try {
    assert.match(
      testPushGuardError("https://fcm.googleapis.com/fcm/send/abc") ?? "",
      /fcm\.googleapis\.com/,
    );
    assert.equal(testPushGuardError(`https://${TEST_PUSH_HOSTS[0]}/one`), null);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousAllow === undefined) delete process.env[ALLOW_REAL_PUSH_ENV];
    else process.env[ALLOW_REAL_PUSH_ENV] = previousAllow;
  }
});
