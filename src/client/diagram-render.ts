import { render } from "pele";
import { createElement, type ReactNode } from "react";

const SVG_TAGS = new Set([
  "svg",
  "g",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "textPath",
  "defs",
  "marker",
  "pattern",
  "linearGradient",
  "radialGradient",
  "stop",
  "clipPath",
  "mask",
  "image",
  "use",
  "symbol",
  "title",
  "desc",
  "a",
  "filter",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feDistantLight",
  "feDropShadow",
  "feFlood",
  "feFuncA",
  "feFuncB",
  "feFuncG",
  "feFuncR",
  "feGaussianBlur",
  "feMerge",
  "feMergeNode",
  "feMorphology",
  "feOffset",
  "fePointLight",
  "feSpecularLighting",
  "feSpotLight",
  "feTile",
  "feTurbulence",
  "switch",
  "metadata",
]);

const SAFE_HREF = /^(?:https?:|mailto:)/i;

function safeHref(value: string): string | undefined {
  const href = value.trim();
  if (href.startsWith("#")) return href;
  return SAFE_HREF.test(href) ? href : undefined;
}

function safeStyleValue(value: string): boolean {
  const lower = value.toLowerCase();
  if (
    lower.includes("javascript:") ||
    lower.includes("expression(") ||
    lower.includes("@import") ||
    lower.includes("behavior:") ||
    lower.includes("-moz-binding")
  ) {
    return false;
  }
  const urls = value.matchAll(/url\(([^)]*)\)/gi);
  for (const match of urls) {
    const target = (match[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
    if (!target.startsWith("#")) return false;
  }
  return true;
}

function styleProps(value: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const declaration of value.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 1) continue;
    const name = declaration.slice(0, colon).trim();
    const raw = declaration.slice(colon + 1).trim();
    if (name === "" || raw === "" || !safeStyleValue(raw)) continue;
    const key = name.startsWith("--")
      ? name
      : name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
    props[key] = raw;
  }
  return props;
}

function propName(name: string): string {
  if (name === "class") return "className";
  if (name === "xlink:href") return "xlinkHref";
  if (name === "xml:space") return "xmlSpace";
  if (name === "xmlns:xlink") return "xmlnsXlink";
  if (name.startsWith("data-") || name.startsWith("aria-")) return name;
  return name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

type SvgProps = Record<string, string | Record<string, string> | undefined>;

function svgNode(element: Element, key: string): ReactNode {
  if (!SVG_TAGS.has(element.tagName)) return null;
  const props: SvgProps = { key };
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name;
    const lower = name.toLowerCase();
    if (lower.startsWith("on")) continue;
    if (lower === "href" || lower === "xlink:href") {
      const href = safeHref(attribute.value);
      if (href !== undefined) props[propName(name)] = href;
      continue;
    }
    if (lower === "style") {
      props.style = styleProps(attribute.value);
      continue;
    }
    if (lower === "src" || lower === "srcset" || lower === "formaction") continue;
    props[propName(name)] = attribute.value;
  }
  const children = Array.from(element.childNodes).flatMap((child, index) => {
    if (child.nodeType === Node.TEXT_NODE) return child.textContent ?? "";
    if (child.nodeType !== Node.ELEMENT_NODE) return [];
    const node = svgNode(child as Element, `${key}-${index}`);
    return node === null ? [] : [node];
  });
  return createElement(element.tagName, props, ...children);
}

export function renderSvgMarkup(svg: string): ReactNode {
  try {
    const document = new DOMParser().parseFromString(svg, "image/svg+xml");
    if (document.querySelector("parsererror") !== null) return null;
    return svgNode(document.documentElement, "svg");
  } catch {
    return null;
  }
}

export type DiagramRenderResult = { ok: true; svg: string } | { ok: false; message: string };

export function renderDiagram(source: string): DiagramRenderResult {
  try {
    const { svg } = render(source);
    return { ok: true, svg };
  } catch (error) {
    const message =
      error instanceof Error && error.message.trim().length > 0
        ? error.message
        : "The diagram could not be rendered.";
    return { ok: false, message };
  }
}
