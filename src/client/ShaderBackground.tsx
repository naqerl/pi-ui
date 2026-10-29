import { Dithering } from "@paper-design/shaders-react";
import { useEffect, useState } from "react";

const SHAPE = "warp" as const;
const TYPE = "4x4" as const;
const SIZE = 2.5;
/** Share of the theme foreground mixed into the page color. Lower is dimmer. */
const INK = 0.28;

interface ThemeInk {
  back: string;
  front: string;
}

function readThemeInk(): ThemeInk {
  const style = getComputedStyle(document.body);
  return { back: style.backgroundColor, front: style.color };
}

/** Comma-separated rgb() and hex. Paper rejects oklch and space-separated rgb(). */
const PAPER_RGB = /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[0-9.]+)?\s*\)$/i;

function channels(color: string): [number, number, number] | null {
  const match = color.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

let colorProbe: CanvasRenderingContext2D | null | undefined;

/** Resolve oklch and other CSS colors to sRGB bytes. Computed style keeps oklch. */
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

/** A color string Paper's parser accepts. Already-valid strings stay unchanged. */
function paperColor(color: string): string {
  if (color.startsWith("#") || PAPER_RGB.test(color)) return color;
  const parsed = resolved(color);
  return parsed === null ? color : rgb(parsed);
}

/** Pull the theme foreground toward the page so the warp stays a texture. */
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

/** Warp dither behind every page. It drifts on its own and ignores the pointer. */
export function ShaderBackground() {
  const [colors, setColors] = useState(readThemeInk);
  const reduced = useReducedMotion();
  const speed = reduced ? 0 : 1;

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
      aria-hidden="true"
      data-testid="shader-bg"
      data-shader-shape={shape}
      data-shader-speed={speed}
      data-shader-back={colors.back}
      data-shader-front={front}
      data-shader-color-back={back}
      data-shader-color-front={front}
      data-shader-ink={INK}
      className="pointer-events-none fixed inset-0 z-0"
    >
      <Dithering
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
