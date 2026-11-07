import { type Browser, describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

type DelegateRun = {
  id: string;
  agent: string;
  task: string;
  taskFirstLine: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  startedAt: string | null;
  endedAt: string | null;
  duration: string;
  usage?: { input: number; output: number; total: number; cost: number };
  resultUrl: string;
  activityUrl: string;
};

type State = {
  run?: string;
  messages?: Array<{
    role?: string;
    text?: string;
    timestamp?: string;
    notice?: { kind?: string };
  }>;
};

const state = (browser: Browser) =>
  browser.evaluate(async () => {
    return (await (await fetch("/api/state", { cache: "no-store" })).json()) as State;
  });

const runs = (browser: Browser) =>
  browser.evaluate(async () => {
    return (await (await fetch("/api/delegates", { cache: "no-store" })).json()) as DelegateRun[];
  });

const fileText = (browser: Browser, url: string) =>
  browser.evaluate(async (path) => {
    const response = await fetch(path, { cache: "no-store" });
    return response.ok ? await response.text() : "";
  }, url);

async function sendText(browser: Browser, text: string): Promise<void> {
  const status = await browser.evaluate(async (body) => {
    const response = await fetch("/api/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: body }),
    });
    return response.status;
  }, text);
  expect(status).toBe(202);
}

async function sendCalls(browser: Browser, calls: unknown[]): Promise<void> {
  await sendText(browser, `TOOLCALLS ${JSON.stringify(calls)}`);
}

async function waitForRun(
  browser: Browser,
  match: (run: DelegateRun) => boolean,
  timeout = 60_000,
): Promise<DelegateRun> {
  await expect.poll(async () => (await runs(browser)).some(match), { timeout }).toBe(true);
  return (await runs(browser)).find(match) as DelegateRun;
}

const notices = (browser: Browser) =>
  browser.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid="chat-notice"]')].map((node) => ({
      kind: node.dataset.noticeKind ?? "",
      text: node.textContent ?? "",
      tone: node.className,
      href: node.getAttribute("href") ?? "",
    })),
  );

