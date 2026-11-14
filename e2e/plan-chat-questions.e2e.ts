import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createOpenTask, openTaskChatTab, removeTasks } from "./tasks-helpers";

const FIRST_QUESTIONS = [
  {
    id: "layout",
    prompt: "Which layout should the inbox use?",
    kind: "single",
    options: [
      { value: "split", label: "Split layout" },
      { value: "stack", label: "Stacked layout" },
    ],
  },
  {
    id: "parts",
    prompt: "Which parts should move?",
    kind: "multi",
    options: [
      { value: "sidebar", label: "Sidebar" },
      { value: "timeline", label: "Timeline" },
    ],
  },
  {
    id: "notes",
    prompt: "What should I keep in mind?",
    kind: "text",
  },
  {
    id: "density",
    prompt: "How dense should the list feel?",
    kind: "single",
    options: [
      { value: "compact", label: "Compact rows" },
      { value: "roomy", label: "Roomy rows" },
    ],
  },
  {
    id: "theme",
    prompt: "Which theme should the inbox use?",
    kind: "single",
    options: [
      { value: "light", label: "Light theme" },
      { value: "dark", label: "Dark theme" },
    ],
  },
] as const;

const SECOND_QUESTIONS = [
  {
    id: "s1",
    prompt: "Search where?",
    kind: "single",
    options: [
      { value: "header", label: "Header" },
      { value: "list", label: "List" },
    ],
  },
  {
    id: "s2",
    prompt: "Preview?",
    kind: "single",
    options: [
      { value: "sender", label: "Sender" },
      { value: "subject", label: "Subject" },
    ],
  },
  {
    id: "s3",
    prompt: "Unread count?",
    kind: "single",
    options: [
      { value: "yes", label: "Keep" },
      { value: "no", label: "Drop" },
    ],
  },
] as const;

interface PanelGeometry {
  height: number;
  clientHeight: number;
  scrollHeight: number;
  top: number;
  bottom: number;
}

interface TranscriptGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  distance: number;
  scrollerTop: number;
  scrollerBottom: number;
  composerTop: number | null;
  anchorId: string | null;
  anchorOffset: number | null;
  visibleMessageIds: string[];
  messagesAbovePanel: number;
  panel: PanelGeometry | null;
  panelOverflow: string[];
  panelSetId: string | null;
}

function readTranscript(browser: Browser): Promise<TranscriptGeometry | null> {
  return browser.evaluate(() => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="task-agent-transcript"]');
    if (scroller === null) return null;
    const scrollerRect = scroller.getBoundingClientRect();
    const rows = [...scroller.querySelectorAll<HTMLElement>("[data-message-id]")];
    const visible = rows.filter((row) => {
      const rect = row.getBoundingClientRect();
      return rect.bottom > scrollerRect.top + 1 && rect.top < scrollerRect.bottom - 1;
    });
    const anchor =
      visible.find((row) => row.getBoundingClientRect().top >= scrollerRect.top - 1) ?? visible[0];
    const panel = document.querySelector<HTMLElement>('[data-testid="task-questions-panel"]');
    const panelRect = panel?.getBoundingClientRect() ?? null;
    const composer = document.querySelector<HTMLElement>('[data-testid="composer-form"]');
    return {
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      distance: scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
      scrollerTop: scrollerRect.top,
      scrollerBottom: scrollerRect.bottom,
      composerTop: composer?.getBoundingClientRect().top ?? null,
      anchorId: anchor?.dataset.messageId ?? null,
      anchorOffset:
        anchor === undefined ? null : anchor.getBoundingClientRect().top - scrollerRect.top,
      visibleMessageIds: visible.flatMap((row) =>
        row.dataset.messageId === undefined ? [] : [row.dataset.messageId],
      ),
      messagesAbovePanel:
        panelRect === null
          ? 0
          : rows.filter((row) => {
              const rect = row.getBoundingClientRect();
              return rect.bottom > scrollerRect.top + 1 && rect.top < panelRect.top - 1;
            }).length,
      panel:
        panelRect === null
          ? null
          : {
              height: panelRect.height,
              clientHeight: panel?.clientHeight ?? 0,
              scrollHeight: panel?.scrollHeight ?? 0,
              top: panelRect.top,
              bottom: panelRect.bottom,
            },
      panelOverflow:
        panel === null
          ? []
          : [panel, ...panel.querySelectorAll<HTMLElement>("*")].flatMap((element) =>
              element.scrollWidth > element.clientWidth + 1
                ? [
                    `${element.tagName.toLowerCase()}${
                      element.dataset.testid === undefined ? "" : `[${element.dataset.testid}]`
                    } ${element.scrollWidth}>${element.clientWidth}`,
                  ]
                : [],
            ),
      panelSetId: panel?.dataset.setId ?? null,
    };
  });
}

