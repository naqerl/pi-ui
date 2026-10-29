import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const NEAR_BOTTOM_PX = 48;

interface Anchor {
  element: HTMLElement;
  offset: number;
}

/**
 * Keep the transcript pinned to the end only while the reader is already there.
 * When detached, preserve the element at the top of the viewport while content
 * below it grows, shrinks, or re-renders.
 */
export function useStickToBottom(dependency: unknown) {
  const containerRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const attachedRef = useRef(true);
  const anchorRef = useRef<Anchor | null>(null);
  const syncFrameRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const [attached, setAttachedState] = useState(true);

  const updateAttached = useCallback((next: boolean) => {
    if (attachedRef.current === next) return;
    attachedRef.current = next;
    setAttachedState(next);
  }, []);

  const recordAnchor = useCallback(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) {
      anchorRef.current = null;
      return;
    }
    const containerTop = container.getBoundingClientRect().top;
    // Prefer the first element that starts inside the viewport: an element cut off at the top
    // can still change height (its Markdown renders late), which must not move what is read.
    let partial: Anchor | null = null;
    for (const child of content.children) {
      if (!(child instanceof HTMLElement)) continue;
      // Rows such as "Earlier messages" stay put while content lands next to them.
      if (child.dataset.stickSkip !== undefined) continue;
      const rect = child.getBoundingClientRect();
      if (rect.bottom <= containerTop + 1) continue;
      const anchor = { element: child, offset: rect.top - containerTop };
      if (rect.top >= containerTop - 1 && rect.top < containerTop + container.clientHeight) {
        anchorRef.current = anchor;
        return;
      }
      partial ??= anchor;
      if (rect.top >= containerTop + container.clientHeight) break;
    }
    anchorRef.current = partial;
  }, []);

  const sync = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    if (attachedRef.current) {
      container.scrollTop = container.scrollHeight;
    } else {
      const anchor = anchorRef.current;
      if (anchor?.element.isConnected) {
        const containerTop = container.getBoundingClientRect().top;
        const top = anchor.element.getBoundingClientRect().top;
        const delta = top - containerTop - anchor.offset;
        if (Math.abs(delta) > 0.5) container.scrollTop += delta;
      }
    }
    recordAnchor();
  }, [recordAnchor]);

  const scheduleSync = useCallback(() => {
    if (syncFrameRef.current !== null) cancelAnimationFrame(syncFrameRef.current);
    syncFrameRef.current = requestAnimationFrame(() => {
      syncFrameRef.current = null;
      sync();
    });
  }, [sync]);

  const handleScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const container = containerRef.current;
      if (!container) return;
      const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
      updateAttached(distance <= NEAR_BOTTOM_PX);
      recordAnchor();
    });
  }, [recordAnchor, updateAttached]);

  const scrollToBottom = useCallback(() => {
    updateAttached(true);
    const container = containerRef.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
    recordAnchor();
  }, [recordAnchor, updateAttached]);

  /**
   * Detach and put `element`'s top `inset` px below the top of the scroller, then keep it
   * there while content around it settles. The browser clamps at the end of the transcript.
   */
  const revealTop = useCallback(
    (element: HTMLElement, inset: number) => {
      const container = containerRef.current;
      if (!container || !element.isConnected) return;
      const containerTop = container.getBoundingClientRect().top;
      const top = element.getBoundingClientRect().top;
      container.scrollTop += top - containerTop - inset;
      const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
      updateAttached(distance <= NEAR_BOTTOM_PX);
      recordAnchor();
    },
    [recordAnchor, updateAttached],
  );

  useEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;

    const observer = new ResizeObserver(scheduleSync);
    observer.observe(container);
    observer.observe(content);
    const observeChildren = () => {
      for (const child of content.children) observer.observe(child);
    };
    observeChildren();
    const mutations = new MutationObserver(() => {
      observeChildren();
      scheduleSync();
    });
    mutations.observe(content, { childList: true });
    container.addEventListener("scroll", handleScroll, { passive: true });
    scheduleSync();

    return () => {
      observer.disconnect();
      mutations.disconnect();
      container.removeEventListener("scroll", handleScroll);
      if (syncFrameRef.current !== null) cancelAnimationFrame(syncFrameRef.current);
      if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    };
  }, [handleScroll, scheduleSync]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency is only the trigger for a post-commit sync
  useLayoutEffect(() => {
    // Correct before paint, so older messages loading above the reader never show a jump,
    // then again next frame for anything that settles after layout.
    sync();
    scheduleSync();
  }, [dependency, sync, scheduleSync]);

  return { containerRef, contentRef, attached, scrollToBottom, revealTop };
}
