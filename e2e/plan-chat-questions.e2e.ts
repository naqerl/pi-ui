import { type Browser, test } from "@e2e-dev/web";
import { expect } from "e2e";
import { readActivitySurface } from "./activity-helpers";
import { createOpenTask, openTaskChatTab, openTaskPlanTab, removeTasks } from "./tasks-helpers";

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

const OTHER_QUESTIONS = [
  {
    id: "transport",
    prompt: "How should the client connect?",
    kind: "single",
    options: [
      { value: "http", label: "HTTP" },
      { value: "ws", label: "WebSocket" },
    ],
  },
  {
    id: "storage",
    prompt: "Where should the cache live?",
    kind: "single",
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

test("questions live on the Plan tab and answering nudges the agent with a notice", {
  timeout: 300_000,
}, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks");
  const title = `Plan questions plan tab ${Date.now()}`;
  await createOpenTask(screen, title, { project: "pi-ui" });
  await openTaskPlanTab(screen);
  const taskId = await taskIdFor(browser, title);

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

  // The ask returned without parking the run: a normal message still gets its reply.
  expect(await postPlanMessage(browser, taskId, "After questions still responsive")).toBe(202);
  await openTaskChatTab(screen);
  await expect(screen.getByTestId("task-agent-transcript")).toContainText(
    "Echo: After questions still responsive",
    { timeout: 60_000 },
  );
  await expect(screen.getByTestId("working-status")).toHaveText("idle", { timeout: 60_000 });

  // The Chat tab's waiting control must move the pager, not just relabel the tab.
  const waiting = screen.getByTestId("task-questions-waiting");
  await expect(waiting).toBeVisible();
  await waiting.tap();
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(
      async () => {
        const box = await panel.boundingBox();
        return box !== null && box.x >= 0 && box.x + box.width <= 390;
      },
      { timeout: 5_000 },
    )
    .toBe(true);

  await screen.getByTestId("question-layout-split").tap();
  await screen.getByTestId("question-parts-sidebar").tap();
  await screen.getByTestId("question-notes-text").fill("SLOW keep the plan run open");
  await screen.getByTestId("question-density-compact").tap();
  await screen.getByTestId("question-theme-light").tap();
  const send = screen.getByTestId("task-questions-send");
  await expect(send).toBeEnabled();
  await send.tap();

  await expect(panel).toHaveCount(0, { timeout: 30_000 });
  await expect(screen.getByTestId(`task-detail-planning-${taskId}`)).toBeVisible({
    timeout: 30_000,
  });

  await openTaskChatTab(screen);
  await expect(screen.getByTestId("chat-notice")).toHaveAttribute("data-notice-kind", "questions", {
    timeout: 30_000,
  });
  await expect(screen.getByTestId("chat-notice-summary")).toHaveText("Answers sent · 5 questions");

  await removeTasks(browser, [title]);
});

test("a full question set scrolls into reach in the desktop Plan card", {
  timeout: 300_000,
}, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 1280, height: 720 });
  await app.open("/?page=tasks");
  const title = `Plan questions desktop scroll ${Date.now()}`;
  await createOpenTask(screen, title, { project: "pi-ui" });
  const taskId = await taskIdFor(browser, title);

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
  const lastQuestion = screen.getByTestId("task-question-theme");
  const dismiss = screen.getByTestId("task-questions-dismiss");
  await expect(panel).toBeVisible({ timeout: 30_000 });

  // Scroll the Plan card with the wheel exactly as a pointer user would.
  const panelBox = await panel.boundingBox();
  if (panelBox === null) throw new Error("question panel has no box");
  await browser.mouse.move(
    panelBox.x + Math.min(48, panelBox.width / 2),
    Math.min(panelBox.y + 100, 700),
  );
  for (let step = 0; step < 8; step += 1) {
    const box = await dismiss.boundingBox();
    if (box !== null && box.y >= 0 && box.y + box.height <= 720) break;
    await browser.mouse.wheel(0, 600);
  }

  const inViewport = async (testId: string) => {
    const box = await screen.getByTestId(testId).boundingBox();
    return box !== null && box.y >= 0 && box.y + box.height <= 720;
  };
  await expect.poll(() => inViewport("task-question-theme"), { timeout: 5_000 }).toBe(true);
  await expect.poll(() => inViewport("task-questions-send"), { timeout: 5_000 }).toBe(true);
  await expect.poll(() => inViewport("task-questions-dismiss"), { timeout: 5_000 }).toBe(true);
  await expect(lastQuestion).toBeVisible();

  await dismiss.tap();
  await expect(panel).toHaveCount(0, { timeout: 30_000 });
  await removeTasks(browser, [title]);
});

test("free text is always offered and replaces that question's choices", {
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
  await openTaskPlanTab(screen);
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

test("dismiss clears the set, nudges the agent, and a replayed answer is refused", {
  timeout: 300_000,
}, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks");
  const title = `Plan questions dismiss ${Date.now()}`;
  await createOpenTask(screen, title, { project: "pi-ui" });
  await openTaskPlanTab(screen);
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
  const setId = await browser.evaluate(
    () =>
      document.querySelector<HTMLElement>('[data-testid="task-questions-panel"]')?.dataset.setId ??
      null,
  );
  expect(setId).not.toBeNull();
  if (setId === null) return;

  const carried = await browser.evaluate(async (id) => {
    const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
      tasks: Array<{ id: string; questions?: { id: string } | null }>;
    };
    return ledger.tasks.find((task) => task.id === id)?.questions?.id ?? null;
  }, taskId);
  expect(carried).toBe(setId);

  // A pending set blocks approval / moving the task to working until it is answered or dismissed.
  expect(
    await browser.evaluate(
      async (id) =>
        (
          await fetch(`/api/tasks/${encodeURIComponent(id)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: "working" }),
          })
        ).status,
      taskId,
    ),
  ).toBe(409);

  await screen.getByTestId("task-questions-dismiss").tap();
  await expect(panel).toHaveCount(0, { timeout: 30_000 });

  const cleared = await browser.evaluate(async (id) => {
    const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
      tasks: Array<{ id: string; questions?: { id: string } | null }>;
    };
    return ledger.tasks.find((task) => task.id === id)?.questions ?? null;
  }, taskId);
  expect(cleared).toBeNull();

  // Reposting the same set is a conflict and must not add a second prompt entry.
  expect(
    await answerQuestions(browser, taskId, setId, [
      { id: "transport", values: ["http"], text: "" },
      { id: "storage", values: ["disk"], text: "" },
    ]),
  ).toBe(409);

  await openTaskChatTab(screen);
  await expect(screen.getByTestId("chat-notice-summary")).toHaveText("Questions dismissed", {
    timeout: 30_000,
  });
  await screen.getByTestId("chat-notice").tap();
  await expect(screen.getByTestId("notice-dialog")).toContainText(
    "Questions dismissed — decide yourself",
  );
  await screen.getByTestId("notice-dialog-close").tap();
  await expect
    .poll(
      () =>
        browser.evaluate(
          () =>
            document.querySelectorAll('[data-testid="chat-notice"][data-notice-kind="questions"]')
              .length,
        ),
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
