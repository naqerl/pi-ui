import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { pageIdFromPath } from "../shared/pages";
import { App } from "./App";
import "./index.css";

// The dashboard is a deep link and the default e2e landing page. Load its
// grid/chart chunk before mounting so the first dashboard fetch cannot race a
// pending dynamic import (which would leave the shell without widgets).
const statsPage =
  new URLSearchParams(window.location.search).get("page") === "stats" ||
  pageIdFromPath(window.location.pathname) === "stats";
if (statsPage) {
  await import("./StatsView");
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js");
  });
}
