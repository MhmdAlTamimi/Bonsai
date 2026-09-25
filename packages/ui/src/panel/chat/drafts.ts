/** In-session only. Project/node/channel ownership survives panel unmounts. */
const drafts = new Map<string, string>();
export const draftKey = (projectId: string, nodeId: string, channel: string): string =>
  JSON.stringify([projectId, nodeId, channel]);
export const readDraft = (key: string, initial = ''): string => drafts.get(key) ?? initial;
export function writeDraft(key: string, value: string): void {
  drafts.set(key, value);
  emit();
}
export function clearSubmittedDraft(key: string, submitted: string): void {
  if (drafts.get(key) === submitted) {
    drafts.set(key, '');
    emit();
  }
}

/**
 * References attached to a draft, by id, in the order they were added. Kept
 * with the text, so switching experiments and back does not lose them.
 */
const attachments = new Map<string, readonly string[]>();
const NONE: readonly string[] = [];
export const readAttachments = (key: string): readonly string[] => attachments.get(key) ?? NONE;
export function writeAttachments(key: string, ids: readonly string[]): void {
  attachments.set(key, ids);
  emit();
}

const listeners = new Set<() => void>();
const pending = new Set<string>();
const emit = (): void => {
  for (const listener of listeners) listener();
};
export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export const isSending = (key: string): boolean => pending.has(key);
export function setSending(key: string, sending: boolean): void {
  if (sending) pending.add(key);
  else pending.delete(key);
  emit();
}
