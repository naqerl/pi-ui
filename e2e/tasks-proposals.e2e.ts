import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

type Proposal = { id: string; title: string };

type DecisionNotice = {
  kind?: string;
  summary?: string;
  proposalId?: string;
  decision?: string;
};

async function createProposal(
  browser: Browser,
  title: string,
  rationale: string,
): Promise<Proposal> {
  return browser.evaluate(
    async (args) => {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...args, propose: true }),
      });
      const ledger = (await response.json()) as { tasks: Proposal[] };
      const task = ledger.tasks.find((item) => item.title === args.title);
      return task ?? { id: "", title: "" };
    },
    { title, rationale },
  );
}

async function decide(
  browser: Browser,
  id: string,
  decision: "approved" | "declined",
): Promise<number> {
  return browser.evaluate(
    async (args) => {
      const response = await fetch(`/api/tasks/${encodeURIComponent(args.id)}`, {
        method: args.decision === "approved" ? "PATCH" : "DELETE",
        ...(args.decision === "approved"
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ status: "open" }),
            }
          : {}),
      });
      return response.status;
    },
    { id, decision },
  );
}

const decisionNotices = (browser: Browser) =>
  browser.evaluate(async () => {
    const state = (await (await fetch("/api/state", { cache: "no-store" })).json()) as {
      messages?: Array<{ notice?: DecisionNotice }>;
    };
    return (state.messages ?? [])
      .map((message) => message.notice)
      .filter((notice): notice is DecisionNotice => notice?.kind === "decision")
      .map((notice) => ({
        summary: notice.summary ?? "",
        proposalId: notice.proposalId ?? "",
        decision: notice.decision ?? "",
      }));
  });

const assistantText = (browser: Browser) =>
  browser.evaluate(
    () =>
      [...document.querySelectorAll<HTMLElement>('[data-role="assistant"]')].at(-1)?.textContent ??
      "",
  );

const decisionBubbles = (browser: Browser) =>
  browser.evaluate(
    () =>
      [...document.querySelectorAll<HTMLElement>('[data-role="user"]')].filter((node) =>
        (node.textContent ?? "").includes("Task proposal "),
      ).length,
  );

/** A local endpoint that proves no web push leaves the server for a decision. */
async function pushSink() {
  let hits = 0;
  const server = createServer((request, response) => {
    if (request.method === "POST") hits += 1;
    request.resume();
    response.writeHead(201);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address !== null && typeof address !== "string" ? address.port : 0;
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const point = publicKey.export({ format: "der", type: "spki" }).subarray(-65);
  return {
    endpoint: `http://127.0.0.1:${port}/push`,
    keys: {
      p256dh: point.toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
    hits: () => hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function subscribe(browser: Browser, sink: Awaited<ReturnType<typeof pushSink>>) {
  const status = await browser.evaluate(
    async (args) => {
      const response = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(args),
      });
      return response.status;
    },
    { endpoint: sink.endpoint, keys: sink.keys },
  );
  expect(status).toBe(200);
}

async function unsubscribe(browser: Browser, sink: Awaited<ReturnType<typeof pushSink>>) {
  await browser.evaluate(async (endpoint) => {
    await fetch("/api/push/subscribe", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint }),
    });
    return null;
  }, sink.endpoint);
}

async function removeProposal(browser: Browser, title: string) {
  await browser.evaluate(async (name) => {
    const ledger = (await (await fetch("/api/tasks")).json()) as {
      tasks: Array<{ id: string; title: string }>;
    };
    for (const task of ledger.tasks.filter((item) => item.title === name)) {
      await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
    }
    return null;
  }, title);
}

test("approving a proposal tells the model with its id and title, as a notice", async ({
  app,
  browser,
}) => {
  const tag = Date.now();
  const title = `Tell the model about approval ${tag}`;
  const rationale = "The operator decision must reach the model before it answers again.";
  const sink = await pushSink();
  let proposal: Proposal | undefined;
  try {
    await app.open("/");
    proposal = await createProposal(browser, title, rationale);
    expect(proposal.id).not.toBe("");
    await subscribe(browser, sink);

    expect(await decide(browser, proposal.id, "approved")).toBe(200);

    await expect
      .poll(() => assistantText(browser), { timeout: 60_000 })
      .toContain(
        `Task proposal ${proposal.id} was approved and is now task ${proposal.id}: ${title}.`,
      );
    const reply = await assistantText(browser);
    expect(reply).toContain("You may start working on it now");

    const expected = `proposal ${proposal.id} approved as ${proposal.id} · ${title}`;
    await expect
      .poll(async () => (await decisionNotices(browser)).map((notice) => notice.summary), {
        timeout: 30_000,
      })
      .toContain(expected);
    await expect
      .poll(
        () =>
          browser.evaluate(() =>
            [
              ...document.querySelectorAll<HTMLElement>(
                '[data-testid="chat-notice"][data-notice-kind="decision"] [data-testid="chat-notice-summary"]',
              ),
            ].map((node) => node.textContent ?? ""),
          ),
        { timeout: 30_000 },
      )
      .toContain(expected);

    expect(await decisionBubbles(browser)).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(sink.hits()).toBe(0);

    // A repeated write of the same state does not notify again.
    expect(await decide(browser, proposal.id, "approved")).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await decisionNotices(browser)).toHaveLength(1);
  } finally {
    await unsubscribe(browser, sink).catch(() => undefined);
    await removeProposal(browser, title).catch(() => undefined);
    await sink.close();
  }
});

