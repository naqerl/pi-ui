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

const OTHER_QUESTIONS = [
  {
    id: "transport",
    prompt: "How should the client connect?",
    kind: "single",
    allowOther: true,
    options: [
      { value: "http", label: "HTTP" },
      { value: "ws", label: "WebSocket" },
    ],
  },
  {
    id: "storage",
    prompt: "Where should the cache live?",
    kind: "single",
    allowOther: true,
    options: [
      { value: "disk", label: "On disk" },
      { value: "memory", label: "In memory" },
    ],
  },
] as const;

interface AnswerSubmission {
  setId: string;
  answers: Array<{ id: string; values: string[]; text: string }>;
}

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

async function stopPlanRun(browser: Browser, taskId: string): Promise<number> {
  return browser.evaluate(
    async (id) =>
      (
        await fetch(`/api/tasks/${encodeURIComponent(id)}/chat/stop`, {
          method: "POST",
        })
      ).status,
    taskId,
  );
}

/** Any card chrome on the status line's ancestors between it and the plan chat. */
function readStatusChrome(
  browser: Browser,
): Promise<Array<{ testId: string | null; chrome: string }>> {
  return browser.evaluate(() => {
    const status = document.querySelector<HTMLElement>('[data-testid="task-agent-status"]');
    if (status === null) return [];
    const chat = document.querySelector<HTMLElement>('[data-testid="task-agent-chat"]');
    const found: Array<{ testId: string | null; chrome: string }> = [];
    let node = status.parentElement;
    while (node !== null && node !== chat && node !== document.body) {
      const style = getComputedStyle(node);
      const chrome: string[] = [];
      if (
        style.position === "absolute" ||
        style.position === "fixed" ||
        style.position === "sticky"
      ) {
        chrome.push(`position:${style.position}`);
      }
      if (style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent") {
        chrome.push(`background:${style.backgroundColor}`);
      }
      if (
        Number.parseFloat(style.borderTopWidth) > 0 ||
        Number.parseFloat(style.borderRightWidth) > 0 ||
        Number.parseFloat(style.borderBottomWidth) > 0 ||
        Number.parseFloat(style.borderLeftWidth) > 0
      ) {
        chrome.push("border");
      }
      if (Number.parseFloat(style.borderTopLeftRadius) > 0) chrome.push("radius");
      if (style.backdropFilter !== "none" && style.backdropFilter !== "") {
        chrome.push(`backdrop:${style.backdropFilter}`);
      }
      if (chrome.length > 0) {
        found.push({ testId: node.getAttribute("data-testid"), chrome: chrome.join(",") });
      }
      node = node.parentElement;
    }
    return found;
  });
}

