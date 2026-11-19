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

    let partial: Anchor | null = null;
    for (const child of content.children) {
      if (!(child instanceof HTMLElement)) continue;

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

    if (!container || container.clientHeight === 0) return;
    const scrollHeight = container.scrollHeight;
    const clientHeight = container.clientHeight;
    const previousScrollHeight = lastScrollHeightRef.current;
    const previousClientHeight = lastClientHeightRef.current;
    lastScrollHeightRef.current = scrollHeight;
    lastClientHeightRef.current = clientHeight;
    if (attachedRef.current) {
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

  const holdPosition = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    heldRef.current = {
      attached: attachedRef.current,
      scrollTop: container.scrollTop,
      anchor: anchorRef.current,
    };

    lastScrollTopRef.current = container.scrollTop;
  }, []);

  const restorePosition = useCallback(() => {
    const container = containerRef.current;
    const held = heldRef.current;
    if (!container || !held) return;
    if (held.attached) {
      lastScrollTopRef.current = container.scrollHeight;
      container.scrollTop = container.scrollHeight;

      lastScrollTopRef.current = container.scrollTop;
      updateAttached(true);
    } else {
      const anchor = held.anchor;

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

      anchorRef.current = held.anchor;
    }

    scheduleSync();
  }, [scheduleSync, updateAttached]);

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

  useLayoutEffect(() => {
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