test("declining a proposal tells the model once, as a notice and not a user bubble", async ({
  app,
  browser,
}) => {
  const tag = Date.now();
  const title = `Tell the model about decline ${tag}`;
  const rationale = "A declined proposal must not be offered again or worked on by the agent.";
  const sink = await pushSink();
  let proposal: Proposal | undefined;
  try {
    await app.open("/");
    proposal = await createProposal(browser, title, rationale);
    expect(proposal.id).not.toBe("");
    await subscribe(browser, sink);

    expect(await decide(browser, proposal.id, "declined")).toBe(200);

    await expect
      .poll(() => assistantText(browser), { timeout: 60_000 })
      .toContain(`Task proposal ${proposal.id} was declined: ${title}.`);
    const reply = await assistantText(browser);
    expect(reply).toContain("Do not start work on it and do not propose it again");

    const expected = `proposal ${proposal.id} declined · ${title}`;
    await expect
      .poll(async () => (await decisionNotices(browser)).map((notice) => notice.summary), {
        timeout: 30_000,
      })
      .toContain(expected);
    await expect
      .poll(
        () =>
          browser.evaluate(() =>
            [
              ...document.querySelectorAll<HTMLElement>(
                '[data-testid="chat-notice"][data-notice-kind="decision"] [data-testid="chat-notice-summary"]',
              ),
            ].map((node) => node.textContent ?? ""),
          ),
        { timeout: 30_000 },
      )
      .toContain(expected);

    expect(await decisionBubbles(browser)).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(sink.hits()).toBe(0);

    // Deleting the already-declined proposal again is a no-op, not a second notice.
    expect(await decide(browser, proposal.id, "declined")).toBe(404);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await decisionNotices(browser)).toHaveLength(1);
  } finally {
    await unsubscribe(browser, sink).catch(() => undefined);
    await removeProposal(browser, title).catch(() => undefined);
    await sink.close();
  }
});

