export function haptic(pattern: number | number[] = 8): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  if (pattern === 8) {
    const now = performance.now();
    if (now - lastTick < 50) return;
    lastTick = now;
  }
  navigator.vibrate(pattern);
}

let lastTick = 0;
