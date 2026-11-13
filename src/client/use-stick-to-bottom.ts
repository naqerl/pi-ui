import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const NEAR_BOTTOM_PX = 8;

interface Anchor {
  element: HTMLElement;
  offset: number;
}

interface HeldPosition {
  attached: boolean;
  scrollTop: number;
  anchor: Anchor | null;
}

/**
 * Keep the transcript pinned to the end only while the reader is already there.
 * When detached, preserve the element at the top of the viewport while content
 * below it grows, shrinks, or re-renders.
 */
export function useStickToBottom(dependency: unknown, options: { active?: boolean } = {}) {
  const active = options.active !== false;
  const containerRef = useRef<HTMLElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const attachedRef = useRef(true);
  const anchorRef = useRef<Anchor | null>(null);
  const lastScrollHeightRef = useRef<number | null>(null);
  const lastClientHeightRef = useRef<number | null>(null);
  const lastScrollTopRef = useRef<number | null>(null);
  const heldRef = useRef<HeldPosition | null>(null);
  const syncFrameRef = useRef<number | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const [attached, setAttachedState] = useState(true);
  const wasActiveRef = useRef(active);

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
    // A hidden pane has no layout; the held position from before the switch is authoritative.
    if (!container || container.clientHeight === 0) return;
    const scrollHeight = container.scrollHeight;
    const clientHeight = container.clientHeight;
    const previousScrollHeight = lastScrollHeightRef.current;
    const previousClientHeight = lastClientHeightRef.current;
    lastScrollHeightRef.current = scrollHeight;
    lastClientHeightRef.current = clientHeight;
    if (attachedRef.current) {
      // Content growth pins the end. So does a shrinking viewport: the expanding dock
      // pushes the transcript up with it. A growing viewport is left alone, because the
      // browser already clamps the old end offset as the dock collapses.
      const contentGrew = previousScrollHeight === null || scrollHeight > previousScrollHeight;
      const viewportShrank = previousClientHeight !== null && clientHeight < previousClientHeight;
      if (contentGrew || viewportShrank) {
        container.scrollTop = scrollHeight;
      }
    } else {
      const anchor = anchorRef.current;
      if (anchor?.element.isConnected) {
        const containerTop = container.getBoundingClientRect().top;
        const top = anchor.element.getBoundingClientRect().top;
        const delta = top - containerTop - anchor.offset;
        if (Math.abs(delta) > 0.5) {
          const target = container.scrollTop + delta;
          container.scrollTop = target;
          if (Math.abs(container.scrollTop - target) > 0.5) {
            // The held position is still outside the current maximum while the dock
            // resizes off-screen. Keep the target anchor and finish on the next sync.
            return;
          }
        }
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

  /**
   * Remember where the reader is before a navigation takes the transcript off-screen.
   * The observers stay attached, so a message that lands below cannot move the row
   * being held detached.
   */
  const holdPosition = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    heldRef.current = {
      attached: attachedRef.current,
      scrollTop: container.scrollTop,
      anchor: anchorRef.current,
    };
    // The programmatic move on the way back must not look like a reader scroll.
    lastScrollTopRef.current = container.scrollTop;
  }, []);

  /**
   * Put the held reading position back before paint. The page may be returning to a
   * different viewport height, because the dock animated while it was away.
   */
  const restorePosition = useCallback(() => {
    const container = containerRef.current;
    const held = heldRef.current;
    if (!container || !held) return;
    if (held.attached) {
      lastScrollTopRef.current = container.scrollHeight;
      container.scrollTop = container.scrollHeight;
      // The browser clamps to the real maximum, which is what the next scroll event sees.
      lastScrollTopRef.current = container.scrollTop;
      updateAttached(true);
    } else {
      const anchor = held.anchor;
      // A dock resize may have clamped scrollTop while the page was off-screen, so
      // anchor from the current offset, not only the recorded one.
      let next = held.scrollTop;
      if (anchor?.element.isConnected) {
        const containerTop = container.getBoundingClientRect().top;
        const top = anchor.element.getBoundingClientRect().top;
        next = container.scrollTop + top - containerTop - anchor.offset;
      }
      lastScrollTopRef.current = next;
      container.scrollTop = next;
      lastScrollTopRef.current = container.scrollTop;
      updateAttached(false);
      // The browser may clamp this while the returning dock still has the old height.
      // Keep the held anchor as the target, so the following syncs finish the move.
      anchorRef.current = held.anchor;
    }
    // Follow the rest of the dock transition with the normal pin / anchor correction.
    scheduleSync();
  }, [scheduleSync, updateAttached]);

  // A tab switch hides the pane without unmounting it. Remember the position from before
  // the hide (refs still hold it; sync skips a zero-height container) and restore before paint.
  useLayoutEffect(() => {
    if (wasActiveRef.current === active) return;
    wasActiveRef.current = active;
    if (active) {
      restorePosition();
    } else {
      heldRef.current = {
        attached: attachedRef.current,
        scrollTop: lastScrollTopRef.current ?? 0,
        anchor: anchorRef.current,
      };
    }
  }, [active, restorePosition]);

  const handleScroll = useCallback(() => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      const container = containerRef.current;
      if (!container || container.clientHeight === 0) return;
      const scrollTop = container.scrollTop;
      const previousScrollTop = lastScrollTopRef.current;
      lastScrollTopRef.current = scrollTop;
      const distance = container.scrollHeight - scrollTop - container.clientHeight;
      if (distance <= NEAR_BOTTOM_PX) {
        updateAttached(true);
      } else if (previousScrollTop !== null && scrollTop < previousScrollTop - 0.5) {
        // Only an upward scroll detaches. A shrinking viewport can make the distance
        // temporarily grow before the next resize sync re-pins; that is not a reader move.
        updateAttached(false);
      }
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

    // Content growth pins the end. The container observer also runs sync so a shrinking
    // viewport can carry an attached reader with the expanding dock; a growing viewport
    // only records the anchor and lets the browser clamp the old offset.
    const contentObserver = new ResizeObserver(sync);
    contentObserver.observe(content);
    const observeChildren = () => {
      for (const child of content.children) contentObserver.observe(child);
    };
    observeChildren();
    const containerObserver = new ResizeObserver(sync);
    containerObserver.observe(container);
    const mutations = new MutationObserver(() => {
      observeChildren();
      scheduleSync();
    });
    mutations.observe(content, { childList: true });
    container.addEventListener("scroll", handleScroll, { passive: true });
    lastScrollTopRef.current = container.scrollTop;
    scheduleSync();

    return () => {
      contentObserver.disconnect();
      containerObserver.disconnect();
      mutations.disconnect();
      container.removeEventListener("scroll", handleScroll);
      if (syncFrameRef.current !== null) cancelAnimationFrame(syncFrameRef.current);
      if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    };
  }, [handleScroll, scheduleSync, sync]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: dependency is only the trigger for a post-commit sync
  useLayoutEffect(() => {
    // Correct before paint, so older messages loading above the reader never show a jump,
    // then again next frame for anything that settles after layout.
    sync();
    scheduleSync();
  }, [dependency, sync, scheduleSync]);

  return {
    containerRef,
    contentRef,
    attached,
    scrollToBottom,
    revealTop,
    holdPosition,
    restorePosition,
  };
}
