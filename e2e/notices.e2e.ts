import { beforeEach, describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

type Page = { evaluate: <T, A = undefined>(fn: (arg: A) => T | Promise<T>, arg?: A) => Promise<T> };

/** The visible notices, as kind/role/summary, oldest first. */
const notices = (browser: Page) =>
  browser.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid="chat-notice"]')].map((node) => ({
      kind: node.dataset.noticeKind ?? "",
      role: node.parentElement?.dataset.role ?? "",
      summary: node.querySelector('[data-testid="chat-notice-summary"]')?.textContent ?? "",
    })),
  );
/** The job rows on the activity page, oldest first. */
const jobRows = (browser: Page) =>
  browser.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid="activity-job-summary"]')].map(
      (node) => node.textContent ?? "",
    ),
  );

const dialogText = (browser: Page) =>
  browser.evaluate(() => {
    const dialog = document.querySelector<HTMLDialogElement>('[data-testid="notice-dialog"]');
    return dialog?.open === true ? (dialog.textContent ?? "") : null;
  });

/** No raw job or MCP text is left as a chat bubble. */
const rawBubbles = (browser: Page) =>
  browser.evaluate(
    () =>
      [...document.querySelectorAll<HTMLElement>('[data-role="user"]')].filter(
        (node) =>
          node.querySelector('[data-testid="chat-notice"]') === null &&
          /\[background job|MCP event data follows/.test(node.textContent ?? ""),
      ).length,
  );

const jobNotice = (browser: Page) =>
  browser.evaluate(
    () => document.querySelector('[data-testid="chat-notice"][data-notice-kind="job"]') !== null,
  );

type ChatState = {
  run?: string;
  messages?: Array<{
    text?: string;
    notice?: { kind?: string; path?: string };
  }>;
};

const chatState = (browser: Page) =>
  browser.evaluate(
    async () => (await (await fetch("/api/state", { cache: "no-store" })).json()) as ChatState,
  );

describe("notice policy against one shared app", { serial: true }, () => {
  beforeEach(async ({ browser }) => {
    await browser.unrouteAll();
  });

  test("a finished job shows a chat chip and its activity row", async ({
    app,
    browser,
    screen,
  }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await app.open("/");
    const marker = `notice-output-${Date.now()}`;
    await screen.getByRole("textbox", "Message").fill(`JOBSTART sleep 1; echo ${marker}; exit 4`);
    await screen.getByRole("button", "Send").tap();

    await app.open("/activity");
    await expect
      .poll(
        async () =>
          (await jobRows(browser)).some(
            (summary) => summary.includes(marker) && summary.includes("failed ✗ exit 4"),
          ),
        { timeout: 25_000 },
      )
      .toBe(true);

    // The stored entry also feeds one chat chip where the notice woke the agent, and the
    // result is never a user bubble.
    await app.open("/");
    await expect.poll(() => jobNotice(browser), { timeout: 10_000 }).toBe(true);
    expect(await rawBubbles(browser)).toBe(0);
    const jobChips = await notices(browser);
    expect(jobChips.filter((notice) => notice.kind === "job")).toHaveLength(1);
    const chip = jobChips.find((notice) => notice.kind === "job");
    expect(chip?.role).toBe("system");
    expect(chip?.summary ?? "").toContain(marker);
    expect(chip?.summary ?? "").toContain("failed ✗ exit 4");
    const state: ChatState = await chatState(browser);
    expect(
      (state.messages ?? []).filter(
        (message) => message.notice?.kind === "job" && (message.text ?? "").includes(marker),
      ),
    ).toHaveLength(1);

    // The chip opens the same job details as its activity row.
    await browser.evaluate(() => {
      document
        .querySelector<HTMLElement>('[data-testid="chat-notice"][data-notice-kind="job"]')
        ?.click();
      return null;
    });
    await expect.poll(() => dialogText(browser)).not.toBeNull();
    const chipDialog = await dialogText(browser);
    expect(chipDialog).toMatch(/Exit code\s*4/);
    expect(chipDialog).toMatch(new RegExp(`Command\\s*sleep 1; echo ${marker}; exit 4`));
    expect(chipDialog).toMatch(new RegExp(`Last output[\\s\\S]*${marker}`));

    await app.open("/activity");
    await expect
      .poll(async () => (await jobRows(browser)).some((summary) => summary.includes(marker)), {
        timeout: 10_000,
      })
      .toBe(true);
    const failedJobClasses = await browser.evaluate((text) => {
      const row = [...document.querySelectorAll<HTMLElement>('[data-testid="activity-job"]')].find(
        (node) => node.textContent?.includes(text),
      );
      return row?.className ?? "";
    }, marker);
    expect(failedJobClasses).toContain("text-destructive");

    await browser.evaluate((text) => {
      [...document.querySelectorAll<HTMLElement>('[data-testid="activity-job"]')]
        .find((node) => node.textContent?.includes(text))
        ?.click();
      return null;
    }, marker);
    const details = await browser.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-testid="activity-card"]')]
        .map((node) => node.textContent ?? "")
        .join("\n"),
    );
    expect(details).toMatch(/Exit code\s*4/);
    expect(details).toMatch(new RegExp(`Command\\s*sleep 1; echo ${marker}; exit 4`));
    expect(details).toMatch(new RegExp(`last output[\\s\\S]*${marker}`));
  });

  test("a memory write shows one memory chip and starts no follow-up turn", async ({
    app,
    browser,
  }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await app.open("/");
    const path = `topics/projects/notice-memory-${Date.now()}.md`;
    const body = "# Notice memory\n\na memory write must not start a follow-up turn.";
    const status = await browser.evaluate(
      async ({ path, body }: { path: string; body: string }) => {
        const toolCalls = [
          { name: "memory_write", arguments: { target: "long_term", topic: path, body } },
        ];
        const response = await fetch("/api/message", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: `TOOLCALLS ${JSON.stringify(toolCalls)}` }),
        });
        return response.status;
      },
      { path, body },
    );
    expect(status).toBe(202);

    await expect
      .poll(
        async () =>
          (await notices(browser)).filter(
            (notice) => notice.kind === "memory" && notice.summary.includes(path),
          ).length,
        { timeout: 60_000 },
      )
      .toBe(1);
    await expect
      .poll(async () => (await chatState(browser)).run ?? "", { timeout: 60_000 })
      .toBe("idle");

    // The delta prompt is the only thing that makes the fake model answer with this text.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const state: ChatState = await chatState(browser);
    expect(state.run).toBe("idle");
    const messages = state.messages ?? [];
    expect(messages.filter((message) => message.notice?.kind === "memory")).toHaveLength(1);
    expect(messages.filter((message) => message.notice?.kind === "memory-delta")).toHaveLength(0);
    expect(messages.some((message) => message.text?.includes("memory delta nudge"))).toBe(false);
  });
  const at = (second: number) => new Date(Date.UTC(2026, 9, 30, 9, 0, second)).toISOString();
  const interruptedNote = "The previous run was interrupted by a server restart";
  const interruptedSnapshot = {
    conversationId: "notices-interrupted-e2e",
    messages: [
      {
        id: "partial-reply",
        role: "assistant",
        text: "The partial answer is still here.",
        timestamp: at(1),
        order: 10_000,
        partial: true,
      },
      {
        id: "interrupted-note",
        role: "system",
        text: interruptedNote,
        timestamp: at(2),
        order: 20_000,
        notice: { kind: "interrupted", note: interruptedNote, stopped: false },
      },
    ],
    activity: [],
    run: "idle",
    queue: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
    context: { tokens: 0, window: null, percent: null },
  };

  test("an interrupted run keeps its partial reply and shows a warning-toned chip", async ({
    app,
    browser,
    screen,
  }) => {
    await browser.setViewport({ width: 390, height: 844 });
    await browser.route("**/api/state**", async (route) => {
      await route.fulfill({ json: JSON.parse(JSON.stringify(interruptedSnapshot)) });
    });
    await app.open("/");
    await expect
      .poll(() => notices(browser))
      .toEqual([{ kind: "interrupted", role: "system", summary: interruptedNote }]);
    await expect(
      screen.getByText("The partial answer is still here.", { exact: true }),
    ).toBeVisible();
    expect(await rawBubbles(browser)).toBe(0);

    const chip = await browser.evaluate(() => {
      const node = document.querySelector<HTMLElement>(
        '[data-testid="chat-notice"][data-notice-kind="interrupted"]',
      );
      if (node === null) return null;
      const probe = document.createElement("div");
      probe.className = "border border-status-warn/40 bg-status-warn/10 text-status-warn";
      document.body.appendChild(probe);
      const style = getComputedStyle(node);
      const warning = getComputedStyle(probe);
      const computed = {
        classes: node.className,
        text: node.textContent ?? "",
        tag: node.tagName,
        hasPopup: node.hasAttribute("aria-haspopup"),
        title: node.getAttribute("title"),
        warningIcon: node.querySelector('[data-icon="warning"]') !== null,
        background: style.backgroundColor,
        warningBackground: warning.backgroundColor,
        color: style.color,
        warningColor: warning.color,
        border: style.borderTopColor,
        warningBorder: warning.borderTopColor,
      };
      probe.remove();
      return computed;
    });
    expect(chip).not.toBeNull();
    expect(chip?.warningIcon).toBe(true);
    expect(chip?.text ?? "").not.toContain("⚠");
    expect(chip?.background).toBe(chip?.warningBackground);
    expect(chip?.color).toBe(chip?.warningColor);
    expect(chip?.border).toBe(chip?.warningBorder);
    expect(chip?.classes ?? "").not.toContain("bg-surface/90");
    expect(chip?.classes ?? "").not.toContain("text-muted-foreground");
    expect(chip?.classes ?? "").not.toContain("hover:");
    expect(chip?.tag).toBe("SPAN");
    expect(chip?.hasPopup).toBe(false);
    expect(chip?.title).toBeNull();

    await browser.evaluate(() => {
      document
        .querySelector<HTMLElement>('[data-testid="chat-notice"][data-notice-kind="interrupted"]')
        ?.click();
      return null;
    });
    await expect(screen.getByRole("dialog")).toHaveCount(0);
    expect(await dialogText(browser)).toBeNull();
  });
});
