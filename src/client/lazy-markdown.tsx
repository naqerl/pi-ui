import { useEffect, useRef, useState } from "react";

type MarkdownModule = typeof import("./markdown");

let loaded: MarkdownModule | null = null;
let pending: Promise<MarkdownModule> | null = null;

/** Starts loading the Markdown renderer (and `marked`) in its own chunk. */
export function loadMarkdown(): Promise<MarkdownModule> {
  pending ??= import("./markdown").then((module) => {
    loaded = module;
    return module;
  });
  return pending;
}

function useMarkdownModule(): MarkdownModule | null {
  const [module, setModule] = useState(loaded);
  useEffect(() => {
    if (module !== null) return;
    let live = true;
    void loadMarkdown().then((next) => {
      if (live) setModule(next);
    });
    return () => {
      live = false;
    };
  }, [module]);
  return module;
}

const NEAR_VIEWPORT_MARGIN = "800px 0px";
const watchers = new Map<Element, () => void>();
let sharedObserver: IntersectionObserver | null = null;

function observe(element: Element, onNear: () => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    onNear();
    return () => {};
  }
  sharedObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const callback = watchers.get(entry.target);
        if (callback === undefined) continue;
        watchers.delete(entry.target);
        sharedObserver?.unobserve(entry.target);
        callback();
      }
    },
    { rootMargin: NEAR_VIEWPORT_MARGIN },
  );
  watchers.set(element, onNear);
  sharedObserver.observe(element);
  return () => {
    watchers.delete(element);
    sharedObserver?.unobserve(element);
  };
}

/**
 * Markdown for a message bubble. The text shows as plain wrapped text until the bubble comes
 * within a screen or so of the viewport and the renderer chunk has loaded; then it is parsed
 * once and stays rendered.
 */
export function DeferredMarkdown({ text }: { text: string }) {
  const module = useMarkdownModule();
  const [near, setNear] = useState(false);
  const placeholder = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (near) return;
    const element = placeholder.current;
    if (element === null) return;
    return observe(element, () => setNear(true));
  }, [near]);

  if (near && module !== null) return <module.Markdown text={text} />;
  return (
    <div
      ref={placeholder}
      data-markdown-pending=""
      className="whitespace-pre-wrap [overflow-wrap:anywhere]"
    >
      {text}
    </div>
  );
}

/** One-line Markdown; the raw title shows until the renderer chunk is in. */
export function LazyInlineMarkdown({ text }: { text: string }) {
  const module = useMarkdownModule();
  return module === null ? text : <module.InlineMarkdown text={text} />;
}

/** The visible text of a one-line Markdown title; the raw title until the renderer loads. */
export function lazyPlainInline(text: string): string {
  return loaded === null ? text : loaded.plainInline(text);
}
