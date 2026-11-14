import { type Browser, describe, test } from "@e2e-dev/web";
import { expect } from "e2e";

const at = (second: number) => new Date(Date.UTC(2026, 0, 1, 12, 0, second)).toISOString();

const longBody = [
  "# Ship plan",
  "",
  "Use **small** steps.",
  "",
  ...Array.from({ length: 30 }, (_, index) => `- Step ${index + 1} keeps the body long.`),
].join("\n");

const longRationale = [
  "The card hides too much detail when a task has a long rationale.",
  "The modal keeps the full text readable without widening the card.",
  ...Array.from(
    { length: 10 },
    (_, index) => `Paragraph ${index + 1} keeps the rationale long enough to overflow.`,
  ),
].join("\n\n");

const snapshot = {
  conversationId: "task-detail-e2e",
  messages: [],
  activity: [],
  run: "idle",
  queue: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
  context: { tokens: 0, window: null, percent: null },
  tasks: {
    revision: 1_000_000,
    tasks: [
      {
        id: "t1",
        title: "Ship the modal",
        status: "open",
        parentId: null,
        blockedBy: ["t2"],
        createdAt: at(0),
        proposedAt: null,
        body: longBody,
        rationale: longRationale,
        completedAt: null,
        completion: null,
      },
      {
        id: "t2",
        title: "Review the details",
        status: "done",
        parentId: null,
        blockedBy: [],
        createdAt: at(1),
        proposedAt: null,
        completedAt: at(20),
        completion: {
          timeSpentMinutes: 25,
          timeSpentText: "25m",
          tokens: 1200,
          evidence: "commit 9c58abc",
        },
      },
      {
        id: "p1",
        title: "Clean the cache",
        status: "proposed",
        parentId: null,
        blockedBy: [],
        createdAt: at(2),
        proposedAt: at(2),
        rationale: "The cache keeps stale entries for a whole day and needs a cleanup path.",
        completedAt: null,
        completion: null,
      },
    ],
  },
};

/** Swaps the mocked state and refreshes the serial group's existing app. */
async function openSnapshot(
  app: { open(path?: string): Promise<void> },
  browser: Browser,
  payload: typeof snapshot,
  width: number,
  height: number,
) {
  await browser.setViewport({ width, height });
  await browser.unrouteAll();
  await browser.route("**/api/state**", async (route) => {
    await route.fulfill({ json: JSON.parse(JSON.stringify(payload)) });
  });
  await app.open("/?page=tasks");
}

/**
 * Elements on the tasks page whose content is wider than their own box. Only
 * the nodes that intentionally clip their own overflow are exempt: the
 * offscreen dashboard pager is excluded by scanning inside the tasks page, and
 * visually-hidden labels and the ellipsised run-error label never show it.
 */
async function horizontalOverflow(browser: Browser) {
  return browser.evaluate(() => {
    const page = document.querySelector<HTMLElement>('[data-testid="tasks-page"]');
    if (page === null) return [null];
    const nodes = [document.documentElement, document.body, page, ...page.querySelectorAll("*")];
    return nodes
      .filter((node) => {
        const style = getComputedStyle(node);
        const clipped =
          node.closest(".sr-only") !== null ||
          node.closest('[data-testid="run-error-open"]') !== null;
        return style.display !== "none" && style.visibility !== "hidden" && !clipped;
      })
      .filter((node) => node.scrollWidth > node.clientWidth)
      .slice(0, 8)
      .map((node) => ({
        tag: node.tagName.toLowerCase(),
        testId: node.getAttribute("data-testid"),
        className: node.className.toString().slice(0, 120),
        scrollWidth: node.scrollWidth,
        clientWidth: node.clientWidth,
      }));
  });
}

