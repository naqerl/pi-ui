import { Dithering } from "@paper-design/shaders-react";
import { useEffect, useRef, useState } from "react";

const SHAPE = "warp" as const;
const TYPE = "4x4" as const;
const SIZE = 2.5;
const INK = 0.28;

interface ThemeInk {
  back: string;
  front: string;
}

function readThemeInk(): ThemeInk {
  const style = getComputedStyle(document.body);
  return { back: style.backgroundColor, front: style.color };
}

const PAPER_RGB = /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[0-9.]+)?\s*\)$/i;

function channels(color: string): [number, number, number] | null {
  const match = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

let colorProbe: CanvasRenderingContext2D | null | undefined;

function canvasChannels(color: string): [number, number, number] | null {
  if (colorProbe === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    colorProbe = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (colorProbe === null) return null;
  colorProbe.fillStyle = "#000000";
  colorProbe.fillStyle = color;
  colorProbe.fillRect(0, 0, 1, 1);
  const pixel = colorProbe.getImageData(0, 0, 1, 1).data;
  return [pixel[0] ?? 0, pixel[1] ?? 0, pixel[2] ?? 0];
}

function rgb(parts: [number, number, number]): string {
  return `rgb(${Math.round(parts[0])}, ${Math.round(parts[1])}, ${Math.round(parts[2])})`;
}

function resolved(color: string): [number, number, number] | null {
  return channels(color) ?? canvasChannels(color);
}

function paperColor(color: string): string {
  if (color.startsWith("#") || PAPER_RGB.test(color)) return color;
  const parsed = resolved(color);
  return parsed === null ? color : rgb(parsed);
}

function dimInk(back: string, front: string): string {
  const bg = resolved(back);
  const fg = resolved(front);
  if (bg === null || fg === null) return paperColor(front);
  const mix = (from: number, to: number) => from + (to - from) * INK;
  return rgb([mix(bg[0], fg[0]), mix(bg[1], fg[1]), mix(bg[2], fg[2])]);
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return reduced;
}

function contextLost(canvas: HTMLCanvasElement | null): boolean {
  if (canvas === null) return false;
  const gl = canvas.getContext("webgl2");
  return gl === null || gl.isContextLost();
}

function useShaderRecovery(host: React.RefObject<HTMLDivElement | null>): number {
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const element = host.current;
    if (element === null) return;
    let pending = false;
    const canvas = () => element.querySelector("canvas");
    const remount = () => {
      pending = false;
      setGeneration((value) => value + 1);
    };
    const recoverWhenVisible = () => {
      if (document.visibilityState === "visible") remount();
      else pending = true;
    };
    const onLost = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLCanvasElement)) return;
      event.preventDefault();
      window.setTimeout(() => {
        if (target.isConnected && element.contains(target)) recoverWhenVisible();
      }, 0);
    };
    const onRestored = () => remount();
    const check = () => {
      if (document.visibilityState !== "visible") return;
      if (pending || contextLost(canvas())) remount();
    };
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) check();
    };
    element.addEventListener("webglcontextlost", onLost, true);
    element.addEventListener("webglcontextrestored", onRestored, true);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("focus", check);
    return () => {
      element.removeEventListener("webglcontextlost", onLost, true);
      element.removeEventListener("webglcontextrestored", onRestored, true);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("focus", check);
    };
  }, [host]);

  return generation;
}

export function ShaderBackground() {
  const [colors, setColors] = useState(readThemeInk);
  const reduced = useReducedMotion();
  const speed = reduced ? 0 : 1;
  const host = useRef<HTMLDivElement>(null);
  const generation = useShaderRecovery(host);

  useEffect(() => {
    const sync = () => {
      const next = readThemeInk();
      setColors((current) =>
        current.back === next.back && current.front === next.front ? current : next,
      );
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["style"],
    });
    window.addEventListener("pi-theme", sync);
    return () => {
      observer.disconnect();
      window.removeEventListener("pi-theme", sync);
    };
  }, []);

  const shape = SHAPE;
  const type = TYPE;
  const size = SIZE;
  const back = paperColor(colors.back);
  const front = dimInk(colors.back, colors.front);

  return (
    <div
      ref={host}
      aria-hidden="true"
      data-testid="shader-bg"
      data-shader-generation={generation}
      data-shader-shape={shape}
      data-shader-speed={speed}
      data-shader-back={colors.back}
      data-shader-front={front}
      data-shader-color-back={back}
      data-shader-color-front={front}
      data-shader-ink={INK}
      className="pointer-events-none fixed inset-0 z-0"
      style={{ backgroundColor: back }}
    >
      <Dithering
        key={generation}
        colorBack={back}
        colorFront={front}
        shape={shape}
        type={type}
        size={size}
        speed={speed}
        offsetX={0}
        offsetY={0}
        fit="cover"
        minPixelRatio={1}
        width="100%"
        height="100%"
      />
    </div>
  );
}
