import { useSyncExternalStore } from 'react';
import {
  draftKey,
  readAttachments,
  readDraft,
  writeAttachments,
  writeDraft,
  subscribeDrafts,
  isSending,
} from './drafts.ts';

export function useDraft(projectId: string, nodeId: string, channel: string, initial = '') {
  const key = draftKey(projectId, nodeId, channel);
  const prompt = useSyncExternalStore(subscribeDrafts, () => readDraft(key, initial));
  const sending = useSyncExternalStore(subscribeDrafts, () => isSending(key));
  const attached = useSyncExternalStore(subscribeDrafts, () => readAttachments(key));
  return {
    key,
    prompt,
    sending,
    attached,
    setPrompt: (value: string) => writeDraft(key, value),
    setAttached: (ids: readonly string[]) => writeAttachments(key, ids),
  };
}
