import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampZoom,
  diagramDownloadName,
  fitScale,
  fitView,
  MAX_ZOOM,
  MIN_ZOOM,
  zoomAt,
} from "../src/client/diagram-viewer.js";

test("fit scaling uses the tighter of the two stage axes", () => {
  assert.equal(fitScale(390, 844, 2000, 500, 20), 0.175);
  assert.equal(fitScale(1280, 720, 400, 200, 20), 3.1);
  // A degenerate stage or drawing still yields a usable scale rather than NaN/Infinity.
  assert.equal(fitScale(0, 844, 400, 200), 1);
  assert.equal(fitScale(390, 844, 0, 200), 1);
});

test("fitView centres the drawing and starts at 1x fit", () => {
  const view = fitView(390, 844, 2000, 500, 20);
  assert.equal(view.zoom, 1);
  assert.equal(view.scale, 0.175);
  assert.equal(view.x, 20);
  assert.equal(view.y, 378.25);
});

test("zoom clamps to 0.5x and 8x of fit", () => {
  assert.equal(MIN_ZOOM, 0.5);
  assert.equal(MAX_ZOOM, 8);
  assert.equal(clampZoom(0.1), MIN_ZOOM);
  assert.equal(clampZoom(2.5), 2.5);
  assert.equal(clampZoom(100), MAX_ZOOM);
  assert.equal(clampZoom(Number.NaN), 1);
  assert.equal(zoomAt({ zoom: 1, x: 20, y: 20 }, 100, 100, 100).zoom, MAX_ZOOM);
  assert.equal(zoomAt({ zoom: 1, x: 20, y: 20 }, 0.01, 100, 100).zoom, MIN_ZOOM);
});

test("zooming keeps the point under the pointer fixed", () => {
  const zoomed = zoomAt({ zoom: 1, x: 20, y: 20 }, 2, 100, 100);
  assert.deepEqual(zoomed, { zoom: 2, x: -60, y: -60 });
  const unzoomed = zoomAt(zoomed, 1, 100, 100);
  assert.deepEqual(unzoomed, { zoom: 1, x: 20, y: 20 });
});

test("the download filename is safe and always an SVG", () => {
  assert.equal(diagramDownloadName("abcdefghij"), "diagram-abcdefghij.svg");
  assert.equal(diagramDownloadName("abcdefghij", "My Flow / v2"), "my-flow-v2-abcdefghij.svg");
  assert.equal(diagramDownloadName("", "  "), "diagram-diagram.svg");
});
