import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ComposerPalette } from "../src/client/ComposerPalette.js";
import { type ComposerCommand, matchCommands } from "../src/client/composer-commands.js";

const commands: ComposerCommand[] = [
  {
    name: "remove",
    summary: "delete the open task",
    unavailable: null,
    run: async () => null,
  },
  {
    name: "rename",
    summary: "rename the open task",
    unavailable: null,
    run: async () => null,
  },
];

test("every ghost candidate keeps the typed prefix", () => {
  const { matches, index } = matchCommands(commands, "r");
  const markup = renderToStaticMarkup(
    createElement(ComposerPalette, { value: "/r", matches, active: index }),
  );
  const text = markup.replace(/<[^>]+>/g, "");
  assert.match(text, /\/remove/);
  assert.match(text, /\/rename/);
});
