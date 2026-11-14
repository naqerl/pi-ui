import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { createOpenTask, openTaskChatTab } from "./tasks-helpers";

interface PushSinkRecord {
  body: string | null;
  url: string | null;
  tag: string | null;
}

test("a finished plan turn pushes a link to that task's plan chat", {
  timeout: 180_000,
}, async ({ app, browser, screen }) => {
  await browser.addInitScript(() => {
    const storageKey = "e2e-plan-push-subscribed";
    let subscribed = localStorage.getItem(storageKey) === "1";
    const endpoint = "https://push.example/e2e-plan";
    const keys = { p256dh: "P".repeat(65), auth: "plan-auth" };
    const subscription = () => ({
      endpoint,
      keys,
      toJSON: () => ({ endpoint, keys }),
      unsubscribe: async () => {
        subscribed = false;
        localStorage.removeItem(storageKey);
        return true;
      },
    });
    const registration = {
      pushManager: {
        getSubscription: async () => (subscribed ? subscription() : null),
        subscribe: async () => {
          subscribed = true;
          localStorage.setItem(storageKey, "1");
          return subscription();
        },
      },
    };
    Object.defineProperty(window, "PushManager", { configurable: true, value: class {} });
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: { permission: "default", requestPermission: async () => "granted" },
    });
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        getRegistration: async () => registration,
        ready: Promise.resolve(registration),
        register: async () => registration,
      },
    });
  });

  await browser.setViewport({ width: 390, height: 844 });
  await app.open("/");
  await expect(screen.getByRole("textbox", "Message")).toBeVisible();
  await browser.evaluate(async () => {
    await fetch("/api/e2e/push", { method: "DELETE" });
    return true;
  });

  await screen.getByRole("button", { name: "Settings" }).tap();
  const row = screen.getByTestId("push-settings-row");
  const toggle = screen.getByTestId("push-toggle");
  await expect(row).toHaveAttribute("data-state", "default");
  await toggle.tap();
  await expect(row).toHaveAttribute("data-state", "granted");
  await expect(toggle).toHaveAttribute("aria-checked", "true");

  await app.open("/?page=tasks");
  const title = `Plan push ${Date.now()}`;
  await createOpenTask(screen, title);
  await openTaskChatTab(screen);
  await expect(screen.getByTestId("task-agent-chat")).toBeVisible();
  await expect(
    browser.locator('[data-testid="task-agent-chat"] [data-role="assistant"]'),
  ).toBeVisible({ timeout: 30_000 });

  const task = await browser.evaluate(async (taskTitle) => {
    const ledger = (await (await fetch("/api/tasks", { cache: "no-store" })).json()) as {
      tasks: Array<{ id: string; title: string }>;
    };
    return ledger.tasks.find((item) => item.title === taskTitle) ?? null;
  }, title);
  expect(task).not.toBeNull();
  if (task === null) return;

  const records: PushSinkRecord[] = [];
  await expect
    .poll(async () => {
      const found = await browser.evaluate(async (id) => {
        const response = await fetch("/api/e2e/push", { cache: "no-store" });
        const body = (await response.json()) as {
          notifications?: Array<{ body?: unknown; url?: unknown; tag?: unknown }>;
        };
        const match = body.notifications?.find(
          (item) => typeof item.url === "string" && item.url.includes(id),
        );
        return match === undefined
          ? null
          : {
              body: typeof match.body === "string" ? match.body : null,
              url: typeof match.url === "string" ? match.url : null,
              tag: typeof match.tag === "string" ? match.tag : null,
            };
      }, task.id);
      if (found !== null) records[0] = found;
      return found?.url ?? null;
    })
    .toBe(`/#/tasks/${task.id}?tab=plan`);

  const record = records[0];
  expect(record?.body).toContain(task.id);
  expect(record?.body).toContain(title);
  expect(record?.tag).toBe(`plan-${task.id}`);

  await app.open(String(record?.url));
  await expect(screen.getByTestId("task-detail")).toBeVisible();
  await expect(screen.getByTestId("task-title")).toContainText(title);
  await expect(screen.getByTestId("task-tab-chat")).toHaveAttribute("aria-selected", "true");
  await expect(screen.getByTestId("task-agent-chat")).toBeVisible();
});
