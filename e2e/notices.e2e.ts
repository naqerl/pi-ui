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
describe("notice policy against one shared app", { serial: true }, () => {
  beforeEach(async ({ browser }) => {
    await browser.unrouteAll();
  });

  test("a finished job shows only on the activity page with its details", async ({
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

    // The result never becomes a chat notice or a user message.
    await app.open("/");
    await expect.poll(() => jobNotice(browser), { timeout: 10_000 }).toBe(false);
    expect(await rawBubbles(browser)).toBe(0);

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
  const at = (second: number) => new Date(Date.UTC(2026, 9, 30, 9, 0, second)).toISOString();
  const interruptedNote =
    "The previous run was interrupted by a server restart. The last response is partial; pi is resuming the run.";
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

    await browser.evaluate(() => {
      document
        .querySelector<HTMLElement>('[data-testid="chat-notice"][data-notice-kind="interrupted"]')
        ?.click();
      return null;
    });
    await expect(screen.getByRole("dialog")).toBeVisible();
    expect(await dialogText(browser)).toContain(interruptedNote);
  });
});
