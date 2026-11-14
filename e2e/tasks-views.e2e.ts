import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("rejects an empty title, a cycle, and a subtask of a done task", async ({ app, browser }) => {
  await app.open("/");
  const result = await browser.evaluate(async () => {
    const post = async (title: string, parentId: string | null = null) => {
      const response = await fetch("/api/tasks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, parentId }),
      });
      const ledger = response.ok
        ? ((await response.json()) as { tasks: Array<{ id: string; title: string }> })
        : null;
      return { status: response.status, ledger };
    };
    const patch = async (id: string, body: unknown) => {
      const response = await fetch(`/api/tasks/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return response.status;
    };
    const empty = await post("   ");
    const first = await post("cycle left");
    const second = await post("cycle right");
    const left = first.ledger?.tasks.find((task) => task.title === "cycle left");
    const right = second.ledger?.tasks.find((task) => task.title === "cycle right");
    const blocked =
      left !== undefined && right !== undefined
        ? await patch(left.id, { blockedBy: [right.id] })
        : 0;
    const cycle =
      left !== undefined && right !== undefined
        ? await patch(right.id, { blockedBy: [left.id] })
        : 0;
    const closed =
      left !== undefined
        ? await patch(left.id, {
            status: "done",
            completion: {
              timeSpent: "2m",
              tokens: 12,
              evidence: "e2e/tasks.e2e.ts",
            },
          })
        : 0;
    const child = left !== undefined ? await post("too late", left.id) : { status: 0 };
    const longTitle = "L".repeat(450);
    const long = await post(longTitle);
    return {
      empty: empty.status,
      blocked,
      cycle,
      closed,
      child: child.status,
      long: long.status,
      kept: long.ledger?.tasks.some((task) => task.title === longTitle) ?? false,
    };
  });

  expect(result?.empty).toBe(400);
  expect(result?.blocked).toBe(200);
  expect(result?.cycle).toBe(409);
  expect(result?.closed).toBe(200);
  expect(result?.child).toBe(409);
  expect(result?.long).toBe(201);
  expect(result?.kept).toBe(true);
});