async function settle(browser: Browser): Promise<void> {
  await browser.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
      }),
  );
}

async function taskIdFor(browser: Browser, title: string): Promise<string> {
  const id = await browser.evaluate(async (taskTitle) => {
    const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
      tasks: Array<{ id: string; title: string }>;
    };
    return ledger.tasks.find((task) => task.title === taskTitle)?.id ?? null;
  }, title);
  expect(id).not.toBeNull();
  if (id === null) throw new Error("task was not created");
  return id;
}

async function postPlanMessage(browser: Browser, taskId: string, text: string): Promise<number> {
  return browser.evaluate(
    async ({ id, prompt }) => {
      const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: prompt }),
      });
      return response.status;
    },
    { id: taskId, prompt: text },
  );
}

async function scrollTranscript(browser: Browser, fraction: number): Promise<void> {
  await browser.evaluate((part) => {
    const scroller = document.querySelector<HTMLElement>('[data-testid="task-agent-transcript"]');
    if (scroller === null) return false;
    scroller.scrollTop = Math.floor((scroller.scrollHeight - scroller.clientHeight) * part);
    scroller.dispatchEvent(new Event("scroll"));
    return true;
  }, fraction);
  await settle(browser);
}

async function answerQuestions(
  browser: Browser,
  taskId: string,
  setId: string,
  answers: Array<{ id: string; values: string[]; text: string }>,
): Promise<number> {
  return browser.evaluate(
    async ({ id, set, payload }) => {
      const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/questions/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setId: set, answers: payload }),
      });
      return response.status;
    },
    { id: taskId, set: setId, payload: answers },
  );
}