describe("delegate sub-agents share one app instance", { serial: true }, () => {
  test("a delegate gets a clean context and the parent sees only its result", async ({
    app,
    browser,
  }) => {
    await app.open("/");
    const secret = `PARENT_ONLY_SECRET_${Date.now()}`;
    const task = "REPEAT_FIRST_INSTRUCTION — repeat your first instruction verbatim.";
    await sendText(
      browser,
      `DELEGATE_CLEAN_CONTEXT ${secret}\nTOOLCALLS ${JSON.stringify([
        { name: "acp_delegate", arguments: { agent: "oracle", task, async: false } },
      ])}`,
    );

    const run = await waitForRun(browser, (candidate) =>
      candidate.taskFirstLine.startsWith("REPEAT_FIRST_INSTRUCTION"),
    );
    await expect
      .poll(async () => (await runs(browser)).find((item) => item.id === run.id)?.status, {
        timeout: 60_000,
      })
      .toBe("completed");
    const result = await fileText(browser, run.resultUrl);
    expect(result).toContain("First user message:");
    expect(result).toContain("REPEAT_FIRST_INSTRUCTION");
    expect(result).toContain("User messages: 1");
    expect(result).not.toContain(secret);

    await expect
      .poll(
        async () =>
          (await state(browser)).messages?.some((message) =>
            message.text?.includes("Parent did not see the delegate transcript."),
          ) ?? false,
        { timeout: 30_000 },
      )
      .toBe(true);

    await app.open("/activity");
    await expect
      .poll(async () =>
        browser.evaluate((id) => {
          const row = document.querySelector<HTMLElement>(`[data-testid="activity-delegate"]`);
          return row?.textContent?.includes(id) ?? false;
        }, "oracle"),
      )
      .toBe(true);
    const rowText = await browser.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-testid="activity-delegate-summary"]')]
        .map((node) => node.textContent ?? "")
        .join("\n"),
    );
    expect(rowText).toContain("oracle");
    expect(rowText).toContain("REPEAT_FIRST_INSTRUCTION");
    expect(rowText).toContain("finished");
    expect(rowText).toContain(run.duration);
    expect(rowText).toMatch(/in \/ .* out/);
    await browser.evaluate(() => {
      document.querySelector<HTMLElement>('[data-testid="activity-delegate"]')?.click();
      return null;
    });
    await expect
      .poll(async () =>
        browser.evaluate(() =>
          [...document.querySelectorAll<HTMLElement>('[data-testid="activity-card"]')]
            .map((node) => node.textContent ?? "")
            .join("\n"),
        ),
      )
      .toContain("First user message:");
  });

  test("an async delegate overlaps a second parent tool call by timestamps", async ({
    app,
    browser,
  }) => {
    await app.open("/");
    const marker = `ASYNC_OVERLAP_${Date.now()}`;
    const sentAt = Date.now();
    await sendCalls(browser, [
      { name: "acp_delegate", arguments: { agent: "worker", task: `DELEGATE_PARTIAL ${marker}` } },
      { name: "job_start", arguments: { command: "true" } },
    ]);

    const run = await waitForRun(browser, (candidate) => candidate.task.includes(marker));
    await expect
      .poll(async () => (await runs(browser)).find((item) => item.id === run.id)?.status, {
        timeout: 30_000,
      })
      .toBe("running");
    await expect
      .poll(
        async () =>
          (await state(browser)).messages?.some(
            (message) =>
              message.role === "assistant" &&
              message.text?.startsWith("Tool result:") === true &&
              Date.parse(message.timestamp ?? "") >= sentAt,
          ) ?? false,
      )
      .toBe(true);
    const parentAnswer = (await state(browser)).messages?.find(
      (message) =>
        message.role === "assistant" &&
        message.text?.startsWith("Tool result:") === true &&
        Date.parse(message.timestamp ?? "") >= sentAt,
    );
    const current = (await runs(browser)).find((item) => item.id === run.id) as DelegateRun;
    expect(current.status).toBe("running");
    expect(current.startedAt).not.toBeNull();
    expect(Date.parse(current.startedAt ?? "")).toBeLessThanOrEqual(
      Date.parse(parentAnswer?.timestamp ?? ""),
    );
    expect(current.endedAt).toBeNull();

    await sendCalls(browser, [{ name: "acp_delegate_cancel", arguments: { runId: run.id } }]);
    await expect
      .poll(async () => (await runs(browser)).find((item) => item.id === run.id)?.status, {
        timeout: 30_000,
      })
      .toBe("cancelled");
  });

  test("a failed delegate shows a failure notice while the parent finishes its turn", async ({
    app,
    browser,
  }) => {
    await app.open("/");
    const marker = `DELEGATE_FAIL_${Date.now()}`;
    const sentAt = Date.now();
    await sendCalls(browser, [
      { name: "acp_delegate", arguments: { agent: "worker", task: marker } },
    ]);
    await expect
      .poll(
        async () =>
          (await state(browser)).messages?.some(
            (message) =>
              message.role === "assistant" &&
              message.text?.includes("Delegated to worker") === true &&
              Date.parse(message.timestamp ?? "") >= sentAt,
          ) ?? false,
      )
      .toBe(true);

    const run = await waitForRun(browser, (candidate) => candidate.task === marker);
    await expect
      .poll(async () => (await runs(browser)).find((item) => item.id === run.id)?.status, {
        timeout: 60_000,
      })
      .toBe("failed");
    await expect
      .poll(async () =>
        (await notices(browser)).some(
          (notice) => notice.kind === "delegate" && notice.text.includes("FAILED"),
        ),
      )
      .toBe(true);
    const notice = (await notices(browser)).find((item) => item.kind === "delegate");
    expect(notice?.tone).toContain("text-destructive");
    await browser.evaluate(() => {
      document
        .querySelector<HTMLElement>('[data-testid="chat-notice"][data-notice-kind="delegate"]')
        ?.click();
      return null;
    });
    await expect
      .poll(async () =>
        browser.evaluate((id) => {
          const link = document.querySelector<HTMLAnchorElement>(
            `[data-testid="notice-dialog"] a[href*="/api/delegates/${id}/result"]`,
          );
          return link?.getAttribute("href") ?? "";
        }, run.id),
      )
      .toContain(`/api/delegates/${run.id}/result`);
    const result = await fileText(browser, run.resultUrl);
    expect(result).toContain("Failed:");
    expect(result).toContain("delegate failure requested by the test");
  });

  test("cancel stops a running delegate and keeps its partial output readable", async ({
    app,
    browser,
  }) => {
    await app.open("/");
    const marker = `CANCEL_${Date.now()}`;
    await sendCalls(browser, [
      { name: "acp_delegate", arguments: { agent: "worker", task: `DELEGATE_PARTIAL ${marker}` } },
    ]);
    const run = await waitForRun(browser, (candidate) => candidate.task.includes(marker));
    await expect
      .poll(async () => (await runs(browser)).find((item) => item.id === run.id)?.status, {
        timeout: 30_000,
      })
      .toBe("running");

    await expect
      .poll(async () => (await fileText(browser, run.activityUrl)).includes("Working on it"), {
        timeout: 20_000,
      })
      .toBe(true);

    await sendCalls(browser, [{ name: "acp_delegate_cancel", arguments: { runId: run.id } }]);
    await expect
      .poll(async () => (await runs(browser)).find((item) => item.id === run.id)?.status, {
        timeout: 30_000,
      })
      .toBe("cancelled");
    await expect
      .poll(async () => (await fileText(browser, run.resultUrl)).includes("Cancelled"))
      .toBe(true);
    const result = await fileText(browser, run.resultUrl);
    expect(result).toContain("Cancelled");
    expect(result).toContain("Working on it");
    const activity = await fileText(browser, run.activityUrl);
    expect(activity).toContain("started");
    expect(activity).toContain("Working on it");
  });

  test("nesting is refused at max depth and a fifth concurrent run queues", async ({
    app,
    browser,
  }) => {
    await app.open("/");
    const nestedMarker = `NEST_${Date.now()}`;
    await sendCalls(browser, [
      {
        name: "acp_delegate",
        arguments: {
          agent: "oracle",
          task: `TOOLCALLS ${JSON.stringify([
            { name: "acp_delegate", arguments: { agent: "oracle", task: nestedMarker } },
          ])}`,
        },
      },
    ]);
    const nested = await waitForRun(
      browser,
      (candidate) =>
        candidate.task.includes("acp_delegate") && candidate.task.includes(nestedMarker),
    );
    await expect
      .poll(async () => (await runs(browser)).find((item) => item.id === nested.id)?.status, {
        timeout: 60_000,
      })
      .toBe("completed");
    expect(await fileText(browser, nested.resultUrl)).toContain("nesting limit");

    const marker = `CONCURRENCY_${Date.now()}`;
    const calls = Array.from({ length: 5 }, (_, index) => ({
      name: "acp_delegate",
      arguments: { agent: "worker", task: `SLOW ${marker}_${index}` },
    }));
    await sendCalls(browser, calls);
    await expect
      .poll(async () => (await runs(browser)).filter((run) => run.task.includes(marker)).length, {
        timeout: 30_000,
      })
      .toBe(5);
    await expect
      .poll(async () => {
        const matching = (await runs(browser)).filter((run) => run.task.includes(marker));
        return {
          running: matching.filter((run) => run.status === "running").length,
          queued: matching.filter((run) => run.status === "queued").length,
        };
      })
      .toEqual({ running: 4, queued: 1 });

    const matching = (await runs(browser)).filter((run) => run.task.includes(marker));
    const queued = matching.find((run) => run.status === "queued") as DelegateRun;
    const running = matching.find((run) => run.status === "running") as DelegateRun;
    await sendCalls(browser, [{ name: "acp_delegate_cancel", arguments: { runId: running.id } }]);
    await expect
      .poll(async () => (await runs(browser)).find((item) => item.id === queued.id)?.status, {
        timeout: 30_000,
      })
      .toBe("running");

    const remaining = (await runs(browser)).filter(
      (run) => run.task.includes(marker) && run.status === "running",
    );
    await sendCalls(
      browser,
      remaining.map((run) => ({
        name: "acp_delegate_cancel",
        arguments: { runId: run.id },
      })),
    );
    await expect
      .poll(async () =>
        (await runs(browser))
          .filter((run) => run.task.includes(marker))
          .every((run) => run.status === "cancelled"),
      )
      .toBe(true);
  });
});
