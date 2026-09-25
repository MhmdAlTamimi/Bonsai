import { REFERENCE_CONTENT_MAX, REFERENCE_NAME_MAX } from '../db/referenceStore.js';
import type { Store } from '../db/store.js';
import { HttpError } from './http.js';

/**
 * A reference name as typed, made usable: trimmed, inner whitespace collapsed,
 * and refused when it could not be found again by `@`.
 */
export function referenceName(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'A reference needs a name.');
  const name = value.replace(/\s+/g, ' ').trim();
  if (name === '') throw new HttpError(400, 'A reference needs a name.');
  if (name.length > REFERENCE_NAME_MAX) {
    throw new HttpError(400, `Keep the name under ${REFERENCE_NAME_MAX} characters.`);
  }
  if (name.startsWith('@'))
    throw new HttpError(400, 'Leave the @ off; it is added when you mention it.');
  return name;
}

export function referenceContent(value: unknown): string {
  if (typeof value !== 'string') throw new HttpError(400, 'A reference needs some content.');
  if (value.trim() === '') throw new HttpError(400, 'A reference needs some content.');
  if (value.length > REFERENCE_CONTENT_MAX) {
    throw new HttpError(
      400,
      `That is too long for a reference (over ${REFERENCE_CONTENT_MAX.toLocaleString()} characters).`,
    );
  }
  return value;
}

/** More than this in one message is a sign something is wrong, not a workflow. */
const MAX_ATTACHED = 20;

/**
 * The references a message carries: known, in this project, each once. Checked
 * when the message is sent, so a wrong id is an error the user sees rather than
 * a reference that silently fails to arrive.
 */
export function attachedReferences(store: Store, projectId: string, value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || !value.every((id) => typeof id === 'string')) {
    throw new HttpError(400, 'referenceIds must be a list of reference ids.');
  }
  const ids = [...new Set(value)];
  if (ids.length > MAX_ATTACHED) {
    throw new HttpError(400, `Attach at most ${MAX_ATTACHED} references to one message.`);
  }
  for (const id of ids) {
    if (store.references.get(id)?.project_id !== projectId) {
      throw new HttpError(400, 'One of the attached references is not in this project any more.');
    }
  }
  return ids;
}
