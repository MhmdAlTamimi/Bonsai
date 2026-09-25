/**
 * Commands typed into the composer, the way Claude Code takes them.
 *
 * Only `/compact` for now. Anything else starting with a slash is an ordinary
 * message: sending an unknown command to the harness would spend a model turn
 * on a note that it did not run, which is worse than saying it plainly.
 */

/** `/compact`, and what to keep in focus if the user said. Null for anything else. */
export function compactCommand(text: string): { focus: string | null } | null {
  const match = /^\/compact(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (match === null) return null;
  const focus = (match[1] ?? '').replace(/\s+/g, ' ').trim();
  return { focus: focus === '' ? null : focus };
}
