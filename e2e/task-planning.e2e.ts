import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { backToTaskList, createOpenTask, openTaskChatTab } from "./tasks-helpers";

test("a live plan run shows Planning on the card and detail, then clears without a reload", {
  timeout: 180_000,
}, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks");
  const title = `Plan the planning badge ${Date.now()}`;
  await createOpenTask(screen, title, { project: "pi-ui" });

  const taskId = await browser.evaluate(async (taskTitle) => {
    const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
      tasks: Array<{ id: string; title: string }>;
    };
    return ledger.tasks.find((task) => task.title === taskTitle)?.id ?? null;
  }, title);
  expect(taskId).not.toBeNull();
  if (taskId === null) return;

  await screen.getByTestId("task-detail-back").tap();
  await expect(screen.getByRole("textbox", "New task")).toBeVisible();

  const started = await browser.evaluate(async (id) => {
    const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "SLOW hold the plan run open" }),
    });
    return response.status;
  }, taskId);
  expect(started).toBe(202);

  await expect
    .poll(
      () =>
        browser.evaluate(async (id) => {
          const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
            planning?: string[];
            tasks: Array<{ id: string; planning?: boolean }>;
          };
          return (
            (ledger.planning ?? []).includes(id) &&
            ledger.tasks.find((task) => task.id === id)?.planning === true
          );
        }, taskId),
      { timeout: 30_000 },
    )
    .toBe(true);

  const card = screen.getByTestId(`task-${taskId}`);
  await expect(card.getByTestId(`task-planning-${taskId}`)).toHaveText("Planning");

  // The extra chip must not wrap the rest of the card's meta at phone width.
  const layout = await browser.evaluate((id) => {
    const cardElement = document.querySelector<HTMLElement>(
      `[data-testid="task-${id}"] [data-task-card]`,
    );
    const meta = cardElement?.querySelector<HTMLElement>('[data-testid="task-card-meta"]');
    if (!(meta instanceof HTMLElement)) return null;
    const tops = [...meta.children]
      .filter((child): child is HTMLElement => child instanceof HTMLElement)
      .map((child) => child.getBoundingClientRect().top);
    return {
      metaHeight: meta.getBoundingClientRect().height,
      lineSpread: tops.length === 0 ? 0 : Math.max(...tops) - Math.min(...tops),
      planningLabel:
        meta.querySelector<HTMLElement>(`[data-testid="task-planning-${id}"]`)?.textContent ?? "",
    };
  }, taskId);
  expect(layout?.planningLabel).toContain("Planning");
  expect(layout?.lineSpread ?? 99).toBeLessThanOrEqual(1);
  expect(layout?.metaHeight ?? 99).toBeLessThanOrEqual(20);

  await screen.getByRole("button", { name: `Open ${title}` }).tap();
  await expect(screen.getByTestId(`task-detail-planning-${taskId}`)).toHaveText("Planning");

  // The desktop detail header carries the same live chip.
  await browser.setViewport({ width: 1280, height: 800 });
  await expect(screen.getByTestId(`task-detail-planning-${taskId}`)).toHaveText("Planning");
  await browser.setViewport({ width: 390, height: 844 });
  await backToTaskList(screen);
  await expect(card.getByTestId(`task-planning-${taskId}`)).toBeVisible();

  const stopped = await browser.evaluate(async (id) => {
    const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/chat/stop`, {
      method: "POST",
    });
    return response.status;
  }, taskId);
  expect(stopped).toBe(200);

  await expect
    .poll(
      () =>
        browser.evaluate(async (id) => {
          const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
            planning?: string[];
            tasks: Array<{ id: string; planning?: boolean }>;
          };
          return (
            !(ledger.planning ?? []).includes(id) &&
            ledger.tasks.find((task) => task.id === id)?.planning === false
          );
        }, taskId),
      { timeout: 30_000 },
    )
    .toBe(true);
  await expect(card.getByTestId(`task-planning-${taskId}`)).toHaveCount(0);
});

test("the plan transcript keeps its rows and scroll, and a live steer is not lost", {
  timeout: 240_000,
}, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks");
  const title = `Plan transcript continuity ${Date.now()}`;
  await createOpenTask(screen, title);
  await openTaskChatTab(screen);
  await expect(screen.getByTestId("task-agent-chat")).toBeVisible();

  const taskId = await browser.evaluate(async (taskTitle) => {
    const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
      tasks: Array<{ id: string; title: string }>;
    };
    return ledger.tasks.find((task) => task.title === taskTitle)?.id ?? null;
  }, title);
  expect(taskId).not.toBeNull();
  if (taskId === null) return;

  // Enough turns that the transcript scrolls; each turn leaves a user row and a reply.
  for (let index = 0; index < 8; index += 1) {
    const status = await browser.evaluate(
      async ({ id, text }) => {
        const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        return response.status;
      },
      { id: taskId, text: `Transcript row ${index} ${title}` },
    );
    expect(status).toBe(202);
  }
  await expect
    .poll(
      () =>
        browser.evaluate(
          () =>
            document.querySelectorAll('[data-testid="task-agent-transcript"] [data-message-id]')
              .length,
        ),
      { timeout: 60_000 },
    )
    .toBeGreaterThanOrEqual(16);
  await expect(screen.getByTestId("task-agent-status")).toHaveText("idle", { timeout: 30_000 });

  const scrolled = await browser.evaluate(() => {
    const element = document.querySelector<HTMLElement>('[data-testid="task-agent-transcript"]');
    if (element === null) return null;
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 40);
    return {
      scrollTop: element.scrollTop,
      rows: element.querySelectorAll("[data-message-id]").length,
    };
  });
  expect(scrolled).not.toBeNull();
  if (scrolled === null) return;
  expect(scrolled.scrollTop).toBeGreaterThan(0);

  await screen.getByTestId("task-tab-plan").tap();
  await expect(screen.getByTestId("task-tab-plan")).toHaveAttribute("aria-selected", "true");
  await screen.getByTestId("task-tab-chat").tap();
  await expect(screen.getByTestId("task-tab-chat")).toHaveAttribute("aria-selected", "true");
  const restored = await browser.evaluate(() => {
    const element = document.querySelector<HTMLElement>('[data-testid="task-agent-transcript"]');
    return element === null
      ? null
      : {
          scrollTop: element.scrollTop,
          rows: element.querySelectorAll("[data-message-id]").length,
        };
  });
  expect(restored).not.toBeNull();
  expect(restored?.rows).toBe(scrolled.rows);
  expect(Math.abs((restored?.scrollTop ?? 0) - scrolled.scrollTop)).toBeLessThanOrEqual(2);

  // A bash tool call keeps the plan run live until the release file appears, so the steer
  // can be watched from pending bubble to placed row.
  const release = join(tmpdir(), `pi-ui-plan-steer-${Date.now()}-${randomUUID()}`);
  const wait = `for i in $(seq 600); do [ -e '${release}' ] && break; sleep 0.1; done; echo released`;
  const calls = [{ name: "bash", arguments: { command: wait } }];
  const started = await browser.evaluate(
    async ({ id, text }) => {
      const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      return response.status;
    },
    { id: taskId, text: `TOOLCALLS ${JSON.stringify(calls)}` },
  );
  expect(started).toBe(202);
  await expect(screen.getByTestId("task-agent-status")).toHaveAttribute("data-open", "true", {
    timeout: 30_000,
  });
  await expect(screen.getByTestId("task-agent-status")).toContainText("Planning");

  const steer = `plan steer ${Date.now()}`;
  const input = screen.getByTestId("task-agent-input");
  await input.fill(steer);
  await screen.getByTestId("task-agent-send").tap();
  const pending = browser.locator('[data-pending-steer="true"]').filter({ hasText: steer });
  await expect(pending).toBeVisible({ timeout: 20_000 });

  // A tab switch is not a content change: the pending steer must still be there on return.
  await screen.getByTestId("task-tab-plan").tap();
  await screen.getByTestId("task-tab-chat").tap();
  await expect(pending).toBeVisible();

  try {
    writeFileSync(release, "");
    // The delivered row replaces the pending bubble; exactly one copy remains.
    const placed = browser.locator('[data-role="user"]').filter({ hasText: steer });
    await expect(placed).toHaveCount(1, { timeout: 40_000 });
    await expect(pending).toHaveCount(0, { timeout: 20_000 });
  } finally {
    writeFileSync(release, "");
    await browser.evaluate(async (id) => {
      await fetch(`/api/tasks/${encodeURIComponent(id)}/chat/stop`, { method: "POST" });
      return true;
    }, taskId);
  }
});
