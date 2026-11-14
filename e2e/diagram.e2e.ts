import { test } from "@e2e-dev/web";
import { expect } from "e2e";

test("fixes a broken diagram in place with edit_diagram and raises the revision", async ({
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
        source: "flowchart LR\n  A -->",
        title: "Broken flow",
      },
    },
  ];
  await composer.fill(`TOOLCALLS ${JSON.stringify(draw)}`);
  await screen.getByRole("button", "Send").tap();

  await expect(browser.locator("[data-testid=diagram]").last()).toBeVisible({
    timeout: 30_000,
  });
  await expect(browser.locator("[data-testid=diagram-error]").last()).toContainText(
    "Parse error on line 2",
    { timeout: 30_000 },
  );
  const id = await browser.evaluate(() => {
    const diagrams = [...document.querySelectorAll("[data-testid=diagram]")];
    return diagrams.at(-1)?.getAttribute("data-diagram-id") ?? "";
  });
  expect(id).not.toBe("");
  await expect(browser.locator("[data-testid=diagram]").last()).toHaveAttribute(
    "data-revision",
    "1",
  );

  const edit = [
    {
      name: "edit_diagram",
      arguments: {
        id,
        source: "flowchart LR\n  A[Fixed] --> B[Done]",
      },
    },
  ];
  await composer.fill(`TOOLCALLS ${JSON.stringify(edit)}`);
  await screen.getByRole("button", "Send").tap();

  await expect(browser.locator("[data-testid=diagram]").last()).toHaveAttribute(
    "data-revision",
    "2",
    { timeout: 30_000 },
  );
  await expect(browser.locator("[data-testid=diagram] svg").last()).toBeVisible({
    timeout: 30_000,
  });
  const fixed = await browser.evaluate(() => {
    const drawings = [...document.querySelectorAll("[data-testid=diagram] svg")];
    return drawings.at(-1)?.textContent ?? "";
  });
  expect(fixed).toContain("Fixed");
});