/** The plan status line and the chat's own status row must share the same 11px mono type. */
function readStatusTypography(browser: Browser): Promise<Record<string, string>> {
  return browser.evaluate(() => {
    const type = (selector: string) => {
      const node = document.querySelector<HTMLElement>(selector);
      if (node === null) return "missing";
      const style = getComputedStyle(node);
      return `${style.fontSize}/${style.lineHeight}/${style.fontFamily}`;
    };
    return {
      plan: type('[data-testid="task-agent-status"]'),
      chat: type('[data-testid="working-status"]'),
    };
  });
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

  // A live plan run adds no floating card above the transcript. The removed
  // element was the unlabelled card wrapper around task-agent-status, so pin
  // the absence of any card chrome on its ancestors instead of a gone testid.
  await scrollTranscript(browser, 0.45);
  const beforePlanRun = await readTranscript(browser);
  expect(beforePlanRun).not.toBeNull();
  if (beforePlanRun === null) return;
  expect(beforePlanRun.distance).toBeGreaterThan(100);

  expect(await postPlanMessage(browser, taskId, "SLOW keep the plan run open")).toBe(202);
  await expect(screen.getByTestId(`task-detail-planning-${taskId}`)).toBeVisible({
    timeout: 30_000,
  });
  await expect(screen.getByTestId("task-agent-status")).toHaveAttribute("data-open", "true", {
    timeout: 30_000,
  });
  await settle(browser);

  const duringPlanRun = await readTranscript(browser);
  expect(duringPlanRun).not.toBeNull();
  if (duringPlanRun === null) return;
  expect(duringPlanRun.scrollTop).toBe(beforePlanRun.scrollTop);
  expect(duringPlanRun.composerTop).toBe(beforePlanRun.composerTop);
  expect(await readStatusChrome(browser)).toEqual([]);
  const type = await readStatusTypography(browser);
  expect(type.plan).not.toBe("missing");
  expect(type.plan).toBe(type.chat);

  expect(await stopPlanRun(browser, taskId)).toBe(200);
  await expect(screen.getByTestId("task-agent-status")).toHaveAttribute("data-open", "false", {
    timeout: 30_000,
  });
  await expect(screen.getByTestId(`task-detail-planning-${taskId}`)).toHaveCount(0, {
    timeout: 30_000,
  });
  await settle(browser);

  const afterPlanRun = await readTranscript(browser);
  expect(afterPlanRun).not.toBeNull();
  if (afterPlanRun === null) return;
  expect(afterPlanRun.scrollTop).toBe(beforePlanRun.scrollTop);
  expect(afterPlanRun.composerTop).toBe(beforePlanRun.composerTop);
  expect(await readStatusChrome(browser)).toEqual([]);

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

test("typing in Other replaces and disables that question's choices", {
  timeout: 300_000,
}, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await browser.unrouteAll();
  const submissions: AnswerSubmission[] = [];
  await browser.route("**/api/tasks/**/questions/answer", async (route) => {
    submissions.push(JSON.parse(route.request.postData ?? "{}") as AnswerSubmission);
    await route.continue();
  });

  await app.open("/?page=tasks");
  const title = `Plan questions other ${Date.now()}`;
  await createOpenTask(screen, title, { project: "pi-ui" });
  await openTaskChatTab(screen);
  await expect(screen.getByTestId("task-agent-chat")).toBeVisible();
  const taskId = await taskIdFor(browser, title);

  expect(
    await postPlanMessage(
      browser,
      taskId,
      `TOOLCALLS ${JSON.stringify([
        { name: "append_questions", arguments: { questions: OTHER_QUESTIONS } },
      ])}`,
    ),
  ).toBe(202);

  const panel = screen.getByTestId("task-questions-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  const transportHttp = screen.getByTestId("question-transport-http");
  const transportWs = screen.getByTestId("question-transport-ws");
  const storageDisk = screen.getByTestId("question-storage-disk");
  const transportOther = screen.getByTestId("question-transport-other");

  await transportHttp.tap();
  await expect(transportHttp).toBeChecked();
  await transportOther.fill("Carrier pigeon");
  await expect(transportHttp).not.toBeChecked();
  await expect(transportHttp).toBeDisabled();
  await expect(transportWs).toBeDisabled();
  await expect(storageDisk).toBeEnabled();

  await transportOther.fill("   ");
  await expect(transportHttp).toBeEnabled();
  await expect(transportWs).toBeEnabled();
  await expect(transportHttp).not.toBeChecked();

  await transportOther.fill("");
  await expect(transportHttp).toBeEnabled();
  await expect(transportHttp).not.toBeChecked();

  await transportOther.fill("Carrier pigeon");
  await storageDisk.tap();
  await expect(storageDisk).toBeChecked();
  const send = screen.getByTestId("task-questions-send");
  await expect(send).toBeEnabled();
  await send.tap();
  await expect(panel).toHaveCount(0, { timeout: 30_000 });

  await expect.poll(() => submissions.length).toBe(1);
  const payload = submissions[0] as AnswerSubmission;
  expect(payload.answers.map((answer) => answer.id)).toEqual(["transport", "storage"]);
  expect(payload.answers.find((answer) => answer.id === "transport")).toEqual({
    id: "transport",
    values: [],
    text: "Carrier pigeon",
  });
  expect(payload.answers.find((answer) => answer.id === "storage")).toEqual({
    id: "storage",
    values: ["disk"],
    text: "",
  });
  expect(new Set(payload.answers.map((answer) => answer.id)).size).toBe(payload.answers.length);

  await browser.unrouteAll();
  await removeTasks(browser, [title]);
});
