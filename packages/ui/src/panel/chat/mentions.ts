/**
 * `@name` in the composer: finding the one being typed, matching it against
 * the project's references, and taking it back out once it has become a chip.
 *
 * The typed text is only a way to find a reference. What a message carries is
 * the chip -- an id -- so a name typed and left in the text is just text.
 */

/** A mention being typed: where its `@` is, and what follows it so far. */
export interface Mention {
  start: number;
  query: string;
}

/**
 * The mention the caret is at the end of, if any. An `@` counts at the start
 * of the text or after whitespace, so an email address is left alone.
 */
export function mentionAt(text: string, caret: number): Mention | null {
  const before = text.slice(0, caret);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (match === null) return null;
  const query = match[1] ?? '';
  return { start: caret - query.length - 1, query };
}

/** How many matches the menu offers; the rest are one more letter away. */
export const MENTION_LIMIT = 8;

/**
 * References whose name contains the query, ignoring case: names that start
 * with it first, then the rest, each group in its existing order.
 */
export function matchMentions<T extends { name: string }>(list: readonly T[], query: string): T[] {
  const q = query.toLowerCase();
  const starts: T[] = [];
  const contains: T[] = [];
  for (const item of list) {
    const name = item.name.toLowerCase();
    if (name.startsWith(q)) starts.push(item);
    else if (name.includes(q)) contains.push(item);
  }
  return [...starts, ...contains].slice(0, MENTION_LIMIT);
}

/** The text with a mention taken out, and where the caret goes. */
export function withoutMention(
  text: string,
  mention: Mention,
  caret: number,
): { text: string; caret: number } {
  const after = text.slice(caret);
  const before = text.slice(0, mention.start);
  // Do not leave two spaces where the mention sat between words.
  const joined = before.endsWith(' ') && after.startsWith(' ') ? after.slice(1) : after;
  return { text: before + joined, caret: before.length };
}
