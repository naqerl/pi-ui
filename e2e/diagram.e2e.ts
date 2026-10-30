import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("draws a diagram and replaces it in the original message", async ({
  app,
  screen,
  browser,
}) => {
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  const draw = [
    {
      name: "draw_diagram",
      arguments: {
        source: "flowchart LR\n  A[Draw] --> B[Revise]",
        title: "Flow",
      },
    },
  ];
  await composer.fill(`TOOLCALLS ${JSON.stringify(draw)}`);
  await screen.getByRole("button", "Send").tap();
  await expect(screen.getByTestId("diagram")).toBeVisible({ timeout: 30_000 });
  await expect(screen.getByTestId("diagram")).toHaveAttribute("data-revision", "1");
  await expect(browser.locator("[data-testid=diagram] svg")).toBeVisible({ timeout: 30_000 });
  const id = await browser.evaluate(
    () => document.querySelector("[data-testid=diagram]")?.getAttribute("data-diagram-id") ?? null,
  );
  expect(id).not.toBeNull();
  const svgText = await browser.evaluate(
    () => document.querySelector("[data-testid=diagram] svg")?.textContent ?? "",
  );
  expect(svgText).toContain("Draw");

  const replace = [
    {
      name: "replace_diagram",
      arguments: {
        id,
        source: "flowchart LR\n  A[Draw] --> C[Changed]",
      },
    },
  ];
  await composer.fill(`TOOLCALLS ${JSON.stringify(replace)}`);
  await screen.getByRole("button", "Send").tap();
  await expect(screen.getByTestId("diagram")).toHaveAttribute("data-revision", "2", {
    timeout: 30_000,
  });
  await expect(browser.locator("[data-testid=diagram] svg")).toBeVisible({ timeout: 30_000 });
  const changed = await browser.evaluate(
    () => document.querySelector("[data-testid=diagram] svg")?.textContent ?? "",
  );
  expect(changed).toContain("Changed");
});

test("an invalid diagram is an error card with the parser's message", async ({
  app,
  screen,
  browser,
}) => {
  await app.open("/");
  const composer = screen.getByRole("textbox", "Message");
  const draw = [{ name: "draw_diagram", arguments: { source: "this is not a diagram" } }];
  await composer.fill(`TOOLCALLS ${JSON.stringify(draw)}`);
  await screen.getByRole("button", "Send").tap();
  await expect(browser.locator("[data-testid=diagram-error]")).toContainText(
    "No diagram type detected",
    { timeout: 30_000 },
  );
  await expect(browser.locator("[data-testid=diagram] pre")).toContainText("this is not a diagram");
});
