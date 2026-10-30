/** Plain hex or comma rgb(): what an installed app's manifest can paint without help. */
const PLAIN_MANIFEST_COLOR =
  /^(#[0-9a-f]{3}(?:[0-9a-f]{3})?|rgb\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*\))$/i;

function clampChannel(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function hexByte(value: number): string {
  return clampChannel(value).toString(16).padStart(2, "0");
}

function parseHex(value: string): [number, number, number] | null {
  const match = value.match(/^#([0-9a-f]{3,8})$/i);
  if (match === null) return null;
  const digits = match[1];
  if (digits.length !== 3 && digits.length !== 4 && digits.length !== 6 && digits.length !== 8) {
    return null;
  }
  const expanded =
    digits.length <= 4 ? [...digits].map((digit) => `${digit}${digit}`).join("") : digits;
  return [
    Number.parseInt(expanded.slice(0, 2), 16),
    Number.parseInt(expanded.slice(2, 4), 16),
    Number.parseInt(expanded.slice(4, 6), 16),
  ];
}

/** One rgb() channel: a 0-255 number or a 0%-100% percentage. */
function parseChannel(value: string): number | null {
  const text = value.trim();
  if (text.endsWith("%")) {
    const percent = Number.parseFloat(text.slice(0, -1));
    return Number.isFinite(percent) ? (percent / 100) * 255 : null;
  }
  const number = Number.parseFloat(text);
  return Number.isFinite(number) ? number : null;
}

function parseRgb(value: string): [number, number, number] | null {
  const match = value.match(/^rgba?\((.*)\)$/i);
  if (match === null) return null;
  const body = match[1].trim();
  const [main, alpha] = body.split("/").map((part) => part.trim());
  const parts = main.split(/\s*,\s*|\s+/).filter((part) => part.length > 0);
  // Legacy comma syntax puts alpha inside the parentheses.
  if (alpha === undefined && parts.length === 4) parts.pop();
  if (parts.length < 3) return null;
  const channels = parts.slice(0, 3).map(parseChannel);
  if (channels.some((channel) => channel === null)) return null;
  return [channels[0] as number, channels[1] as number, channels[2] as number];
}

function parseAngle(value: string): number | null {
  const text = value.trim().toLowerCase();
  if (text === "none") return 0;
  const match = text.match(/^(-?(?:\d+\.?\d*|\.\d+))(deg|grad|rad|turn)?$/);
  if (match === null) return null;
  const number = Number.parseFloat(match[1]);
  if (!Number.isFinite(number)) return null;
  switch (match[2]) {
    case "grad":
      return (number * 0.9) % 360;
    case "rad":
      return (number * 180) / Math.PI;
    case "turn":
      return (number * 360) % 360;
    default:
      return number % 360;
  }
}

function linearToSrgb(value: number): number {
  return value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
}

function parseOklch(value: string): [number, number, number] | null {
  const match = value.match(/^oklch\((.*)\)$/i);
  if (match === null) return null;
  const [main] = match[1].trim().split("/");
  const parts = main.split(/\s*,\s*|\s+/).filter((part) => part.length > 0);
  if (parts.length < 3) return null;
  const lightness = parts[0].endsWith("%")
    ? Number.parseFloat(parts[0].slice(0, -1)) / 100
    : Number.parseFloat(parts[0]);
  const chroma = parts[1].endsWith("%")
    ? (Number.parseFloat(parts[1].slice(0, -1)) / 100) * 0.4
    : Number.parseFloat(parts[1]);
  const hue = parseAngle(parts[2]);
  if (!Number.isFinite(lightness) || !Number.isFinite(chroma) || hue === null) return null;
  const radians = (hue * Math.PI) / 180;
  const a = chroma * Math.cos(radians);
  const b = chroma * Math.sin(radians);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return linear.map((channel) => linearToSrgb(channel) * 255) as [number, number, number];
}

const NAMED_COLORS: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
};

/** Resolve hex, rgb() and oklch() to an opaque sRGB hex value. Other syntaxes return null. */
export function cssColorToHex(value: string): string | null {
  const text = value.trim().toLowerCase();
  const rgb = parseHex(text) ?? parseRgb(text) ?? parseOklch(text) ?? NAMED_COLORS[text] ?? null;
  if (rgb === null) return null;
  return `#${rgb.map(hexByte).join("")}`;
}

/**
 * A manifest-safe colour. Already-plain values keep their exact spelling so a
 * theme that wrote `#ABC` stays `#ABC`; other CSS colours are resolved to sRGB.
 */
export function manifestColor(value: string): string | null {
  const text = value.trim();
  if (PLAIN_MANIFEST_COLOR.test(text)) return text;
  return cssColorToHex(text);
}