async function expectProjectAboveBody(browser: Browser) {
  const projectAboveBody = await browser.evaluate(() => {
    const detail = document.querySelector<HTMLElement>('[data-testid="task-detail"]');
    // Desktop moves project into the kebab; only mobile keeps it in the header.
    if (detail?.getAttribute("data-layout") === "desktop") return true;
    const project = document.querySelector<HTMLElement>('[data-testid="task-project-line"]');
    const body = document.querySelector<HTMLElement>('[data-testid="task-body-section"]');
    if (project === null || body === null) return null;
    return !!(project.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(projectAboveBody).toBe(true);
}
describe("task detail against a mocked state route", { serial: true }, () => {
  test("on a phone the browser back closes the task detail and keeps the tasks route", async ({
    app,
    browser,
    screen,
  }) => {
    await openSnapshot(app, browser, snapshot, 390, 844);
    await expect(screen.getByTestId("tasks-page")).toHaveAttribute("data-layout", "stack");

    await screen.getByRole("button", { name: "Open Ship the modal" }).tap();
    await expect(screen.getByTestId("task-detail")).toBeVisible();
    await browser.back();

    await expect(screen.getByTestId("task-detail")).toHaveCount(0);
    await expect(screen.getByTestId("task-list")).toBeVisible();
    expect(
      await browser.evaluate(() => ({
        pathname: window.location.pathname,
        page: new URLSearchParams(window.location.search).get("page"),
      })),
    ).toEqual({ pathname: "/", page: "tasks" });
  });

  test("on a desktop a selected task stays beside the list and Escape closes it", async ({
    app,
    browser,
    screen,
  }) => {
    await openSnapshot(app, browser, snapshot, 1280, 800);
    await expect(screen.getByTestId("tasks-page")).toHaveAttribute("data-layout", "split");
    await expect(screen.getByTestId("task-detail-empty")).toBeVisible();
    await screen.getByRole("button", { name: "Open proposal Clean the cache" }).tap();
    await expect(screen.getByTestId("task-detail-empty")).toHaveCount(0);
    await expect(screen.getByTestId("task-detail")).toHaveAttribute(
      "aria-label",
      "Clean the cache",
    );
    await expect(screen.getByTestId("task-detail-close")).toHaveCount(0);
    await expect(screen.getByTestId("task-t1").getByTestId("task-id-t1")).toHaveText("t1");
    await expect(screen.getByTestId("proposal-p1").getByTestId("task-id-p1")).toHaveText("p1");

    await screen.getByRole("button", { name: "Open Ship the modal" }).tap();
    await expect(screen.getByTestId("task-detail")).toHaveAttribute("aria-label", "Ship the modal");
    await expect(screen.getByTestId("task-detail")).toBeVisible();
    await expectProjectAboveBody(browser);
    await expect(screen.getByTestId("task-filters")).toHaveCount(0);

    const contentTop = await browser.evaluate(() => {
      const pane = document.querySelector<HTMLElement>('[data-testid="task-detail"]');
      const bar = document.querySelector<HTMLElement>('[data-testid="task-details-bar"]');
      const description = document.querySelector<HTMLElement>('[data-testid="task-body-section"]');
      if (pane === null || bar === null || description === null) {
        return null;
      }
      const paneBox = pane.getBoundingClientRect();
      const barBox = bar.getBoundingClientRect();
      return {
        barAbovePane: barBox.bottom <= paneBox.top,
        barGap: paneBox.top - barBox.bottom,
        label: (bar.textContent ?? "").includes("Task details"),
        hasTitle: document.querySelector('[data-testid="task-title"]') !== null,
        hasMeta: document.querySelector('[data-testid="task-header-meta"]') !== null,
        hasBlockers: document.querySelector('[data-testid="task-blockers-card"]') !== null,
        barBeforeBody: !!(
          bar.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING
        ),
      };
    });
    expect(contentTop).not.toBeNull();
    expect(contentTop?.barAbovePane).toBe(true);
    expect(contentTop?.barGap ?? Number.POSITIVE_INFINITY).toBeGreaterThanOrEqual(0);
    expect(contentTop?.barGap ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(20);
    expect(contentTop?.label).toBe(true);
    expect(contentTop?.hasTitle).toBe(false);
    expect(contentTop?.hasMeta).toBe(false);
    expect(contentTop?.barBeforeBody).toBe(true);
    expect(contentTop?.hasBlockers).toBe(false);

    const sides = await browser.evaluate(() => {
      const list = document.querySelector<HTMLElement>('[data-testid="task-list"]');
      const detail = document.querySelector<HTMLElement>('[data-testid="task-detail"]');
      if (list === null || detail === null) return null;
      return detail.getBoundingClientRect().left > list.getBoundingClientRect().right;
    });
    expect(sides).toBe(true);

    const body = await browser.evaluate(() => {
      const node = document.querySelector<HTMLElement>('[data-testid="task-body"]');
      const detail = document.querySelector<HTMLElement>('[data-testid="task-detail"]');
      const composer = document.querySelector<HTMLElement>('[data-testid="composer-dock"]');
      const rationale = document.querySelector<HTMLElement>('[data-testid="task-rationale"]');
      if (node === null || detail === null || composer === null || rationale === null) return null;
      const style = getComputedStyle(node);
      const detailBox = detail.getBoundingClientRect();
      return {
        overflowY: style.overflowY,
        maxHeight: style.maxHeight,
        flexGrow: style.flexGrow,
        height: node.clientHeight,
        scrolls: node.scrollHeight > node.clientHeight,
        cardOverflow: detail.scrollHeight - detail.clientHeight,
        rationaleInside: rationale.getBoundingClientRect().bottom <= detailBox.bottom + 1,
        aboveComposer: detailBox.bottom <= composer.getBoundingClientRect().top,
      };
    });
    expect(body?.overflowY).toBe("auto");
    expect(body?.maxHeight).not.toBe("none");
    expect(body?.flexGrow).toBe("1");
    expect(body?.height).toBeGreaterThan(0);
    expect(body?.scrolls).toBe(true);
    expect(body?.cardOverflow).toBeLessThanOrEqual(1);
    expect(body?.rationaleInside).toBe(true);
    expect(body?.aboveComposer).toBe(true);

    // Escape closes the desktop detail so the nav dock can return to full width.
    await browser.keyboard.press("Escape");
    await expect(screen.getByTestId("task-detail")).toHaveCount(0);
    await expect(screen.getByTestId("task-detail-empty")).toBeVisible();
  });

  test("on a wide screen the detail header spans the detail and plan columns", async ({
    app,
    browser,
    screen,
  }) => {
    await openSnapshot(app, browser, snapshot, 1440, 900);
    await screen.getByRole("button", { name: "Open Ship the modal" }).tap();
    await expect(screen.getByTestId("task-header")).toBeVisible();

    const wide = await browser.evaluate(() => {
      const header = document.querySelector<HTMLElement>('[data-testid="task-header"]');
      const detail = document.querySelector<HTMLElement>('[data-testid="tasks-mid-col"]');
      const plan = document.querySelector<HTMLElement>('[data-testid="tasks-chat-col"]');
      if (header === null || detail === null || plan === null) return null;
      const h = header.getBoundingClientRect();
      const d = detail.getBoundingClientRect();
      const p = plan.getBoundingClientRect();
      return {
        leftGap: Math.abs(h.left - d.left),
        rightGap: Math.abs(h.right - p.right),
        aboveDetail: h.top < d.top,
        abovePlan: h.top < p.top,
        detailWidth: d.width,
        planWidth: p.width,
      };
    });
    expect(wide).not.toBeNull();
    expect(wide?.leftGap ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(2);
    expect(wide?.rightGap ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(2);
    expect(wide?.aboveDetail).toBe(true);
    expect(wide?.abovePlan).toBe(true);
    expect(wide?.detailWidth ?? 0).toBeGreaterThanOrEqual(280);
    expect(wide?.planWidth ?? 0).toBeGreaterThanOrEqual(300);
    expect(wide?.planWidth ?? 0).toBeLessThanOrEqual(400);
    expect(await horizontalOverflow(browser)).toEqual([]);

    // The reporter judges the layout by eye, so keep the wide frame as evidence.
    await app.screenshot("tasks-wide");

    await browser.setViewport({ width: 1280, height: 800 });
    await expect(screen.getByTestId("tasks-page")).toHaveAttribute("data-layout", "split");
    expect(await horizontalOverflow(browser)).toEqual([]);

    await openSnapshot(app, browser, snapshot, 390, 844);
    await screen.getByRole("button", { name: "Open Ship the modal" }).tap();
    await expect(screen.getByTestId("task-detail")).toHaveAttribute("data-layout", "mobile");

    const phone = await browser.evaluate(() => {
      const header = document.querySelector<HTMLElement>('[data-testid="task-header"]');
      const detail = document.querySelector<HTMLElement>('[data-testid="task-detail"]');
      const plan = document.querySelector<HTMLElement>('[data-testid="task-plan-card"]');
      if (header === null || detail === null || plan === null) return null;
      const h = header.getBoundingClientRect();
      const d = detail.getBoundingClientRect();
      return {
        insideDetail: detail.contains(header),
        within:
          h.left >= d.left - 1 &&
          h.right <= d.right + 1 &&
          h.top >= d.top - 1 &&
          h.bottom <= d.bottom + 1,
        headerBeforePlan: !!(
          header.compareDocumentPosition(plan) & Node.DOCUMENT_POSITION_FOLLOWING
        ),
        detailBeforePlan: !!(
          detail.compareDocumentPosition(plan) & Node.DOCUMENT_POSITION_FOLLOWING
        ),
      };
    });
    expect(phone).not.toBeNull();
    expect(phone?.insideDetail).toBe(true);
    expect(phone?.within).toBe(true);
    expect(phone?.headerBeforePlan).toBe(true);
    expect(phone?.detailBeforePlan).toBe(true);
    expect(await horizontalOverflow(browser)).toEqual([]);
  });

  test("body markdown links and copy controls stay interactive until the text is clicked", async ({
    app,
    browser,
    screen,
  }) => {
    const code = "const answer = 42;";
    const payload = JSON.parse(JSON.stringify(snapshot));
    payload.tasks.tasks[0].body = `See [docs](https://example.com).\n\n\`\`\`ts\n${code}\n\`\`\``;
    await openSnapshot(app, browser, payload, 1280, 800);
    await screen.getByRole("button", { name: "Open Ship the modal" }).tap();

    const body = screen.getByTestId("task-body");
    const link = body.getByRole("link", { name: "docs" });
    await browser.evaluate(() => {
      const anchor = document.querySelector<HTMLAnchorElement>('[data-testid="task-body"] a');
      const target = window as unknown as { linkClicked?: boolean };
      anchor?.addEventListener("click", (event) => {
        event.preventDefault();
        target.linkClicked = true;
      });
      return true;
    });
    await link.focus();
    await expect(screen.getByTestId("task-body-input")).toHaveCount(0);
    await link.press("Enter");
    await expect
      .poll(() =>
        browser.evaluate(
          () => (window as unknown as { linkClicked?: boolean }).linkClicked ?? false,
        ),
      )
      .toBe(true);
    await expect(screen.getByTestId("task-body-input")).toHaveCount(0);
    await browser.evaluate(() => {
      (window as unknown as { linkClicked?: boolean }).linkClicked = false;
      return true;
    });
    await link.click();
    await expect
      .poll(() =>
        browser.evaluate(
          () => (window as unknown as { linkClicked?: boolean }).linkClicked ?? false,
        ),
      )
      .toBe(true);
    await expect(screen.getByTestId("task-body-input")).toHaveCount(0);

    await browser.evaluate(() => {
      const target = window as unknown as { copied?: string };
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            target.copied = text;
          },
        },
      });
      return true;
    });
    const copy = body.getByRole("button");
    await copy.focus();
    await browser.keyboard.press("Space");
    await expect(copy).toHaveAttribute("aria-label", "Copied");
    expect(
      await browser.evaluate(() => (window as unknown as { copied?: string }).copied ?? null),
    ).toBe(code);
    await expect(screen.getByTestId("task-body-input")).toHaveCount(0);
  });
});
