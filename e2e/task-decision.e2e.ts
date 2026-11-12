import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";

type Proposal = { id: string; title: string };

type StateMessage = {
  role?: string;
  text?: string;
  notice?: { kind?: string; proposalId?: string; decision?: string; text?: string };
};

const RATIONALE = "The operator decision must reach the model before it answers again.";

async function createProposal(browser: Browser, title: string): Promise<Proposal> {
  return browser.evaluate(
    async (args) => {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...args, propose: true }),
      });
      const ledger = (await response.json()) as { tasks: Proposal[] };
      return ledger.tasks.find((item) => item.title === args.title) ?? { id: "", title: "" };
    },
    { title, rationale: RATIONALE },
  );
}

async function approve(browser: Browser, id: string): Promise<number> {
  return browser.evaluate(async (taskId) => {
    const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: "open" }),
    });
    return response.status;
  }, id);
}

async function stateMessages(browser: Browser): Promise<StateMessage[]> {
  return browser.evaluate(async () => {
    const state = (await (await fetch("/api/state", { cache: "no-store" })).json()) as {
      messages?: StateMessage[];
    };
    return state.messages ?? [];
  });
}

async function runState(browser: Browser): Promise<string> {
  return browser.evaluate(async () => {
    const state = (await (await fetch("/api/state", { cache: "no-store" })).json()) as {
      run?: string;
    };
    return state.run ?? "";
  });
}

async function removeProposal(browser: Browser, title: string): Promise<void> {
  await browser.evaluate(async (name) => {
    const ledger = (await (await fetch("/api/tasks")).json()) as { tasks: Proposal[] };
    for (const task of ledger.tasks.filter((item) => item.title === name)) {
      await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, { method: "DELETE" });
    }
    return null;
  }, title);
}

/** Starts a turn whose bash call holds until the returned release function runs. */
async function startSlowTurn(browser: Browser): Promise<() => void> {
  const release = join(tmpdir(), `pi-ui-task-decision-${randomUUID()}`);
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

test("an approved proposal is one notice chip and never a user message", async ({
  app,
  browser,
}) => {
  const tag = Date.now();
  const title = `Approval notice only ${tag}`;
  let proposal: Proposal | undefined;
  await app.open("/");
  proposal = await createProposal(browser, title);
  expect(proposal.id).not.toBe("");
  try {
    expect(await approve(browser, proposal.id)).toBe(200);
    const sentence = `Task proposal ${proposal.id} was approved and is now task ${proposal.id}: ${title}.`;

    // Let the decision prompt run to completion, then inspect the settled transcript.
    await expect
      .poll(
        async () =>
          (await stateMessages(browser)).filter(
            (message) => message.role === "assistant" && message.text?.includes(sentence),
          ).length,
        { timeout: 60_000 },
      )
      .toBe(1);
    await expect.poll(() => runState(browser), { timeout: 30_000 }).not.toBe("running");

    const messages = await stateMessages(browser);
    const records = messages.filter(
      (message) => message.role !== "assistant" && message.text?.includes(sentence),
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.role).toBe("system");
    expect(records[0]?.notice?.kind).toBe("decision");
    expect(records[0]?.notice?.decision).toBe("approved");
    expect(messages.filter((message) => message.role === "user")).toHaveLength(0);

    const chips = browser.locator(
      '[data-testid="chat-notice"][data-notice-kind="decision"] [data-testid="chat-notice-summary"]',
    );
    await expect(chips).toHaveCount(1);
    await expect(chips).toContainText(`proposal ${proposal.id} approved as ${proposal.id}`);
    await expect(browser.locator('[data-role="user"]').filter({ hasText: sentence })).toHaveCount(
      0,
    );
  } finally {
    if (proposal !== undefined) await removeProposal(browser, title).catch(() => undefined);
  }
});

test("a normal queued message still renders as a user row", async ({ app, browser }) => {
  const tag = Date.now();
  const text = `normal queued message ${tag}`;
  let releaseTurn: (() => void) | undefined;
  await app.open("/");
  releaseTurn = await startSlowTurn(browser);
  try {
    const queued = await browser.evaluate(async (message) => {
      const response = await fetch("/api/message", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: message, mode: "queue" }),
      });
      return (await response.json()) as { queued: boolean; placed: boolean };
    }, text);
    expect(queued.queued).toBe(true);
    expect(queued.placed).toBe(false);

    releaseTurn();
    await expect
      .poll(
        async () =>
          (await stateMessages(browser)).filter(
            (message) => message.role === "user" && message.text === text,
          ).length,
        { timeout: 30_000 },
      )
      .toBe(1);
    await expect.poll(() => runState(browser), { timeout: 30_000 }).not.toBe("running");

    const messages = await stateMessages(browser);
    const rows = messages.filter((message) => message.role === "user" && message.text === text);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.notice).toBeUndefined();
    await expect(browser.locator('[data-role="user"]').filter({ hasText: text })).toHaveCount(1);
  } finally {
    releaseTurn?.();
    await expect
      .poll(() => runState(browser), { timeout: 30_000 })
      .not.toBe("running")
      .catch(() => undefined);
  }
});
