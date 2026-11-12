import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "@e2e-dev/web";
import { expect, type Screen } from "e2e";

const FIXTURE_TITLE =
  "Design a card-based task details view that stays readable on a 390px phone and does not waste the desktop composer column";

async function themeVantablack(
  app: { open: (url: string) => Promise<void> },
  browser: { evaluate: <T>(fn: () => T | Promise<T>) => Promise<T> },
  path: string,
) {
  await app.open(path);
  const themed = await browser.evaluate(async () => {
    const themeResponse = await fetch("/api/theme", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "audit-vantablack" }),
    });
    if (!themeResponse.ok) throw new Error(await themeResponse.text());
    return true;
  });
  expect(themed).toBe(true);
  await app.open(path);
  await expect
    .poll(() => browser.evaluate(() => document.documentElement.dataset.mode ?? ""))
    .toBe("dark");
}

async function openFixtureTask(screen: Pick<Screen, "getByTestId" | "getByRole">) {
  const detail = screen.getByTestId("task-detail");
  if ((await detail.count()) === 0) {
    await screen.getByRole("button", { name: `Open ${FIXTURE_TITLE}` }).tap();
  }
}

async function waitMs(browser: { evaluate: <T>(fn: () => T | Promise<T>) => Promise<T> }) {
  await browser.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(true), 280);
      }),
  );
}

async function dockBox(browser: { evaluate: <T>(fn: () => T | Promise<T>) => Promise<T> }) {
  return browser.evaluate(() => {
    const dock = document.querySelector<HTMLElement>('[data-testid="composer-dock"]');
    const shell = document.querySelector(".chat-shell");
    if (!(dock instanceof HTMLElement)) return null;
    const box = dock.getBoundingClientRect();
    const style = getComputedStyle(dock);
    return {
      left: box.left,
      width: box.width,
      bottom: box.bottom,
      position: style.position,
      transition: style.transition,
      dockAttr: shell?.getAttribute("data-tasks-dock") ?? null,
      bandAttr: shell?.hasAttribute("data-tasks-band") ?? false,
    };
  });
}

function expectSameFooter(
  actual: { left: number; width: number; bottom: number } | null,
  expected: { left: number; width: number; bottom: number } | null,
  label: string,
) {
  expect(actual, label).not.toBeNull();
  expect(expected, "chat-page footer").not.toBeNull();
  if (actual === null || expected === null) return;
  expect(Math.abs(actual.left - expected.left), `${label} left`).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.width - expected.width), `${label} width`).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.bottom - expected.bottom), `${label} bottom`).toBeLessThanOrEqual(1);
}

async function tabBorders(browser: { evaluate: <T>(fn: () => T | Promise<T>) => Promise<T> }) {
  return browser.evaluate(() => {
    const plan = document.querySelector<HTMLElement>('[data-testid="task-tab-plan"]');
    const chat = document.querySelector<HTMLElement>('[data-testid="task-tab-chat"]');
    if (!(plan instanceof HTMLElement) || !(chat instanceof HTMLElement)) return null;
    const probe = document.createElement("span");
    probe.style.color = "var(--foreground)";
    document.body.append(probe);
    const foreground = getComputedStyle(probe).color;
    probe.remove();
    const read = (node: HTMLElement) => {
      const style = getComputedStyle(node);
      return {
        selected: node.getAttribute("aria-selected") === "true",
        width: Number.parseFloat(style.borderBottomWidth),
        color: style.borderBottomColor,
      };
    };
    return { foreground, plan: read(plan), chat: read(chat) };
  });
}

function expectSelectedTabBorder(
  tabs: Awaited<ReturnType<typeof tabBorders>>,
  selected: "plan" | "chat",
) {
  expect(tabs).not.toBeNull();
  if (tabs === null) return;
  const active = tabs[selected];
  const idle = tabs[selected === "plan" ? "chat" : "plan"];
  expect(active.selected).toBe(true);
  expect(idle.selected).toBe(false);
  expect(active.width).toBeGreaterThanOrEqual(2);
  expect(active.color).toBe(tabs.foreground);
  const idleTransparent =
    idle.width === 0 ||
    idle.color === "transparent" ||
    idle.color === "rgba(0, 0, 0, 0)" ||
    /rgba?\(\s*0,\s*0,\s*0,\s*0\s*\)/.test(idle.color);
  expect(idleTransparent, `unselected ${idle.color} width ${idle.width}`).toBe(true);
}

