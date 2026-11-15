import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { readActivitySurface } from "./activity-helpers";
import {
  createOpenTask,
  openNewTaskComposer,
  openTaskChatTab,
  removeTasks,
  setPlanDraft,
} from "./tasks-helpers";

const FIRST_QUESTIONS = [
  {
    id: "layout",
    prompt: "SLOW which layout should the inbox use?",
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

const DISMISS_QUESTIONS = [
  {
    id: "scope",
    prompt: "Which part should ship first?",
    kind: "single",
    options: [
      { value: "inbox", label: "Inbox" },
      { value: "search", label: "Search" },
    ],
  },
] as const;

const DOUBLE_QUESTIONS = [
  {
    id: "density",
    prompt: "How dense should the list feel?",
    kind: "single",
    options: [
      { value: "compact", label: "Compact rows" },
      { value: "roomy", label: "Roomy rows" },
    ],
  },
] as const;

interface AnswerSubmission {
  setId: string;
  answers: Array<{ id: string; values: string[]; text: string }>;
}

type PlanMessage = {
  text: string;
  notice?: { kind?: string; summary?: string };
};

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

async function askQuestions(
  browser: Browser,
  taskId: string,
  questions: readonly unknown[],
): Promise<void> {
  expect(
    await postPlanMessage(
      browser,
      taskId,
      `TOOLCALLS ${JSON.stringify([{ name: "append_questions", arguments: { questions } }])}`,
    ),
  ).toBe(202);
}

async function taskQuestions(
  browser: Browser,
  taskId: string,
): Promise<{ id: string; questions: unknown[] } | null> {
  return browser.evaluate(async (id) => {
    const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
      tasks: Array<{
        id: string;
        questions?: { id: string; questions: Array<{ id: string }> } | null;
      }>;
    };
    return ledger.tasks.find((task) => task.id === id)?.questions ?? null;
  }, taskId);
}

async function planMessages(browser: Browser, taskId: string): Promise<PlanMessage[]> {
  return browser.evaluate(async (id) => {
    const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/chat`, {
      cache: "no-store",
    });
    if (!response.ok) return [];
    const snapshot = (await response.json()) as { messages?: PlanMessage[] };
    return snapshot.messages ?? [];
  }, taskId);
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

async function dismissQuestions(browser: Browser, taskId: string, setId: string): Promise<number> {
  return browser.evaluate(
    async ({ id, set }) => {
      const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/questions/dismiss`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ setId: set }),
      });
      return response.status;
    },
    { id: taskId, set: setId },
  );
}

test("the Plan tab shows questions and the answers arrive as a chat chip", {
  timeout: 300_000,
}, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks");
  const title = `Plan questions ${Date.now()}`;
  await createOpenTask(screen, title, { project: "pi-ui" });
  const taskId = await taskIdFor(browser, title);

  // The panel lives in the Plan tab, which is the mobile default.
  await askQuestions(browser, taskId, FIRST_QUESTIONS);
  const panel = screen.getByTestId("task-questions-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel).toHaveAttribute("data-set-id", /.+/);
  expect(await taskQuestions(browser, taskId)).not.toBeNull();

  // ask_questions no longer parks the run: a message sent right after is answered.
  expect(await postPlanMessage(browser, taskId, `AFTER_ASK ${title}`)).toBe(202);
  await expect
    .poll(
      async () => (await planMessages(browser, taskId)).some((m) => m.text.includes("AFTER_ASK")),
      { timeout: 60_000 },
    )
    .toBe(true);
  await expect(panel).toBeVisible();

  // The chat keeps one chip instead of a second panel; it switches to Plan on a phone.
  await openTaskChatTab(screen);
  const chip = screen.getByTestId("task-questions-chip");
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("3 questions waiting · Answer in Plan");
  await chip.tap();
  await expect(screen.getByTestId("task-tab-plan")).toHaveAttribute("aria-selected", "true");
  await expect(panel).toBeVisible();

  await screen.getByTestId("question-layout-split").tap();
  await screen.getByTestId("question-parts-sidebar").tap();
  await screen.getByTestId("question-notes-text").fill("Keep the phone width in mind.");
  const send = screen.getByTestId("task-questions-send");
  await expect(send).toBeEnabled();
  await send.tap();
  await expect(panel).toHaveCount(0, { timeout: 30_000 });
  expect(await taskQuestions(browser, taskId)).toBeNull();
  await expect(screen.getByTestId(`task-detail-planning-${taskId}`)).toBeVisible({
    timeout: 30_000,
  });

  // The answer is one "Answers sent" notice, not a user bubble.
  await openTaskChatTab(screen);
  const notice = screen.getByTestId("chat-notice");
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice).toHaveAttribute("data-notice-kind", "questions");
  await expect(notice).toContainText("Answers sent · 3 questions");
  await expect
    .poll(
      async () =>
        (await planMessages(browser, taskId)).filter(
          (message) => message.notice?.kind === "questions",
        ).length,
      { timeout: 30_000 },
    )
    .toBe(1);

  await removeTasks(browser, [title]);
});

