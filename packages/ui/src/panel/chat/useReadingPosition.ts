import { useLayoutEffect, useRef, useState } from 'react';

// Session-only UI state, scoped to the experiment; no browser storage.
const positions = new Map<string, { top: number; following: boolean }>();
export function useReadingPosition(key: string, ready: boolean, visible: boolean, version: string) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const saved = useRef(positions.get(key) ?? { top: 0, following: true });
  const restored = useRef(false);
  const lastHeight = useRef<number | null>(null);
  const [away, setAway] = useState(!saved.current.following);
  const [unread, setUnread] = useState(false);
  const selectedText = (): boolean => !(window.getSelection()?.isCollapsed ?? true);
  const remember = (): void => {
    const region = scrollRef.current;
    if (!region || !visible || !restored.current) return;
    saved.current = {
      top: region.scrollTop,
      following:
        region.scrollHeight - region.scrollTop - region.clientHeight < 80 && !selectedText(),
    };
    positions.set(key, saved.current);
    setAway(!saved.current.following);
    if (saved.current.following) setUnread(false);
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
  return { scrollRef, contentRef, onScroll: remember, away, unread, jump };
}
