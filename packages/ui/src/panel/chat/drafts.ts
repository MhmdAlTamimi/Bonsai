/** Per-tab drafts survive reloads without overwriting another tab's unsent message. */
const drafts = new Map<string, string>();
const PREFIX = 'bonsai.draft.v1:';
function restore(key: string): void {
  if (drafts.has(key)) return;
  drafts.set(key, '');
  try {
    const raw = globalThis.sessionStorage.getItem(PREFIX + key);
    if (raw === null) return;
    const saved = JSON.parse(raw) as { text?: unknown; attachments?: unknown };
    if (typeof saved.text === 'string') drafts.set(key, saved.text);
    if (Array.isArray(saved.attachments))
      attachments.set(
        key,
        (saved.attachments as unknown[]).filter(
          (a): a is Attachment =>
            typeof a === 'object' &&
            a !== null &&
            'kind' in a &&
            'id' in a &&
            (a.kind === 'reference' || a.kind === 'experiment') &&
            typeof a.id === 'string',
        ),
      );
  } catch {
    // Unavailable browser storage or an old/corrupt entry: the in-memory draft still works.
  }
}
function persist(key: string): void {
  try {
    const text = drafts.get(key) ?? '';
    const items = attachments.get(key) ?? NONE;
    if (text === '' && items.length === 0) globalThis.sessionStorage.removeItem(PREFIX + key);
    else
      globalThis.sessionStorage.setItem(PREFIX + key, JSON.stringify({ text, attachments: items }));
  } catch {
    // Keep editing usable in private/storage-restricted browsing.
  }
}
export const draftKey = (projectId: string, nodeId: string, channel: string): string =>
  JSON.stringify([projectId, nodeId, channel]);
export const readDraft = (key: string, initial = ''): string => {
  const hadValue = drafts.has(key);
  restore(key);
  if (!hadValue && drafts.get(key) === '' && initial !== '') drafts.set(key, initial);
  return drafts.get(key) ?? initial;
};
export function writeDraft(key: string, value: string): void {
  restore(key);
  drafts.set(key, value);
  persist(key);
  emit();
}
export function clearSubmittedDraft(key: string, submitted: string): void {
  if (drafts.get(key) === submitted) {
    drafts.set(key, '');
    persist(key);
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
export const readAttachments = (
  key: string,
  initial: readonly Attachment[] = NONE,
): readonly Attachment[] => {
  restore(key);
  if (!attachments.has(key) && initial.length > 0) attachments.set(key, initial);
  return attachments.get(key) ?? NONE;
};
export function writeAttachments(key: string, items: readonly Attachment[]): void {
  restore(key);
  attachments.set(key, items);
  persist(key);
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