test("a draft row badges pending questions and leaving planning clears them", {
  timeout: 300_000,
}, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 1280, height: 900 });
  await app.open("/?page=tasks");
  const title = `Plan questions draft ${Date.now()}`;
  const input = await openNewTaskComposer(screen);
  await setPlanDraft(screen, true);
  await input.fill(title);
  await screen.getByRole("button", "Add task").tap();
  await expect(screen.getByTestId("task-detail")).toBeVisible();
  const taskId = await taskIdFor(browser, title);

  await askQuestions(browser, taskId, DISMISS_QUESTIONS);
  const panel = screen.getByTestId("task-questions-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  const badge = screen.getByTestId(`task-questions-${taskId}`);
  await expect(badge).toBeVisible();
  expect(await taskQuestions(browser, taskId)).not.toBeNull();

  // Approving a draft is leaving planning: the pending set must not survive it.
  await screen.getByRole("button", { name: /Approve .+ draft/ }).tap();
  await expect(panel).toHaveCount(0, { timeout: 30_000 });
  await expect(badge).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(async () => taskQuestions(browser, taskId), { timeout: 30_000 }).toBeNull();

  // Closing the task is the other terminal transition that drops a pending set.
  await askQuestions(browser, taskId, DOUBLE_QUESTIONS);
  await expect(panel).toBeVisible({ timeout: 30_000 });
  expect(await taskQuestions(browser, taskId)).not.toBeNull();
  await browser.evaluate(async (id) => {
    const response = await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    return response.status;
  }, taskId);
  await expect(panel).toHaveCount(0, { timeout: 30_000 });
  await expect(badge).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(async () => taskQuestions(browser, taskId), { timeout: 30_000 }).toBeNull();

  await removeTasks(browser, [title]);
});

test("a tall desktop question set keeps Send answers reachable", {
  timeout: 300_000,
}, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 1280, height: 900 });
  await app.open("/?page=tasks");
  const title = `Plan questions tall ${Date.now()}`;
  await createOpenTask(screen, title);
  const taskId = await taskIdFor(browser, title);
  const questions = Array.from({ length: 8 }, (_, index) => ({
    id: `q${index}`,
    prompt: `Question ${index + 1} about the plan?`,
    kind: "text",
  }));

  await askQuestions(browser, taskId, questions);
  const panel = screen.getByTestId("task-questions-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  const send = screen.getByTestId("task-questions-send");
  await send.scrollIntoView();
  const reachable = await browser.evaluate(() => {
    const button = document.querySelector<HTMLElement>('[data-testid="task-questions-send"]');
    if (button === null) return false;
    const rect = button.getBoundingClientRect();
    return (
      rect.top >= 0 &&
      rect.left >= 0 &&
      rect.bottom <= window.innerHeight &&
      rect.right <= window.innerWidth
    );
  });
  expect(reachable).toBe(true);

  for (let index = 0; index < questions.length; index += 1) {
    await screen.getByTestId(`question-q${index}-text`).fill(`Answer ${index + 1}`);
  }
  await send.tap();
  await expect(panel).toHaveCount(0, { timeout: 30_000 });

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
  const taskId = await taskIdFor(browser, title);

  await askQuestions(browser, taskId, OTHER_QUESTIONS);
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

test("dismiss clears the panel and sends the decide-yourself notice", {
  timeout: 300_000,
}, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks");
  const title = `Plan questions dismiss ${Date.now()}`;
  await createOpenTask(screen, title, { project: "pi-ui" });
  const taskId = await taskIdFor(browser, title);

  await askQuestions(browser, taskId, DISMISS_QUESTIONS);
  const panel = screen.getByTestId("task-questions-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  const setId = await panel.getAttribute("data-set-id");
  expect(setId).not.toBeNull();
  if (setId === null) return;

  await screen.getByTestId("task-questions-dismiss").tap();
  await expect(panel).toHaveCount(0, { timeout: 30_000 });
  expect(await taskQuestions(browser, taskId)).toBeNull();
  expect(await dismissQuestions(browser, taskId, setId)).toBe(409);

  await openTaskChatTab(screen);
  const notice = screen.getByTestId("chat-notice");
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice).toHaveAttribute("data-notice-kind", "questions");
  await expect(notice).toContainText("Questions dismissed");
  await expect
    .poll(
      async () =>
        (await planMessages(browser, taskId)).find(
          (message) => message.notice?.kind === "questions",
        )?.text ?? "",
      { timeout: 30_000 },
    )
    .toContain("dismissed your questions");

  await removeTasks(browser, [title]);
});

