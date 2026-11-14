import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  PLAN_TURN_PUSH_TITLE,
  PLAN_TURN_PUSH_WINDOW_MS,
  PlanTurnNotifier,
  planTurnNotification,
} from "../src/server/plan-push.js";
import type { PushNotification } from "../src/server/push.js";
import { RunErrorNotifier } from "../src/server/run-push.js";
import { DurableTaskAgentSession } from "../src/server/task-agent.js";
import { TaskStore } from "../src/server/tasks.js";
import { taskDeepLinkFromLocation, taskPlanUrl } from "../src/shared/pages.js";

async function tempStore(t: {
  after: (fn: () => Promise<void>) => void;
}): Promise<{ store: TaskStore; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "pi-ui-plan-push-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const store = new TaskStore(join(dir, "tasks.json"));
  await store.load();
  return { store, dir };
}

test("a plan push names the task and opens its plan chat", () => {
  const notification = planTurnNotification({ id: "abcd", title: "Design the inbox" });
  assert.equal(notification.title, PLAN_TURN_PUSH_TITLE);
  assert.equal(notification.body, "abcd Design the inbox");
  assert.equal(notification.tag, "plan-abcd");
  assert.equal(notification.url, taskPlanUrl("abcd"));
  assert.match(String(notification.url), /\/#\/tasks\/abcd\?tab=plan$/);
  assert.deepEqual(taskDeepLinkFromLocation(String(notification.url)), {
    id: "abcd",
    tab: "plan",
  });
  assert.deepEqual(taskDeepLinkFromLocation("/tasks/abcd?tab=plan"), {
    id: "abcd",
    tab: "plan",
  });
});

test("finished turns for one task coalesce, while another task still notifies", async (t) => {
  const { store } = await tempStore(t);
  const first = (await store.create("Design the inbox", null)).tasks.find(
    (item) => item.title === "Design the inbox",
  );
  const second = (await store.create("Review the outbox", null)).tasks.find(
    (item) => item.title === "Review the outbox",
  );
  assert.ok(first && second);
  const sent: PushNotification[] = [];
  let now = 1_000;
  const notifier = new PlanTurnNotifier(store, {
    now: () => now,
    windowMs: PLAN_TURN_PUSH_WINDOW_MS,
    notify: (notification) => {
      sent.push(notification);
    },
  });

  assert.equal(await notifier.notifyTurn(first.id), true);
  now += 1_000;
  assert.equal(await notifier.notifyTurn(first.id), false);
  now += 1_000;
  assert.equal(await notifier.notifyTurn(first.id), false);
  assert.equal(await notifier.notifyTurn(second.id), true);
  assert.equal(sent.length, 2);
  assert.match(String(sent[0]?.body), new RegExp(first.id));
  assert.match(String(sent[0]?.body), /Design the inbox/);
  assert.match(String(sent[0]?.url), new RegExp(first.id));

  // Once the window passes, the next finished turn announces again.
  now += PLAN_TURN_PUSH_WINDOW_MS;
  assert.equal(await notifier.notifyTurn(first.id), true);
  assert.equal(sent.length, 3);
});

test("a zero window keeps one push per finished turn", async (t) => {
  const { store } = await tempStore(t);
  const task = (await store.create("Every turn counts", null)).tasks[0];
  assert.ok(task);
  const sent: PushNotification[] = [];
  const notifier = new PlanTurnNotifier(store, {
    windowMs: 0,
    notify: (notification) => {
      sent.push(notification);
    },
  });
  assert.equal(await notifier.notifyTurn(task.id), true);
  assert.equal(await notifier.notifyTurn(task.id), true);
  assert.equal(sent.length, 2);
});

type Settlement = {
  type: "input";
  status: "done" | "unanswered";
  reason?: string;
  detail?: unknown;
};

class FakeConversation {
  private calls = 0;

  constructor(private readonly settlements: Settlement[]) {}

  async submit() {
    this.calls += 1;
    const id = this.calls;
    const settlement = this.settlements[id - 1] ?? {
      type: "input" as const,
      status: "done" as const,
    };
    return {
      id,
      wait: async () => ({ ...settlement, id }),
    };
  }

  async context() {
    return { entries: [], docs: {} };
  }
}

async function settledTurn(settlement: Settlement): Promise<number> {
  let finished = 0;
  const session = new DurableTaskAgentSession(
    "taskplan",
    {} as never,
    new FakeConversation([settlement]) as never,
    undefined,
    undefined,
    undefined,
    undefined,
    () => {
      finished += 1;
    },
  );
  await session.submit("draft the plan");
  for (let attempt = 0; attempt < 100 && finished === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return finished;
}

test("a failed plan run pushes the task id and opens that task's plan chat", async () => {
  const sent: PushNotification[] = [];
  const notifier = new RunErrorNotifier({ notify: (notification) => sent.push(notification) });
  const session = new DurableTaskAgentSession(
    "taskplan",
    {} as never,
    new FakeConversation([
      {
        type: "input",
        status: "unanswered",
        reason: "model_error",
        detail: "the planning provider refused the request",
      },
    ]) as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async (input) => {
      await notifier.deliver(input);
    },
  );
  await session.submit("draft the plan");
  for (let attempt = 0; attempt < 100 && sent.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.title, "Turn failed in the plan chat for taskplan");
  assert.equal(sent[0]?.body, "the planning provider refused the request");
  assert.equal(sent[0]?.url, taskPlanUrl("taskplan"));
  assert.deepEqual(sent[0]?.data, { taskId: "taskplan", tab: "plan" });

  // The same failure id does not ring a second time.
  await session.submit("retry");
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(sent.length, 1);
});

test("only a successful plan run announces its turn", async () => {
  assert.equal(await settledTurn({ type: "input", status: "done" }), 1);
  assert.equal(
    await settledTurn({ type: "input", status: "unanswered", reason: "model_error" }),
    0,
  );
  assert.equal(await settledTurn({ type: "input", status: "unanswered", reason: "aborted" }), 0);
});