test("the planning questions card never steals the transcript", {
  timeout: 300_000,
}, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks");
  const title = `Plan questions scroll ${Date.now()}`;
  await createOpenTask(screen, title, { project: "pi-ui" });
  await openTaskChatTab(screen);
  await expect(screen.getByTestId("task-agent-chat")).toBeVisible();
  const taskId = await taskIdFor(browser, title);

  // Make the plan transcript taller than the phone viewport before asking anything.
  for (let index = 0; index < 6; index += 1) {
    expect(await postPlanMessage(browser, taskId, `Planning row ${index} for ${title}`)).toBe(202);
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
    .toBeGreaterThanOrEqual(14);
  await expect(screen.getByTestId("task-agent-status")).toHaveText("idle", { timeout: 60_000 });

  // 1. Arrival while reading the middle: the card appears below, the offset does not move.
  await scrollTranscript(browser, 0.45);
  const beforeArrival = await readTranscript(browser);
  expect(beforeArrival).not.toBeNull();
  if (beforeArrival === null) return;
  expect(beforeArrival.distance).toBeGreaterThan(100);
  expect(beforeArrival.anchorId).not.toBeNull();

  expect(
    await postPlanMessage(
      browser,
      taskId,
      `TOOLCALLS ${JSON.stringify([
        { name: "append_questions", arguments: { questions: FIRST_QUESTIONS } },
      ])}`,
    ),
  ).toBe(202);

  const panel = screen.getByTestId("task-questions-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await settle(browser);
  const afterArrival = await readTranscript(browser);
  expect(afterArrival).not.toBeNull();
  if (afterArrival === null) return;

  expect(afterArrival.scrollTop).toBe(beforeArrival.scrollTop);
  expect(
    Math.abs((afterArrival.anchorOffset ?? 0) - (beforeArrival.anchorOffset ?? 0)),
  ).toBeLessThanOrEqual(1);
  expect(afterArrival.visibleMessageIds).toContain(beforeArrival.anchorId);
  expect(afterArrival.panelSetId).not.toBeNull();

  // 3. The questions card takes its natural height: no cap, no inner scrollbar.
  expect(afterArrival.panel).not.toBeNull();
  if (afterArrival.panel === null) return;
  expect(afterArrival.panel.scrollHeight).toBe(afterArrival.panel.clientHeight);
  expect(afterArrival.panelOverflow).toEqual([]);
  expect(afterArrival.scrollHeight).toBeGreaterThan(afterArrival.clientHeight);

  // 4. Answering while detached rewrites no transcript offset.
  const beforeAnswer = await readTranscript(browser);
  expect(beforeAnswer).not.toBeNull();
  if (beforeAnswer === null || afterArrival.panelSetId === null) return;
  expect(
    await answerQuestions(browser, taskId, afterArrival.panelSetId, [
      { id: "layout", values: ["split"], text: "" },
      { id: "parts", values: ["sidebar"], text: "" },
      { id: "notes", values: [], text: "Keep the phone width in mind." },
      { id: "density", values: ["compact"], text: "" },
      { id: "theme", values: ["light"], text: "" },
    ]),
  ).toBe(200);
  await expect(panel).toHaveCount(0, { timeout: 30_000 });
  const afterAnswer = await readTranscript(browser);
  expect(afterAnswer).not.toBeNull();
  if (afterAnswer === null) return;
  expect(afterAnswer.scrollTop).toBe(beforeAnswer.scrollTop);
  expect(afterAnswer.visibleMessageIds).toContain(beforeAnswer.anchorId);

  // 2. Arrival while at the bottom still follows the new content, as before.
  await scrollTranscript(browser, 1);
  await expect
    .poll(async () => (await readTranscript(browser))?.distance ?? 99)
    .toBeLessThanOrEqual(8);
  const beforeBottomArrival = await readTranscript(browser);
  expect(beforeBottomArrival).not.toBeNull();
  if (beforeBottomArrival === null) return;

  expect(
    await postPlanMessage(
      browser,
      taskId,
      `TOOLCALLS ${JSON.stringify([
        { name: "append_questions", arguments: { questions: SECOND_QUESTIONS } },
      ])}`,
    ),
  ).toBe(202);
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(async () => (await readTranscript(browser))?.panelSetId ?? null)
    .not.toBe(afterArrival.panelSetId);
  await settle(browser);
  const afterBottomArrival = await readTranscript(browser);
  expect(afterBottomArrival).not.toBeNull();
  if (afterBottomArrival === null) return;
  expect(afterBottomArrival.distance).toBeLessThanOrEqual(8);
  expect(afterBottomArrival.scrollTop).toBeGreaterThanOrEqual(beforeBottomArrival.scrollTop);
  expect(afterBottomArrival.panel).not.toBeNull();
  if (afterBottomArrival.panel === null) return;
  expect(afterBottomArrival.panel.scrollHeight).toBe(afterBottomArrival.panel.clientHeight);
  expect(afterBottomArrival.panelOverflow).toEqual([]);

  // 5. On the phone the card's end is reachable above the composer, and the
  // pane, not the card, is what scrolls.
  expect(afterBottomArrival.panel.bottom).toBeLessThanOrEqual(
    afterBottomArrival.scrollerBottom + 1,
  );
  expect(afterBottomArrival.composerTop).not.toBeNull();
  if (afterBottomArrival.composerTop !== null) {
    expect(
      Math.abs(afterBottomArrival.composerTop - (beforeBottomArrival.composerTop ?? 0)),
    ).toBeLessThanOrEqual(1);
  }

  for (const question of SECOND_QUESTIONS) {
    await screen.getByTestId(`question-${question.id}-${question.options[0].value}`).tap();
  }
  const send = screen.getByTestId("task-questions-send");
  await expect(send).toBeEnabled();
  await send.tap();
  await expect(panel).toHaveCount(0, { timeout: 30_000 });
  await expect
    .poll(async () => (await readTranscript(browser))?.distance ?? 99)
    .toBeLessThanOrEqual(8);

  await removeTasks(browser, [title]);
});
