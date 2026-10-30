import assert from "node:assert/strict";
import { test } from "node:test";
import { manifestHref } from "../src/client/theme";
import { cssColorToHex, manifestColor } from "../src/shared/color";

test("resolves theme colours to the sRGB values the manifest can paint", () => {
  assert.equal(cssColorToHex("#000"), "#000000");
  assert.equal(cssColorToHex("#101315"), "#101315");
  assert.equal(cssColorToHex("#ABC"), "#aabbcc");
  assert.equal(cssColorToHex("rgb(16, 19, 21)"), "#101315");
  assert.equal(cssColorToHex("rgb(16 19 21 / 50%)"), "#101315");
  assert.equal(cssColorToHex("oklch(1 0 0)"), "#ffffff");
  assert.equal(cssColorToHex("oklch(0 0 0)"), "#000000");
  assert.equal(cssColorToHex("oklch(0.145 0 0)"), "#0a0a0a");
  assert.equal(cssColorToHex("color-mix(in srgb, black, white)"), null);
});

test("keeps an already-plain manifest colour spelled the way the theme wrote it", () => {
  assert.equal(manifestColor("#ABC"), "#ABC");
  assert.equal(manifestColor("rgb(16, 19, 21)"), "rgb(16, 19, 21)");
  assert.equal(manifestColor("oklch(0.145 0 0)"), "#0a0a0a");
});

test("manifest revisions stay on the server URL so relative members keep their base", () => {
  assert.equal(
    manifestHref("/manifest.webmanifest", 7, "https://pi.test/chat"),
    "https://pi.test/manifest.webmanifest?rev=7",
  );
  assert.equal(
    manifestHref("https://pi.test/manifest.webmanifest?rev=2", 3, "https://pi.test/"),
    "https://pi.test/manifest.webmanifest?rev=3",
  );
  assert.equal(
    manifestHref("/manifest.webmanifest?rev=3", 4, "https://pi.test/").startsWith("blob:"),
    false,
  );
});
