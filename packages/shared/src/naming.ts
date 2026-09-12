/**
 * A node's display name, derived from what the user asked for.
 *
 * Creating a child used to require a name AND a description before anything
 * could happen, and phase 2 added two more boxes to the same dialog. Four
 * fields between an idea and a run is how a tool stops being used for small
 * experiments -- which is exactly what it is for.
 *
 * So the description is the only required field and the name comes from it.
 * A name is metadata (D3 exempts display names from immutability), so a
 * derived one that is slightly wrong costs a rename, while a required one
 * costs a decision every single time.
 *
 * Deliberately dumb. It takes the first few words rather than trying to
 * summarise: a heuristic that is obviously mechanical reads as a default the
 * user may edit, whereas one that is nearly-clever reads as a mistake.
 *
 * SHARED because both ends need the same answer. The dialog shows the name as
 * you type and the server fills it in when the request omits one; two copies
 * would eventually disagree, and the user would watch a node arrive on the
 * canvas under a different name from the one they were just shown.
 */

const MAX_WORDS = 6;
const MAX_CHARS = 42;

/** Words that start a request and say nothing about which node it is. */
const LEADING_NOISE = new Set([
  'please',
  'can',
  'could',
  'you',
  'i',
  'want',
  'would',
  'like',
  'to',
  'lets',
  "let's",
  'try',
]);

export function deriveNodeName(description: string, fallback = 'untitled'): string {
  const cleaned = description
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-*>#]+/, '')
    .trim();
  if (cleaned === '') return fallback;

  // A question keeps its question mark: "?" is how a conversation-only node is
  // asked for, and losing it would make the card read as a change.
  const question = cleaned.startsWith('?');
  const body = question ? cleaned.slice(1).trim() : cleaned;

  const words = body.split(' ');
  // Only strip the noise, never everything: "can you" alone should still name
  // the node something rather than falling back.
  let start = 0;
  while (
    start < words.length - 1 &&
    LEADING_NOISE.has(words[start]!.toLowerCase().replace(/[^\w']/g, ''))
  ) {
    start += 1;
  }

  let name = words.slice(start, start + MAX_WORDS).join(' ');
  if (name.length > MAX_CHARS) name = `${name.slice(0, MAX_CHARS).trimEnd()}…`;
  // Trailing punctuation from a truncated sentence reads as an error.
  name = name.replace(/[.,;:]+$/, '').trim();
  if (name === '') return fallback;

  return question ? `? ${name}` : name;
}
