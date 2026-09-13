import { useSyncExternalStore } from 'react';
import { draftKey, readDraft, writeDraft, subscribeDrafts, isSending } from './drafts.ts';

export function useDraft(projectId: string, nodeId: string, channel: string, initial = '') {
  const key = draftKey(projectId, nodeId, channel);
  const prompt = useSyncExternalStore(subscribeDrafts, () => readDraft(key, initial));
  const sending = useSyncExternalStore(subscribeDrafts, () => isSending(key));
  return { key, prompt, sending, setPrompt: (value: string) => writeDraft(key, value) };
}