test("tool calls made while one task is working are charged to it", async ({
  app,
  browser,
  screen,
}) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks");
  const tag = Date.now();
  const title = `Measure the build ${tag}`;
  const id = await browser.evaluate(async (name) => {
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: name }),
    });
    const ledger = (await response.json()) as { tasks: Array<{ id: string; title: string }> };
    return ledger.tasks.find((task) => task.title === name)?.id ?? null;
  }, title);
  expect(id).not.toBeNull();
  await expect(screen.getByTestId(`task-${id}`)).toBeVisible();
  await expect(screen.getByTestId("now-line")).toHaveCount(0);

  const working = await browser.evaluate(async (taskId) => {
    const response = await fetch(`/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "working" }),
    });
    return response.ok;
  }, id ?? "");
  expect(working).toBe(true);

  // The call waits until the test has looked, however slow the machine.
  const release = join(tmpdir(), `pi-ui-task-activity-${tag}-${randomUUID()}`);
  const wait = `for i in $(seq 600); do [ -e '${release}' ] && break; sleep 0.1; done; echo released`;
  const calls = [
    { name: "bash", arguments: { command: wait } },
    { name: "bash", arguments: { command: "echo also charged" } },
  ];
  await browser.evaluate(
    async (text) => {
      await fetch("/api/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      return null;
    },
    `TOOLCALLS ${JSON.stringify(calls)}`,
  );

  await expect(screen.getByTestId(`task-${id}`)).toHaveAttribute("data-state", "working");
  await expect(screen.getByTestId(`task-${id}`)).toContainText("Working");
  // The row's badge says it; there is no separate "Working on …" line.
  await expect(screen.getByTestId("now-line")).toHaveCount(0);

  writeFileSync(release, "");

  // Wait for the turn to end, then check the ledger still remembers both attributed calls.
  await expect
    .poll(() =>
      browser.evaluate(async (taskId: string) => {
        const ledger = (await (await fetch("/api/tasks")).json()) as {
          tasks: Array<{ id: string; lastWorkedAt?: string | null }>;
          activity?: {
            running: boolean;
            traces: Record<string, { measured?: { runs: number; calls: number } }>;
          };
        };
        const task = ledger.tasks.find((item) => item.id === taskId);
        return {
          running: ledger.activity?.running ?? null,
          lastWorkedAt: task?.lastWorkedAt ?? null,
          runs: ledger.activity?.traces[taskId]?.measured?.runs ?? null,
          calls: ledger.activity?.traces[taskId]?.measured?.calls ?? null,
        };
      }, id ?? ""),
    )
    .toMatchObject({ running: false, lastWorkedAt: expect.any(String), runs: 1, calls: 2 });
  await expect(screen.getByTestId(`task-${id}`)).toHaveAttribute("data-state", "working");
  await expect(screen.getByTestId(`task-${id}`)).toContainText("Working");
  await expect(screen.getByTestId(`task-stale-${id}`)).toHaveCount(0);

  await screen.getByRole("button", { name: `Open ${title}` }).tap();
  await expect(screen.getByTestId("task-history")).toHaveCount(0);
  await expect(screen.getByTestId("task-detail")).not.toContainText("Run started");

  // Finishing the task is what clears the badge; the run ending did not.
  await screen.getByTestId("task-detail-status").tap();
  await expect(screen.getByTestId("task-state")).toHaveText("Done");
});

type TaskRead = {
  id: string;
  title: string;
  status: string;
  workingSince?: string;
  lastWorkedAt?: string | null;
};

// The e2e server and its task store are shared by every test file: leave no tasks behind.
async function removeTasks(browser: Browser, titles: readonly string[]) {
  await browser.evaluate(async (names) => {
    const matching = async () =>
      (
        (await (await fetch("/api/tasks")).json()).tasks as Array<{ id: string; title: string }>
      ).filter((task) => names.includes(task.title));
    for (const task of await matching()) {
      await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
    }
    return null;
  }, titles);
}

async function createTask(browser: Browser, title: string): Promise<string> {
  return browser.evaluate(async (name) => {
    const response = await fetch("/api/tasks", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: name }),
    });
    const ledger = (await response.json()) as { tasks: TaskRead[] };
    return ledger.tasks.find((task) => task.title === name)?.id ?? "";
  }, title);
}

async function runWorking(
  browser: Browser,
  id: string,
  note: string,
  title: string,
): Promise<string> {
  await browser.evaluate(
    async (args) => {
      await fetch("/api/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text: `TOOLCALLS ${JSON.stringify([
            { name: "task_working", arguments: { id: args.id, note: args.note } },
          ])}`,
        }),
      });
      return null;
    },
    { id, note },
  );
  let output: string | null = null;
  await expect
    .poll(
      async () => {
        output = await browser.evaluate(
          async (args) => {
            const state = (await (await fetch("/api/state", { cache: "no-store" })).json()) as {
              activity?: Array<{ name?: string; output?: string }>;
            };
            const result = (state.activity ?? []).find(
              (entry) =>
                entry.name === "task_working" &&
                typeof entry.output === "string" &&
                entry.output.includes(args.id) &&
                entry.output.includes(args.note),
            );
            return typeof result?.output === "string" ? result.output : null;
          },
          { id, note },
        );
        return output !== null;
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  expect(output).toContain(title);
  expect(output).toContain("working");
  expect(output).toContain(note);
  return output ?? "";
}

async function readTask(browser: Browser, id: string): Promise<TaskRead | null> {
  return browser.evaluate(async (taskId) => {
    const state = (await (await fetch("/api/state", { cache: "no-store" })).json()) as {
      tasks: { tasks: TaskRead[] };
    };
    return state.tasks.tasks.find((task) => task.id === taskId) ?? null;
  }, id);
}

test("task_working persists its start, repeats idempotently and clears on close", async ({
  app,
  browser,
  screen,
}) => {
  const tag = Date.now();
  const title = `Track the working badge ${tag}`;
  await app.open("/?page=tasks");
  const id = await createTask(browser, title);
  expect(id).not.toBe("");

  try {
    const first = `first pass ${tag}`;
    await runWorking(browser, id, first, title);
    const afterFirst = await readTask(browser, id);
    expect(afterFirst?.status).toBe("working");
    expect(typeof afterFirst?.workingSince).toBe("string");
    expect(typeof afterFirst?.lastWorkedAt).toBe("string");

    // Reload the page: the badge comes from the persisted status, not from a live run.
    await app.open("/?page=tasks");
    await expect(screen.getByTestId(`task-${id}`)).toHaveAttribute("data-state", "working");
    await expect(screen.getByTestId(`task-${id}`)).toContainText("Working");

    await new Promise((resolve) => setTimeout(resolve, 50));
    await runWorking(browser, id, `second pass ${tag}`, title);
    const afterSecond = await readTask(browser, id);
    expect(afterSecond?.status).toBe("working");
    expect(afterSecond?.workingSince).toBe(afterFirst?.workingSince);

    await browser.evaluate(async (taskId) => {
      await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "done" }),
      });
      return null;
    }, id);
    const closed = await readTask(browser, id);
    expect(closed?.status).toBe("done");
    expect(closed?.workingSince).toBeUndefined();
    expect(closed?.lastWorkedAt ?? null).toBeNull();
  } finally {
    await removeTasks(browser, [title]);
  }
});