async function mobileCardEdges(browser: { evaluate: <T>(fn: () => T | Promise<T>) => Promise<T> }) {
  return browser.evaluate(() => {
    const headerNode = document.querySelector("[data-testid=task-header]");
    const bodyIds = ["task-subtasks-card", "task-plan-card"] as const;
    const bodyNodes: HTMLElement[] = [];
    for (const id of bodyIds) {
      const node = document.querySelector(`[data-testid=${id}]`);
      if (!(node instanceof HTMLElement)) return null;
      bodyNodes.push(node);
    }
    if (!(headerNode instanceof HTMLElement) || bodyNodes[0] === undefined) return null;
    const headerBox = headerNode.getBoundingClientRect();
    const firstBody = bodyNodes[0].getBoundingClientRect();
    const tabs = document.querySelector("[role=tablist]");
    const tabsBox = tabs instanceof HTMLElement ? tabs.getBoundingClientRect() : null;
    return {
      viewport: window.innerWidth,
      header: { left: headerBox.left, right: headerBox.right, top: headerBox.top },
      body: bodyNodes.map((node, index) => {
        const box = node.getBoundingClientRect();
        return { id: bodyIds[index], left: box.left, right: box.right };
      }),
      gap: firstBody.top - headerBox.bottom,
      leftGutter: firstBody.left,
      rightGutter: window.innerWidth - firstBody.right,
      tabsFlushLeft: tabsBox !== null && Math.abs(tabsBox.left - headerBox.left) <= 1,
      tabsFlushRight: tabsBox !== null && Math.abs(tabsBox.right - headerBox.right) <= 1,
      tabsFlushBottom: tabsBox !== null && Math.abs(tabsBox.bottom - headerBox.bottom) <= 1,
    };
  });
}

async function desktopAlignment(browser: {
  evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
}) {
  return browser.evaluate(() => {
    const list = document.querySelector("[data-testid=task-section-active]");
    const header = document.querySelector("[data-testid=task-header]");
    const chat = document.querySelector("[data-testid=task-agent-chat]");
    const listTop = list instanceof HTMLElement ? list.getBoundingClientRect().top : null;
    const headerTop = header instanceof HTMLElement ? header.getBoundingClientRect().top : null;
    const chatTop = chat instanceof HTMLElement ? chat.getBoundingClientRect().top : null;
    return {
      listTop,
      headerTop,
      chatTop,
    };
  });
}

