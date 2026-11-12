import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createOpenTask, openTaskChatTab, removeTasks } from "./tasks-helpers";

const QUESTIONS = [
  {
    id: "layout",
    prompt: "Which layout should the inbox use?",
    kind: "single",
    options: [
      { value: "split", label: "Split layout", detail: "List beside the message." },
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
];

test("the plan agent asks structured questions and the operator answers them", {
  timeout: 180_000,
}, async ({ app, browser, screen }) => {
  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/?page=tasks");
  const title = `Plan the inbox questions ${Date.now()}`;
  await createOpenTask(screen, title);
  await openTaskChatTab(screen);
  await expect(screen.getByTestId("task-agent-input")).toBeVisible();

  const prompt = `TOOLCALLS ${JSON.stringify([
    { name: "ask_questions", arguments: { questions: QUESTIONS } },
  ])}`;
  await screen.getByTestId("task-agent-input").fill(prompt);
  await screen.getByTestId("task-agent-send").tap();

  const panel = screen.getByTestId("task-questions-panel");
  await expect(panel).toBeVisible({ timeout: 30_000 });
  const send = screen.getByTestId("task-questions-send");
  await expect(send).toBeDisabled();
  await expect(screen.getByTestId("task-question-layout")).toContainText(
    "Which layout should the inbox use?",
  );

  // The pending set survives a page reload with its inputs intact.
  await app.open("/?page=tasks");
  await screen.getByRole("button", { name: `Open ${title}` }).tap();
  await openTaskChatTab(screen);
  await expect(screen.getByTestId("task-questions-panel")).toBeVisible({ timeout: 30_000 });
  await expect(screen.getByRole("radio", "Split layout")).toBeVisible();
  await expect(screen.getByRole("checkbox", "Sidebar")).toBeVisible();
  await expect(screen.getByTestId("question-notes-text")).toBeVisible();

  await screen.getByRole("radio", "Split layout").tap();
  await screen.getByRole("checkbox", "Sidebar").tap();
  await screen.getByRole("checkbox", "Timeline").tap();
  await screen.getByTestId("question-notes-text").fill("Keep the phone width in mind.");
  await expect(send).toBeEnabled();
  await send.tap();

  await expect(screen.getByTestId("task-questions-panel")).toHaveCount(0, { timeout: 30_000 });
  const answers = screen.getByTestId("task-question-answers");
  await expect(answers).toBeVisible();
  await expect(answers).toContainText("Which layout should the inbox use?");
  await expect(answers).toContainText("Split layout");
  await expect(answers).toContainText("Sidebar");
  await expect(answers).toContainText("Keep the phone width in mind.");

  const reply = browser.locator('[data-testid="task-agent-chat"] [data-role="assistant"]').last();
  await expect(reply).toContainText("Tool result:", { timeout: 30_000 });
  await expect(reply).toContainText("Split layout");

  const state = await browser.evaluate(async (taskTitle) => {
    const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
      tasks: Array<{ id: string; title: string }>;
    };
    const task = ledger.tasks.find((item) => item.title === taskTitle);
    if (task === undefined) return null;
    const chat = (await (
      await fetch(`/api/tasks/${encodeURIComponent(task.id)}/chat`, { cache: "no-store" })
    ).json()) as {
      questions: { id: string } | null;
      messages: Array<{
        questionAnswers?: { answers: Array<{ id: string; labels: string[]; text: string }> };
      }>;
    };
    const block = chat.messages.find((message) => message.questionAnswers !== undefined);
    return {
      pending: chat.questions === null ? null : { id: chat.questions.id },
      ids: block?.questionAnswers?.answers.map((answer) => answer.id) ?? [],
      labels: block?.questionAnswers?.answers.flatMap((answer) => answer.labels) ?? [],
      texts: block?.questionAnswers?.answers.map((answer) => answer.text) ?? [],
    };
  }, title);
  expect(state).toEqual({
    pending: null,
    ids: ["layout", "parts", "notes"],
    labels: ["Split layout", "Sidebar", "Timeline"],
    texts: ["", "", "Keep the phone width in mind."],
  });

  await removeTasks(browser, [title]);
});
