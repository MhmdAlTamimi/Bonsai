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

/** Something a message carries besides its text: a reference, or another experiment. */
export interface Attachment {
  kind: 'reference' | 'experiment';
  id: string;
}

/**
 * What is attached to a draft, in the order it was added. Kept with the text,
 * so switching experiments and back does not lose it.
 */
const attachments = new Map<string, readonly Attachment[]>();
const NONE: readonly Attachment[] = [];
export const readAttachments = (key: string): readonly Attachment[] => attachments.get(key) ?? NONE;
export function writeAttachments(key: string, items: readonly Attachment[]): void {
  attachments.set(key, items);
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
