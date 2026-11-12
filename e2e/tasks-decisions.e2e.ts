import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { expectDetailTitle, isTaskChatUrl } from "./tasks-helpers";

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

async function runState(browser: Browser): Promise<string> {
  return browser.evaluate(async () => {
    const state = (await (await fetch("/api/state", { cache: "no-store" })).json()) as {
      run?: string;
    };
    return state.run ?? "";
  });
}

/** Starts a turn whose bash call holds until the returned release function runs. */
async function startSlowTurn(browser: Browser): Promise<() => void> {
  const release = join(tmpdir(), `pi-ui-tasks-decision-${randomUUID()}`);
  const wait = `for i in $(seq 600); do [ -e '${release}' ] && break; sleep 0.1; done; echo released`;
  const status = await browser.evaluate(async (command) => {
    const response = await fetch("/api/message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `TOOLCALLS ${JSON.stringify([{ name: "bash", arguments: { command } }])}`,
      }),
    });
    return response.status;
  }, wait);
  expect(status).toBe(202);
  await expect.poll(() => runState(browser), { timeout: 30_000 }).toBe("running");
  return () => writeFileSync(release, "");
}

/** Watches the proposal row flip and the decision request's response time. */
async function watchDecision(browser: Browser, id: string): Promise<void> {
  await browser.evaluate((taskId) => {
    const target = window as unknown as {
      __decisionWatch?: {
        started: number;
        flippedAt: number | null;
        timing: { start: number; end: number; status: number } | null;
      };
      __decisionObserver?: MutationObserver;
      __decisionFetch?: typeof window.fetch;
    };
    const watch: NonNullable<typeof target.__decisionWatch> = {
      started: performance.now(),
      flippedAt: null,
      timing: null,
    };
    target.__decisionWatch = watch;
    const check = () => {
      if (watch.flippedAt !== null) return;
      const proposal = document.querySelector(`[data-testid="proposal-${taskId}"]`);
      const row = document.querySelector(`[data-testid="task-${taskId}"]`);
      if (proposal === null && row !== null) watch.flippedAt = performance.now();
    };
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    target.__decisionObserver = observer;
    const original = window.fetch.bind(window);
    target.__decisionFetch = window.fetch;
    window.fetch = async (input, init) => {
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if ((method === "PATCH" || method === "DELETE") && url.includes(`/api/tasks/${taskId}`)) {
        const start = performance.now();
        const response = await original(input, init);
        watch.timing = { start, end: performance.now(), status: response.status };
        return response;
      }
      return original(input, init);
    };
    check();
    return true;
  }, id);
}