test("a second answer is a conflict and creates no second prompt entry", {
  timeout: 300_000,
}, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks");
  const title = `Plan questions double ${Date.now()}`;
  await createOpenTask(screen, title, { project: "pi-ui" });
  const taskId = await taskIdFor(browser, title);

  await askQuestions(browser, taskId, DOUBLE_QUESTIONS);
  const panel = screen.getByTestId("task-questions-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  const setId = await panel.getAttribute("data-set-id");
  expect(setId).not.toBeNull();
  if (setId === null) return;

  const answers = [{ id: "density", values: ["compact"], text: "" }];
  expect(await answerQuestions(browser, taskId, setId, answers)).toBe(200);
  expect(await answerQuestions(browser, taskId, setId, answers)).toBe(409);
  await expect(panel).toHaveCount(0, { timeout: 30_000 });
  await expect
    .poll(
      async () =>
        (await planMessages(browser, taskId)).filter(
          (message) => message.notice?.kind === "questions",
        ).length,
      { timeout: 30_000 },
    )
    .toBe(1);

  await removeTasks(browser, [title]);
});

test("the plan chat renders the same activity surface as the chat page", {
  timeout: 300_000,
}, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 1280, height: 900 });
  const prompt = `TOOLCALLS ${JSON.stringify([
    { name: "bash", arguments: { command: "printf plan-activity" } },
  ])}`;

  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  await composer.fill(prompt);
  await screen.getByRole("button", { name: "Send" }).tap();
  await expect(screen.getByText(/Tool result:/)).toBeVisible({ timeout: 60_000 });
  await expect
    .poll(
      () =>
        browser.evaluate(
          () =>
            document.querySelectorAll('[data-testid="chat-content"] [data-testid="run-info"]')
              .length,
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  const chat = await readActivitySurface(browser, '[data-testid="chat-content"]');
  expect(chat).not.toBeNull();
  if (chat === null) return;

  await app.open("/?page=tasks");
  const title = `Plan activity ${Date.now()}`;
  await createOpenTask(screen, title);
  await openTaskChatTab(screen);
  await expect(screen.getByTestId("task-agent-chat")).toBeVisible();
  const taskId = await taskIdFor(browser, title);

  expect(await postPlanMessage(browser, taskId, prompt)).toBe(202);
  const transcript = screen.getByTestId("task-agent-transcript");
  await expect(transcript.getByTestId("run-info")).toBeVisible({ timeout: 60_000 });
  await expect(screen.getByTestId("working-status")).toHaveText("idle", { timeout: 60_000 });
  await expect(screen.getByTestId("task-agent-status")).toHaveCount(0);
  const plan = await readActivitySurface(browser, '[data-testid="task-agent-transcript"]');
  expect(plan).not.toBeNull();
  if (plan === null) return;

  expect(plan).toEqual(chat);
  expect(plan.rows).toEqual([{ name: "bash", summary: expect.any(String) }]);
  expect(plan.expands).toBe(true);
  expect(plan.collapses).toBe(true);

  await app.screenshot("plan-chat-activity");

  await removeTasks(browser, [title]);
});
