import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import {
  createOperatorTools,
  NOTIFY_OPERATOR_RATE_LIMIT_MS,
  type OperatorBridge,
} from "../src/server/operator-tools.js";
import {
  configurePush,
  type PushNotification,
  resetPushServiceForTests,
} from "../src/server/push.js";
import type { OperatorNoticeRecord } from "../src/shared/notices.js";

function result(result: ToolExecutionResult): { text: string; isError: boolean } {
  const part = result.output?.find((item) => item.type === "text");
  return {
    text: part !== undefined && part.type === "text" ? part.text : "",
    isError: result.isError === true,
  };
}

function harness(
  options: { sent?: number; fail?: boolean; now?: () => number; rateLimitMs?: number } = {},
) {
  const pushes: PushNotification[] = [];
  const notices: OperatorNoticeRecord[] = [];
  const bridge: OperatorBridge = {
    notify(notification) {
      pushes.push(notification);
      if (options.fail === true) throw new Error("push service unavailable");
      return options.sent ?? 1;
    },
    recordNotice(record) {
      notices.push(record);
    },
  };
  const tool = createOperatorTools(bridge, {
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.rateLimitMs === undefined ? {} : { rateLimitMs: options.rateLimitMs }),
  })[0];
  assert.ok(tool);
  return {
    pushes,
    notices,
    call: (args: Record<string, unknown>) => tool.execute(args as never, {} as never, {} as never),
  };
}

const good = {
  title: "Deploy or wait?",
  body: "The release is ready; should I ship it now or wait for the review?",
  reason: "The release window closes in ten minutes.",
};

test("notify_operator sends the push and reports how many subscriptions received it", async () => {
  const { pushes, notices, call } = harness({ sent: 2 });
  const tool = result(await call(good));

  assert.equal(tool.isError, false);
  assert.equal(tool.text, "sent: 2");
  assert.deepEqual(pushes, [
    {
      title: good.title,
      body: good.body,
      tag: "notify-operator",
      url: "/chat",
      data: { reason: good.reason },
    },
  ]);
  assert.deepEqual(notices, [good]);
});

test("over-length or blank input is rejected before anything is sent", async () => {
  const { pushes, notices, call } = harness();

  const title = result(await call({ ...good, title: "x".repeat(61) }));
  assert.equal(title.isError, true);
  assert.match(title.text, /title/);
  assert.match(title.text, /60/);

  const body = result(await call({ ...good, body: "x".repeat(141) }));
  assert.equal(body.isError, true);
  assert.match(body.text, /body/);
  assert.match(body.text, /140/);

  const reason = result(await call({ ...good, reason: "x".repeat(201) }));
  assert.equal(reason.isError, true);
  assert.match(reason.text, /reason/);
  assert.match(reason.text, /200/);

  const blank = result(await call({ ...good, title: "   " }));
  assert.equal(blank.isError, true);
  assert.match(blank.text, /title/);

  assert.deepEqual(pushes, []);
  assert.deepEqual(notices, []);
});

test("one push per 30 seconds, and the suppressed call still succeeds", async () => {
  let time = 1_000_000;
  const { pushes, notices, call } = harness({ now: () => time });

  const first = result(await call(good));
  assert.equal(first.text, "sent: 1");
  time += NOTIFY_OPERATOR_RATE_LIMIT_MS - 1;
  const second = result(await call({ ...good, title: "Second request" }));
  assert.equal(second.isError, false);
  assert.equal(second.text, 'sent: 0, suppressed: "rate limited"');
  assert.equal(pushes.length, 1);
  assert.equal(notices.length, 2, "the chip still records every request");

  time += 1;
  const third = result(await call({ ...good, title: "Third request" }));
  assert.equal(third.text, "sent: 1");
  assert.equal(pushes.length, 2);
});

test("a failing push service returns sent: 0 without failing the tool", async () => {
  const { notices, call } = harness({ fail: true });
  const tool = result(await call(good));

  assert.equal(tool.isError, false);
  assert.equal(tool.text, "sent: 0");
  assert.equal(notices.length, 1);
});

test("the real push service carries title, body and reason to every subscription", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-operator-"));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const payloads: string[] = [];
  const service = configurePush({
    dataDir: dir,
    throttleMs: 0,
    send: async (_target, payload) => {
      payloads.push(payload);
      return { statusCode: 201 };
    },
  });
  await service.subscribe({
    endpoint: "https://push.example/one",
    keys: { p256dh: "p256dh-key", auth: "auth-secret" },
  });
  await service.subscribe({
    endpoint: "https://push.example/two",
    keys: { p256dh: "p256dh-key-2", auth: "auth-secret-2" },
  });

  try {
    const notices: OperatorNoticeRecord[] = [];
    const tool = createOperatorTools({
      notify: (notification) => service.notify(notification),
      recordNotice: (record) => {
        notices.push(record);
      },
    })[0];
    assert.ok(tool);
    const called = result(await tool.execute(good as never, {} as never, {} as never));
    assert.equal(called.text, "sent: 2");
    assert.equal(payloads.length, 2);

    const payload = JSON.parse(payloads[0] ?? "{}") as Record<string, unknown>;
    assert.equal(payload.title, good.title);
    assert.equal(payload.body, good.body);
    assert.equal(payload.tag, "notify-operator");
    assert.equal(payload.url, "/chat");
    assert.deepEqual(payload.data, { reason: good.reason });
    assert.deepEqual(notices, [good]);
  } finally {
    await service.close();
    resetPushServiceForTests();
  }
});