async function readDecisionWatch(
  browser: Browser,
  restore = false,
): Promise<{
  started: number;
  flippedAt: number | null;
  timing: { start: number; end: number; status: number } | null;
} | null> {
  return browser.evaluate((cleanup) => {
    const target = window as unknown as {
      __decisionWatch?: {
        started: number;
        flippedAt: number | null;
        timing: { start: number; end: number; status: number } | null;
      };
      __decisionObserver?: MutationObserver;
      __decisionFetch?: typeof window.fetch;
    };
    const watch = target.__decisionWatch ?? null;
    if (cleanup) {
      target.__decisionObserver?.disconnect();
      if (target.__decisionFetch !== undefined) window.fetch = target.__decisionFetch;
    }
    return watch;
  }, restore);
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

test("an approval chip appears during another held turn and opens its task", {
  timeout: 120_000,
}, async ({ app, browser, screen }) => {
  const tag = Date.now();
  const title = `Approval chip during a turn ${tag}`;
  const rationale = "An approval must be visible while the turn that was already running is held.";
  let releaseTurn: (() => void) | undefined;
  let proposal: Proposal | undefined;
  await app.open("/");
  proposal = await createProposal(browser, title, rationale);
  expect(proposal.id).not.toBe("");
  releaseTurn = await startSlowTurn(browser);
  try {
    expect(await decide(browser, proposal.id, "approved")).toBe(200);
    const summary = `proposal ${proposal.id} approved as ${proposal.id} · ${title}`;
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
        { timeout: 15_000 },
      )
      .toContain(summary);
    // The unrelated bash turn is still running when the decision chip appears.
    expect(await runState(browser)).toBe("running");
    expect(await decisionBubbles(browser)).toBe(0);

    await screen
      .getByRole("button", { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) })
      .tap();
    await expect(screen.getByTestId("notice-dialog")).toBeVisible();
    await expect
      .poll(
        () =>
          browser.evaluate(
            () => document.querySelector("[data-testid=pager]")?.getAttribute("data-page") ?? "",
          ),
        { timeout: 5_000 },
      )
      .toBe("tasks");
    await screen.getByTestId("notice-dialog-close").tap();
    await expect(screen.getByTestId("task-detail")).toBeVisible();
    await expect(screen.getByTestId("task-detail")).toHaveAttribute("aria-label", title);
    await expectDetailTitle(screen, title);
  } finally {
    releaseTurn?.();
    await expect
      .poll(() => runState(browser), { timeout: 30_000 })
      .not.toBe("running")
      .catch(() => undefined);
    if (proposal !== undefined) await removeProposal(browser, title).catch(() => undefined);
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

test("approving while the agent is mid-turn flips the row before the response lands", {
  timeout: 120_000,
}, async ({ app, browser, screen }) => {
  const tag = Date.now();
  const title = `Approve during a turn ${tag}`;
  const rationale = "The row must flip before the turn ends and before the request returns.";
  let releaseTurn: (() => void) | undefined;
  let releasePatch: (() => void) | undefined;
  let proposal: Proposal | undefined;
  await app.open("/");
  proposal = await createProposal(browser, title, rationale);
  expect(proposal.id).not.toBe("");
  await app.open("/?page=tasks");
  await expect(screen.getByTestId(`proposal-${proposal.id}`)).toBeVisible();

  releaseTurn = await startSlowTurn(browser);
  const gate = new Promise<void>((resolve) => {
    releasePatch = resolve;
  });
  await browser.route("**/api/tasks/**", async (route) => {
    if (isTaskChatUrl(route.request.url)) {
      await route.continue();
      return;
    }
    if (route.request.method === "PATCH" && route.request.url.includes(proposal?.id ?? "")) {
      await gate;
    }
    await route.continue();
  });
  try {
    await watchDecision(browser, proposal.id);
    await screen.getByRole("button", { name: `Approve ${title}` }).tap();
    await expect
      .poll(
        () =>
          browser.evaluate(
            () =>
              (
                window as unknown as {
                  __decisionWatch?: { flippedAt: number | null };
                }
              ).__decisionWatch?.flippedAt ?? null,
          ),
        { timeout: 2_000 },
      )
      .not.toBeNull();
    const painted = await readDecisionWatch(browser);
    const flipMs = (painted?.flippedAt ?? 0) - (painted?.started ?? 0);
    expect(painted?.timing).toBeNull();
    expect(await runState(browser)).toBe("running");
    expect(flipMs).toBeLessThanOrEqual(250);

    releasePatch?.();
    await expect
      .poll(
        () =>
          browser.evaluate(
            () =>
              (
                window as unknown as {
                  __decisionWatch?: { timing: { end: number } | null };
                }
              ).__decisionWatch?.timing?.end ?? null,
          ),
        { timeout: 5_000 },
      )
      .not.toBeNull();
    const landed = await readDecisionWatch(browser, true);
    const runAtResponse = await runState(browser);
    expect(landed?.timing?.status).toBe(200);
    expect(runAtResponse).toBe("running");
    console.log(
      `DECISION ${JSON.stringify({
        flipMs: (landed?.flippedAt ?? 0) - (landed?.started ?? 0),
        patchMs:
          landed?.timing === null || landed?.timing === undefined
            ? null
            : landed.timing.end - landed.timing.start,
      })}`,
    );
  } finally {
    releasePatch?.();
    await browser.unroute("**/api/tasks/**").catch(() => undefined);
    releaseTurn?.();
    await expect
      .poll(() => runState(browser), { timeout: 30_000 })
      .not.toBe("running")
      .catch(() => undefined);
    if (proposal !== undefined) await removeProposal(browser, title).catch(() => undefined);
  }
});

test("approving twice during a turn leaves exactly one decision chip", {
  timeout: 120_000,
}, async ({ app, browser }) => {
  const tag = Date.now();
  const title = `Approve twice during a turn ${tag}`;
  const rationale = "Two decisions must still produce one notice after the running turn ends.";
  let releaseTurn: (() => void) | undefined;
  let proposal: Proposal | undefined;
  await app.open("/");
  proposal = await createProposal(browser, title, rationale);
  expect(proposal.id).not.toBe("");
  releaseTurn = await startSlowTurn(browser);
  try {
    const statuses = await browser.evaluate(async (id) => {
      const approve = () =>
        fetch(`/api/tasks/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "open" }),
        }).then((response) => response.status);
      return Promise.all([approve(), approve()]);
    }, proposal.id);
    expect(statuses).toEqual([200, 200]);
    releaseTurn();

    await expect
      .poll(() => assistantText(browser), { timeout: 60_000 })
      .toContain(`Task proposal ${proposal.id} was approved`);
    const notices = (await decisionNotices(browser)).filter(
      (notice) => notice.proposalId === proposal?.id,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.decision).toBe("approved");
  } finally {
    releaseTurn?.();
    await expect
      .poll(() => runState(browser), { timeout: 30_000 })
      .not.toBe("running")
      .catch(() => undefined);
    if (proposal !== undefined) await removeProposal(browser, title).catch(() => undefined);
  }
});

test("declining removes the proposal immediately and records one declined chip after the turn", {
  timeout: 120_000,
}, async ({ app, browser, screen }) => {
  const tag = Date.now();
  const title = `Decline during a turn ${tag}`;
  const rationale = "A declined proposal must leave the list before the running turn ends.";
  let releaseTurn: (() => void) | undefined;
  let releaseDelete: (() => void) | undefined;
  let proposal: Proposal | undefined;
  await app.open("/");
  proposal = await createProposal(browser, title, rationale);
  expect(proposal.id).not.toBe("");
  await app.open("/?page=tasks");
  await expect(screen.getByTestId(`proposal-${proposal.id}`)).toBeVisible();

  releaseTurn = await startSlowTurn(browser);
  const gate = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  await browser.route("**/api/tasks/**", async (route) => {
    if (isTaskChatUrl(route.request.url)) {
      await route.continue();
      return;
    }
    if (route.request.method === "DELETE" && route.request.url.includes(proposal?.id ?? "")) {
      await gate;
    }
    await route.continue();
  });
  try {
    await screen.getByRole("button", { name: `Dismiss ${title}` }).tap();
    await expect(screen.getByTestId(`proposal-${proposal.id}`)).toHaveCount(0);
    expect(await runState(browser)).toBe("running");
    releaseDelete?.();
    await expect
      .poll(
        () =>
          browser.evaluate(async (id) => {
            const ledger = (await (await fetch("/api/tasks")).json()) as {
              tasks: Array<{ id: string }>;
            };
            return ledger.tasks.some((task) => task.id === id);
          }, proposal?.id ?? ""),
        { timeout: 5_000 },
      )
      .toBe(false);
    releaseTurn();

    await expect
      .poll(() => assistantText(browser), { timeout: 60_000 })
      .toContain(`Task proposal ${proposal.id} was declined`);
    const notices = (await decisionNotices(browser)).filter(
      (notice) => notice.proposalId === proposal?.id,
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]?.decision).toBe("declined");
  } finally {
    releaseDelete?.();
    await browser.unroute("**/api/tasks/**").catch(() => undefined);
    releaseTurn?.();
    await expect
      .poll(() => runState(browser), { timeout: 30_000 })
      .not.toBe("running")
      .catch(() => undefined);
    if (proposal !== undefined) await removeProposal(browser, title).catch(() => undefined);
  }
});

test("a failed approval rolls the proposal back and shows the error", async ({
  app,
  browser,
  screen,
}) => {
  const tag = Date.now();
  const title = `Rejected approval ${tag}`;
  const rationale = "A failed decision must put the proposal back and show the server's error.";
  let releasePatch: (() => void) | undefined;
  let proposal: Proposal | undefined;
  await app.open("/");
  proposal = await createProposal(browser, title, rationale);
  expect(proposal.id).not.toBe("");
  await app.open("/?page=tasks");
  await expect(screen.getByTestId(`proposal-${proposal.id}`)).toBeVisible();

  const gate = new Promise<void>((resolve) => {
    releasePatch = resolve;
  });
  await browser.route("**/api/tasks/**", async (route) => {
    if (isTaskChatUrl(route.request.url)) {
      await route.continue();
      return;
    }
    if (route.request.method === "PATCH" && route.request.url.includes(proposal?.id ?? "")) {
      await gate;
      await route.fulfill({ status: 500, body: "Decision rejected" });
      return;
    }
    await route.continue();
  });
  try {
    await screen.getByRole("button", { name: `Approve ${title}` }).tap();
    await expect(screen.getByTestId(`proposal-${proposal.id}`)).toHaveCount(0);
    await expect(screen.getByTestId(`task-${proposal.id}`)).toBeVisible();
    releasePatch?.();

    await expect(screen.getByTestId(`proposal-${proposal.id}`)).toBeVisible();
    await expect(screen.getByTestId(`task-${proposal.id}`)).toHaveCount(0);
    await expect(
      screen.getByTestId(`proposal-${proposal.id}`).getByTestId("task-error"),
    ).toHaveText("Decision rejected");
  } finally {
    releasePatch?.();
    await browser.unroute("**/api/tasks/**").catch(() => undefined);
    if (proposal !== undefined) await removeProposal(browser, title).catch(() => undefined);
  }
});
