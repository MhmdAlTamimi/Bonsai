import { useLayoutEffect, useRef, useState } from 'react';

// Session-only UI state, scoped to the experiment; no browser storage.
const positions = new Map<string, { top: number; following: boolean }>();
export function useReadingPosition(
  key: string,
  ready: boolean,
  visible: boolean,
  version: string,
  historyStart?: string,
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const saved = useRef(positions.get(key) ?? { top: 0, following: true });
  const prependAnchor = useRef<{ id: string; top: number } | null>(null);
  const restored = useRef(false);
  const lastHeight = useRef<number | null>(null);
  const [away, setAway] = useState(!saved.current.following);
  const [unread, setUnread] = useState(false);
  const selectedText = (): boolean => !(window.getSelection()?.isCollapsed ?? true);
  // Report upward movement only; restoration and prepend adjustments must not load pages.
  const remember = (): boolean => {
    const region = scrollRef.current;
    if (!region || !visible || !restored.current) return false;
    const upward = region.scrollTop < saved.current.top;
    const anchor = prependAnchor.current;
    if (anchor) {
      const element = region.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(anchor.id)}"]`,
      );
      if (element) anchor.top = element.getBoundingClientRect().top;
    }
    saved.current = {
      top: region.scrollTop,
      following:
        region.scrollHeight - region.scrollTop - region.clientHeight < 80 && !selectedText(),
    };
    positions.set(key, saved.current);
    setAway(!saved.current.following);
    if (saved.current.following) setUnread(false);
    return upward;
  };
  const jump = (): void => {
    const region = scrollRef.current;
    if (!region) return;
    region.scrollTop = region.scrollHeight;
    saved.current = { top: region.scrollTop, following: true };
    positions.set(key, saved.current);
    setAway(false);
    setUnread(false);
  };
  useLayoutEffect(() => {
    const region = scrollRef.current;
    if (!ready || !visible || !region) return;
    region.style.overflowAnchor = 'none';
    // Restoring happens after history arrives, not against a loading placeholder.
    region.scrollTop =
      saved.current.following && !selectedText() ? region.scrollHeight : saved.current.top;
    restored.current = true;
  }, [ready, visible]);
  useLayoutEffect(() => {
    const content = contentRef.current;
    const region = scrollRef.current;
    if (!content || !region || !ready || !visible) return;
    const follow = (): void => {
      const height = region.scrollHeight;
      const grew = lastHeight.current !== null && height > lastHeight.current;
      lastHeight.current = height;
      if (saved.current.following && !selectedText()) {
        region.scrollTop = region.scrollHeight;
        saved.current.top = region.scrollTop;
      } else {
        saved.current.following = false;
        setAway(true);
        if (grew) setUnread(true);
      }
      positions.set(key, saved.current);
    };
    const observer = new ResizeObserver(follow);
    observer.observe(content);
    return () => observer.disconnect();
  }, [key, ready, visible, version]);
  const preserveEarlier = (): void => {
    const region = scrollRef.current;
    const anchor = region?.querySelector<HTMLElement>('[data-message-id]');
    if (anchor?.dataset['messageId']) {
      prependAnchor.current = {
        id: anchor.dataset['messageId'],
        top: anchor.getBoundingClientRect().top,
      };
      saved.current.following = false;
    }
  };
  useLayoutEffect(() => {
    const anchor = prependAnchor.current;
    const region = scrollRef.current;
    if (!anchor || !region) return;
    const element = region.querySelector<HTMLElement>(
      `[data-message-id="${CSS.escape(anchor.id)}"]`,
    );
    if (element) {
      region.scrollTop += element.getBoundingClientRect().top - anchor.top;
      saved.current.top = region.scrollTop;
      positions.set(key, saved.current);
      // Older history is not new output; the resize observer should not mark it unread.
      lastHeight.current = region.scrollHeight;
      prependAnchor.current = null;
    }
  }, [key, historyStart]);
  return { scrollRef, contentRef, onScroll: remember, away, unread, jump, preserveEarlier };
}
