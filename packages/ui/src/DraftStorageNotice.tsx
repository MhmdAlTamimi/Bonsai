import { useEffect, useSyncExternalStore, type JSX } from 'react';
import { hasUnsavedDrafts, subscribeDrafts } from './panel/chat/drafts.ts';

/** One warning covers experiment and comparison drafts, including hidden panels. */
export function DraftStorageNotice(): JSX.Element | null {
  const unsaved = useSyncExternalStore(subscribeDrafts, hasUnsavedDrafts);
  useEffect(() => {
    if (!unsaved) return;
    const warn = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [unsaved]);
  return unsaved ? (
    <div className="build-notice" role="alert">
      Browser storage is unavailable. Some unsent messages are only in this tab. Copy them before
      reloading or closing it.
    </div>
  ) : null;
}