test("captures v4g chat-identical dock, header row, and tab border in vantablack", {
  timeout: 300_000,
}, async ({ app, browser, screen }) => {
  const theme = resolve(".e2e/home/.config/omarchy/themes/audit-vantablack");
  await mkdir(theme, { recursive: true });
  await copyFile(resolve("themes/omarchy/vantablack/colors.toml"), resolve(theme, "colors.toml"));

  await browser.setViewport({ width: 1280, height: 800 });
  await themeVantablack(app, browser, "/?page=chat");
  await expect(screen.getByTestId("composer-dock")).toBeVisible();
  await waitMs(browser);
  const chatFooter = await dockBox(browser);
  expect(chatFooter).not.toBeNull();
  await app.screenshot("chat-page");

  await app.open("/?page=tasks&fixture=1");
  await expect
    .poll(() => browser.evaluate(() => document.documentElement.dataset.mode ?? ""))
    .toBe("dark");
  await expect(screen.getByTestId("tasks-page")).toHaveAttribute("data-layout", "split");
  await openFixtureTask(screen);
  await expect(screen.getByTestId("task-detail")).toBeVisible();
  await expect(screen.getByTestId("task-times")).toContainText(
    /created \d{2}\.\d{2}\.\d{4} \d{2}:\d{2}/,
  );
  await expect(screen.getByTestId("task-created-by")).toHaveCount(0);
  await expect(screen.getByTestId("task-blockers-card")).toHaveCount(0);
  await expect(screen.getByTestId("task-subtasks-card")).toBeVisible();
  await expect(screen.getByTestId("task-plan-card")).toBeVisible();
  await expect(screen.getByTestId("task-plan-card").getByText("Plan", { exact: true })).toHaveCount(
    0,
  );
  await expect(
    screen.getByTestId("task-subtasks-card").getByText("Done", { exact: true }),
  ).toHaveCount(0);
  const headerOrder = await browser.evaluate(() => {
    const meta = document.querySelector("[data-testid=task-header-meta]");
    const title = document.querySelector("[data-testid=task-title]");
    const times = document.querySelector("[data-testid=task-times]");
    if (
      !(meta instanceof HTMLElement) ||
      !(title instanceof HTMLElement) ||
      !(times instanceof HTMLElement)
    ) {
      return null;
    }
    return {
      titleAfterMeta: !!(meta.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING),
      timesInMeta: meta.contains(times),
      timesWithMeta:
        Math.abs(times.getBoundingClientRect().top - meta.getBoundingClientRect().top) <= 4,
    };
  });
  expect(headerOrder).toEqual({ titleAfterMeta: true, timesInMeta: true, timesWithMeta: true });
  await expect(screen.getByTestId("task-agent-input")).toBeVisible();
  await expect(screen.getByRole("textbox", "New task")).toHaveCount(0);
  const openDock = await dockBox(browser);
  expect(openDock?.dockAttr).toBeNull();
  expect(openDock?.bandAttr).toBe(false);
  expect(openDock?.position).not.toBe("absolute");
  expect(openDock?.transition ?? "").not.toMatch(/left|width/);
  expectSameFooter(openDock, chatFooter, "tasks open footer");
  const openAlign = await desktopAlignment(browser);
  expect(openAlign).not.toBeNull();
  if (openAlign !== null) {
    if (openAlign.listTop !== null && openAlign.headerTop !== null) {
      expect(Math.abs(openAlign.headerTop - openAlign.listTop)).toBeLessThanOrEqual(2);
    }
    if (openAlign.listTop !== null && openAlign.chatTop !== null) {
      expect(Math.abs(openAlign.chatTop - openAlign.listTop)).toBeLessThanOrEqual(2);
    }
  }
  await waitMs(browser);
  await app.screenshot("desktop-open");

  await screen.getByTestId("task-detail-back").tap();
  await expect(screen.getByTestId("task-detail")).toHaveCount(0);
  await expect(screen.getByRole("textbox", "New task")).toBeVisible();
  await expect(screen.getByTestId("task-detail-empty")).toBeVisible();
  const closedDock = await dockBox(browser);
  expect(closedDock?.bandAttr).toBe(false);
  expectSameFooter(closedDock, chatFooter, "tasks closed footer");
  await waitMs(browser);
  await app.screenshot("desktop-closed");

  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks&fixture=1");
  await expect
    .poll(() => browser.evaluate(() => document.documentElement.dataset.mode ?? ""))
    .toBe("dark");
  await openFixtureTask(screen);
  await expect(screen.getByTestId("task-detail")).toBeVisible();
  await expect(screen.getByTestId("task-tab-plan")).toHaveAttribute("aria-selected", "true");
  await expect(screen.getByTestId("task-blockers-card")).toHaveCount(0);
  await expect(screen.getByTestId("task-subtasks-card")).toBeVisible();
  await expect(screen.getByTestId("task-agent-input")).toBeVisible();

  for (const width of [360, 390, 430]) {
    await browser.setViewport({ width, height: 844 });
    await expect(screen.getByTestId("task-detail")).toBeVisible();
    const edges = await mobileCardEdges(browser);
    expect(edges).not.toBeNull();
    if (edges === null) continue;
    expect(Math.abs(edges.header.left), `${width}px header left`).toBeLessThanOrEqual(1);
    expect(
      Math.abs(edges.header.right - edges.viewport),
      `${width}px header right`,
    ).toBeLessThanOrEqual(1);
    expect(Math.abs(edges.header.top), `${width}px header top`).toBeLessThanOrEqual(1);
    const firstBody = edges.body[0];
    expect(firstBody).toBeDefined();
    if (firstBody === undefined) continue;
    for (const rect of edges.body) {
      expect(
        Math.abs(rect.left - firstBody.left),
        `${width}px ${rect.id} left`,
      ).toBeLessThanOrEqual(1);
      expect(
        Math.abs(rect.right - firstBody.right),
        `${width}px ${rect.id} right`,
      ).toBeLessThanOrEqual(1);
    }
    expect(Math.abs(edges.leftGutter - edges.gap), `${width}px left gutter`).toBeLessThanOrEqual(1);
    expect(Math.abs(edges.rightGutter - edges.gap), `${width}px right gutter`).toBeLessThanOrEqual(
      1,
    );
    if (width === 390) {
      expect(edges.tabsFlushLeft).toBe(true);
      expect(edges.tabsFlushRight).toBe(true);
      expect(edges.tabsFlushBottom).toBe(true);
    }
  }

  await browser.setViewport({ width: 390, height: 844 });
  expectSelectedTabBorder(await tabBorders(browser), "plan");
  await waitMs(browser);
  await app.screenshot("mobile-plan");

  await screen.getByTestId("task-tab-chat").tap();
  await expect(screen.getByTestId("task-tab-chat")).toHaveAttribute("aria-selected", "true");
  await expect(screen.getByTestId("task-agent-chat")).toBeVisible();
  expectSelectedTabBorder(await tabBorders(browser), "chat");
  await waitMs(browser);
  await app.screenshot("mobile-chat");
});
