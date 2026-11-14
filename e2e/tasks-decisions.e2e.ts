import { generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { type Browser, beforeEach, describe, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { isTaskChatUrl } from "./tasks-helpers";

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

describe("task decisions against one shared app", { serial: true }, () => {
  beforeEach(async ({ browser }) => {
    await browser.unrouteAll();
  });

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
});
